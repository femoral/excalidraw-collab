/**
 * Version push/pull routes — the core of the turn model.
 *
 *   GET  /api/scenes/:slug/scene[?v=]
 *   POST /api/scenes/:slug/scene[?force=true][&merge=true]
 *   GET  /api/scenes/:slug/versions
 *
 * Optimistic concurrency: a push declares `parentVersion`. When it equals
 * head the push becomes head+1 in one SQLite transaction; otherwise 409.
 * With `?merge=true` on a stale parent the server runs upstream
 * `reconcileElements` in the render worker and commits the result.
 * `author` is always taken from the bearer token identity.
 */
import {
  diffScenes,
  normalizeScene,
  sceneHash,
  SceneValidationError,
  type BinaryFileData,
  type BinaryFiles,
  type SceneDiff,
  type SceneDocument,
} from "@excalidraw-collab/core";
import type { FastifyInstance } from "fastify";
import { authorFromIdentity, createAuthPreHandler } from "./auth.js";
import {
  gunzipJson,
  gzipJson,
  type Database,
  type VersionRow,
} from "./db.js";
import type { SceneDiffService } from "./diff.js";
import type { SceneEventHub } from "./events.js";
import { AppError, ErrorCode } from "./errors.js";
import type { LockExpiryScheduler } from "./lock-expiry.js";
import { toLock } from "./scenes.js";
import {
  decodeDataURL,
  FILE_ID_HEX_RE,
  type FileStore,
} from "./files.js";
import {
  collectReferencedFileIds,
  formatMergeCommitMessage,
  MERGE_WORKER_DISABLED_MESSAGE,
  MERGE_WORKER_NOT_INSTALLED_MESSAGE,
  parseMergeQuery,
  prepareLocalElementsForMerge,
  type MergePushExtras,
  type SceneMergeService,
} from "./merge.js";

/** Duck-type RenderError NOT_INSTALLED without importing render.ts (cycle). */
function isRenderNotInstalledError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "RenderError" && e.code === "NOT_INSTALLED";
}

/** Default page size for version history. */
export const VERSIONS_DEFAULT_LIMIT = 50;

/** Hard cap on `limit` for version history. */
export const VERSIONS_MAX_LIMIT = 200;

/** Wire shape for one history row (no blobs). */
export type VersionInfo = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  /** Content-addressed thumbnail file id, if the client uploaded one. */
  thumbnailFileId: string | null;
};

/** 201 body after a successful push. */
export type PushVersionResponse = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  headVersion: number;
  /** Present when the push ran a server-side merge. */
  merged?: boolean;
  mergeParents?: { local: number; remote: number };
  /** Diff of remote head → merge result (what the merge decided). */
  diff?: SceneDiff;
  /** Content-addressed thumbnail file id stored with this version, if any. */
  thumbnailFileId: string | null;
};

/**
 * Conflict details attached to a 409 envelope (PLAN.md §5).
 * Carries the structured diff from `parentVersion` → `head` so an agent
 * that is rejected knows what it missed in one round trip — no follow-up
 * GET /diff required (and no temptation to retry with --force blindly).
 */
export type ConflictDetails = {
  code: "conflict";
  head: number;
  parentVersion: number;
  /** Structured element/appState changes between parentVersion and head. */
  diff: SceneDiff;
};

/** Canonical empty `.excalidraw` document (head_version === 0). */
export function emptySceneDocument(): SceneDocument & {
  type: "excalidraw";
  version: number;
} {
  return {
    type: "excalidraw",
    version: 2,
    elements: [],
    appState: {},
    files: {},
  };
}

/**
 * Resolve a version ref against the scene's current head.
 *
 * Accepts:
 *   - `undefined` / `""` / `"head"` → head
 *   - `"head~N"` (N ≥ 0 integer) → head − N
 *   - absolute positive integer string / number → that version
 *
 * Throws {@link AppError} VALIDATION on malformed refs. Does not check
 * range — callers map out-of-range to 404.
 */
export function resolveVersionRef(
  ref: string | number | undefined,
  head: number,
): number {
  if (ref === undefined || ref === "") {
    return head;
  }
  if (typeof ref === "number") {
    if (!Number.isInteger(ref) || ref < 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `invalid version ref: ${JSON.stringify(ref)}`,
        400,
      );
    }
    return ref;
  }

  const trimmed = String(ref).trim();
  if (trimmed === "" || trimmed === "head") {
    return head;
  }

  const relative = /^head~(\d+)$/.exec(trimmed);
  if (relative) {
    return head - Number(relative[1]);
  }

  // Absolute: plain non-negative integer (no leading +/sign, no decimals).
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  throw new AppError(
    ErrorCode.VALIDATION,
    `invalid version ref: ${JSON.stringify(ref)} (expected head, head~N, or a non-negative integer)`,
    400,
  );
}

export function toVersionInfo(row: VersionRow): VersionInfo {
  return {
    version: row.version,
    parentVersion: row.parent_version,
    author: row.author,
    message: row.message,
    createdAt: row.created_at,
    elementCount: row.element_count,
    sceneHash: row.scene_hash,
    thumbnailFileId: row.thumbnail_file_id ?? null,
  };
}

export function toPushResponse(row: VersionRow): PushVersionResponse {
  return {
    version: row.version,
    parentVersion: row.parent_version,
    author: row.author,
    message: row.message,
    createdAt: row.created_at,
    elementCount: row.element_count,
    sceneHash: row.scene_hash,
    headVersion: row.version,
    thumbnailFileId: row.thumbnail_file_id ?? null,
  };
}

/**
 * Validate an optional client-supplied thumbnail file id.
 * Empty / missing → null (no thumbnail). Non-hex or missing blob → 400.
 * The id must already exist in the content-addressed store (upload first).
 */
export function resolveThumbnailFileId(
  raw: unknown,
  store: FileStore,
): string | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "string" || !FILE_ID_HEX_RE.test(raw)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      "thumbnailFileId must be a 40-char lowercase SHA-1 hex digest",
      400,
    );
  }
  if (!store.exists(raw)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `thumbnailFileId not found in file store: ${raw} (upload the PNG via POST /api/files first)`,
      400,
    );
  }
  return raw;
}

/**
 * Persist each BinaryFileData entry into the content-addressed store.
 * Verifies claimed fileId === SHA-1(bytes) (FileStore.put).
 * Returns the ordered list of stored file ids.
 */
export function storeSceneFiles(
  store: FileStore,
  files: BinaryFiles,
): string[] {
  const ids: string[] = [];
  for (const [claimedId, entry] of Object.entries(files)) {
    if (entry == null || typeof entry !== "object") continue;
    const data = entry as BinaryFileData;
    if (typeof data.dataURL !== "string") {
      throw new AppError(
        ErrorCode.VALIDATION,
        `files["${claimedId}"].dataURL is required`,
        400,
      );
    }
    const decoded = decodeDataURL(data.dataURL);
    const mimeType =
      typeof data.mimeType === "string" && data.mimeType.length > 0
        ? data.mimeType
        : decoded.mimeType;
    const result = store.put({
      bytes: decoded.bytes,
      mimeType,
      created:
        typeof data.created === "number" && Number.isFinite(data.created)
          ? data.created
          : undefined,
      claimedFileId: claimedId,
    });
    ids.push(result.fileId);
  }
  return ids;
}

/**
 * Rehydrate a files map from the content-addressed store for a version's
 * `file_ids` JSON list. Missing blobs are skipped (no crash).
 */
export function rehydrateSceneFiles(
  store: FileStore,
  fileIdsJson: string,
): BinaryFiles {
  let ids: unknown;
  try {
    ids = JSON.parse(fileIdsJson);
  } catch {
    return {};
  }
  if (!Array.isArray(ids)) return {};

  const files: BinaryFiles = {};
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) continue;
    const stored = store.get(id);
    if (!stored) continue;
    const dataURL =
      `data:${stored.mimeType};base64,${stored.bytes.toString("base64")}` as BinaryFileData["dataURL"];
    files[id] = {
      id: id as BinaryFileData["id"],
      mimeType: stored.mimeType as BinaryFileData["mimeType"],
      dataURL,
      created: stored.created,
    };
  }
  return files;
}

/** Build a full `.excalidraw` document from a stored version row. */
export function versionToDocument(
  store: FileStore,
  row: VersionRow,
): SceneDocument & { type: "excalidraw"; version: number } {
  const elements = gunzipJson<SceneDocument["elements"]>(row.elements);
  const appState = gunzipJson<SceneDocument["appState"]>(row.app_state);
  const files = rehydrateSceneFiles(store, row.file_ids);
  return {
    type: "excalidraw",
    version: 2,
    elements,
    appState,
    files,
  };
}

function parseForceQuery(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return false;
}

function parseLimitOffset(query: {
  limit?: string | number;
  offset?: string | number;
}): { limit: number; offset: number } {
  let limit = VERSIONS_DEFAULT_LIMIT;
  let offset = 0;

  if (query.limit !== undefined && query.limit !== "") {
    const n =
      typeof query.limit === "number" ? query.limit : Number(query.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new AppError(
        ErrorCode.VALIDATION,
        "limit must be a positive integer",
        400,
      );
    }
    limit = Math.min(n, VERSIONS_MAX_LIMIT);
  }

  if (query.offset !== undefined && query.offset !== "") {
    const n =
      typeof query.offset === "number" ? query.offset : Number(query.offset);
    if (!Number.isInteger(n) || n < 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        "offset must be a non-negative integer",
        400,
      );
    }
    offset = n;
  }

  return { limit, offset };
}

type PushBody = {
  parentVersion: number;
  elements: unknown;
  appState?: unknown;
  files?: unknown;
  message: string;
  /**
   * Optional content-addressed PNG already uploaded via POST /api/files.
   * Stored on the version for scene-list previews (no render worker).
   */
  thumbnailFileId?: unknown;
  /** Ignored if present — author is always the token identity. */
  author?: unknown;
};

const pushBodySchema = {
  type: "object",
  required: ["parentVersion", "elements", "message"],
  properties: {
    parentVersion: { type: "integer", minimum: 0 },
    elements: { type: "array" },
    appState: { type: "object" },
    files: { type: "object" },
    message: { type: "string" },
    thumbnailFileId: { type: ["string", "null"] },
    // Accepted so clients may echo a local draft author, but never honoured.
    author: {},
  },
  // Allow extra keys so a client-supplied author (or other draft fields)
  // cannot break the request; only the listed fields are read.
  additionalProperties: true,
} as const;

/**
 * Register scene version routes under `/api` with Bearer auth.
 *
 * When `diffs` is provided, 409 conflict responses include the structured
 * parent→head diff from that service (shared cache with GET /diff).
 * When `events` is provided, successful commits notify long-poll waiters.
 * When `merge` is provided, `?merge=true` on a stale parent runs upstream
 * reconcileElements via that service; without it, merge fails with 501.
 */
export async function registerVersionRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    store: FileStore;
    /** Shared with GET /diff so conflict diffs hit the same cache. */
    diffs?: SceneDiffService;
    /** Notified after a successful commit (long-poll `GET /events`). */
    events?: SceneEventHub;
    /**
     * Server-side merge (render worker). When absent, `?merge=true` on a
     * stale parent returns 501 — never a hand-rolled fallback.
     */
    merge?: SceneMergeService | null;
    /**
     * When the commit auto-releases the holder's lock, disarm the TTL
     * expiry timer so we do not publish a second free-lock event later.
     */
    lockExpiry?: LockExpiryScheduler;
  },
): Promise<void> {
  const { db, store, diffs, events, lockExpiry } = deps;
  const mergeService = deps.merge ?? null;
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      // -----------------------------------------------------------------
      // GET /scenes/:slug/scene[?v=]
      // -----------------------------------------------------------------
      api.get<{
        Params: { slug: string };
        Querystring: { v?: string };
      }>("/scenes/:slug/scene", async (request) => {
        const { slug } = request.params;
        const scene = db.getSceneBySlug(slug);
        if (!scene) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `scene not found: ${slug}`,
            404,
          );
        }

        const head = scene.head_version;
        const resolved = resolveVersionRef(request.query.v, head);

        if (head === 0 && (request.query.v === undefined || request.query.v === "" || request.query.v === "head")) {
          return emptySceneDocument();
        }

        if (!Number.isInteger(resolved) || resolved < 1 || resolved > head) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `version not found: ${request.query.v ?? "head"} (head is ${head})`,
            404,
          );
        }

        const row = db.getVersion(scene.id, resolved);
        if (!row) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `version not found: ${resolved}`,
            404,
          );
        }

        return versionToDocument(store, row);
      });

      // -----------------------------------------------------------------
      // POST /scenes/:slug/scene[?force=true][&merge=true]
      // -----------------------------------------------------------------
      api.post<{
        Params: { slug: string };
        Querystring: { force?: string; merge?: string };
        Body: PushBody;
      }>(
        "/scenes/:slug/scene",
        {
          schema: {
            body: pushBodySchema,
          },
        },
        async (request, reply) => {
          const { slug } = request.params;
          const scene = db.getSceneBySlug(slug);
          if (!scene) {
            throw new AppError(
              ErrorCode.NOT_FOUND,
              `scene not found: ${slug}`,
              404,
            );
          }

          const identity = request.auth;
          if (!identity) {
            throw new AppError(
              ErrorCode.UNAUTHORIZED,
              "authentication required",
              401,
            );
          }

          const message =
            typeof request.body.message === "string"
              ? request.body.message.trim()
              : "";
          if (message.length === 0) {
            throw new AppError(
              ErrorCode.VALIDATION,
              "message is required and must not be empty",
              400,
            );
          }

          const parentVersion = request.body.parentVersion;
          if (
            typeof parentVersion !== "number" ||
            !Number.isInteger(parentVersion) ||
            parentVersion < 0
          ) {
            throw new AppError(
              ErrorCode.VALIDATION,
              "parentVersion must be a non-negative integer",
              400,
            );
          }

          const force = parseForceQuery(request.query.force);
          const wantMerge = parseMergeQuery(request.query.merge);

          if (force && wantMerge) {
            throw new AppError(
              ErrorCode.VALIDATION,
              "force and merge are mutually exclusive — choose one resolution strategy",
              400,
            );
          }

          // Normalize before store — never hand-author element internals.
          let doc: SceneDocument;
          try {
            doc = normalizeScene({
              elements: request.body.elements,
              appState: request.body.appState,
              files: request.body.files,
            });
          } catch (err) {
            if (err instanceof SceneValidationError) {
              throw new AppError(
                ErrorCode.VALIDATION,
                err.message,
                400,
                { problems: err.problems },
              );
            }
            throw err;
          }

          // Author from token only — body.author is structurally ignored.
          const author = authorFromIdentity(identity);
          const head = scene.head_version;

          // ------------------------------------------------------------------
          // Merge path: stale parent + ?merge=true → reconcile in render worker
          // ------------------------------------------------------------------
          if (wantMerge && parentVersion !== head) {
            if (!mergeService) {
              throw new AppError(
                ErrorCode.NOT_IMPLEMENTED,
                MERGE_WORKER_DISABLED_MESSAGE,
                501,
                { reason: "disabled" },
              );
            }

            if (head < 1) {
              // No remote content to merge with — treat as a normal first push
              // would, but parent is stale against an empty head (impossible
              // if parent > 0 and head is 0). Fall through to normal conflict.
              throw new AppError(
                ErrorCode.CONFLICT,
                `parentVersion ${parentVersion} does not match head ${head}`,
                409,
                {
                  code: "conflict",
                  head,
                  parentVersion,
                  diff: {
                    from: parentVersion,
                    to: head,
                    summary: {
                      added: 0,
                      deleted: 0,
                      updated: 0,
                      reordered: 0,
                    },
                    elements: [],
                    appState: [],
                  },
                } satisfies ConflictDetails,
              );
            }

            const remoteRow = db.getVersion(scene.id, head);
            if (!remoteRow) {
              throw new AppError(
                ErrorCode.INTERNAL,
                `head version ${head} missing for scene ${slug}`,
                500,
              );
            }
            const remoteDoc = versionToDocument(store, remoteRow);

            // Parent the client pulled — used to detect hand-edits that left
            // version/versionNonce stale (agents edit JSON without bumping).
            // Empty parent (parentVersion 0) means no prior elements.
            let parentElements: SceneDocument["elements"] = [];
            if (parentVersion > 0) {
              const parentRow = db.getVersion(scene.id, parentVersion);
              if (!parentRow) {
                throw new AppError(
                  ErrorCode.VALIDATION,
                  `parentVersion ${parentVersion} not found for scene ${slug}`,
                  400,
                );
              }
              parentElements = versionToDocument(store, parentRow).elements;
            }

            // Bump version/versionNonce on elements the client actually
            // changed vs parent so reconcileElements sees honest input.
            // Does not invent a conflict rule — only fixes dishonest fields.
            const localForMerge = prepareLocalElementsForMerge(
              doc.elements,
              parentElements,
            );

            let mergedElements: unknown[];
            try {
              const merged = await mergeService.merge({
                localElements: localForMerge,
                remoteElements: remoteDoc.elements,
                // Empty appState → pure version/versionNonce rules (no
                // "currently editing" local bias from a browser session).
                appState: {},
              });
              mergedElements = merged.elements;
            } catch (err) {
              if (err instanceof AppError) throw err;
              if (isRenderNotInstalledError(err)) {
                const cause = err instanceof Error ? err.message : undefined;
                throw new AppError(
                  ErrorCode.NOT_IMPLEMENTED,
                  MERGE_WORKER_NOT_INSTALLED_MESSAGE,
                  501,
                  {
                    reason: "not_installed",
                    ...(cause ? { cause } : {}),
                  },
                );
              }
              const msg =
                err instanceof Error ? err.message : "merge failed in render worker";
              throw new AppError(
                ErrorCode.INTERNAL,
                `server-side merge failed: ${msg}`,
                500,
              );
            }

            // Re-normalize the merged scene (appState stays local/"mine").
            let mergedDoc: SceneDocument;
            try {
              mergedDoc = normalizeScene({
                elements: mergedElements,
                appState: doc.appState,
                files: {
                  ...remoteDoc.files,
                  ...doc.files,
                },
              });
            } catch (err) {
              if (err instanceof SceneValidationError) {
                throw new AppError(
                  ErrorCode.VALIDATION,
                  `merged scene failed validation: ${err.message}`,
                  400,
                  { problems: err.problems },
                );
              }
              throw err;
            }

            // Store any new client files; remote files already content-addressed.
            storeSceneFiles(store, doc.files);
            const fileIds = collectReferencedFileIds(mergedDoc.elements);

            const commitMessage = formatMergeCommitMessage(
              message,
              parentVersion,
              head,
            );
            const elementsBlob = gzipJson(mergedDoc.elements);
            const appStateBlob = gzipJson(mergedDoc.appState);
            const elementCount = mergedDoc.elements.length;
            const hash = String(sceneHash(mergedDoc.elements));

            // force: true so commit accepts the stale parent; parent_version
            // column still records the client's declared parent.
            const result = db.commitVersion({
              sceneId: scene.id,
              parentVersion,
              force: true,
              author,
              message: commitMessage,
              elements: elementsBlob,
              app_state: appStateBlob,
              file_ids: fileIds,
              element_count: elementCount,
              scene_hash: hash,
            });

            if (!result.ok) {
              if (result.reason === "not_found") {
                throw new AppError(
                  ErrorCode.NOT_FOUND,
                  `scene not found: ${slug}`,
                  404,
                );
              }
              // Race: head moved again between read and commit.
              throw new AppError(
                ErrorCode.CONFLICT,
                `merge raced with another commit (head is now ${result.head}); retry`,
                409,
                {
                  code: "conflict",
                  head: result.head,
                  parentVersion: result.parentVersion,
                  diff: diffs
                    ? diffs.conflictDiff(
                        scene.id,
                        result.parentVersion,
                        result.head,
                      )
                    : {
                        from: result.parentVersion,
                        to: result.head,
                        summary: {
                          added: 0,
                          deleted: 0,
                          updated: 0,
                          reordered: 0,
                        },
                        elements: [],
                        appState: [],
                      },
                } satisfies ConflictDetails,
              );
            }

            // What the merge decided: remote head → committed merge result.
            const mergeDiff = diffScenes(
              {
                elements: remoteDoc.elements as SceneDocument["elements"],
                appState: remoteDoc.appState,
                files: remoteDoc.files ?? {},
              },
              {
                elements: mergedDoc.elements,
                appState: mergedDoc.appState,
                files: mergedDoc.files ?? {},
              },
              { from: head, to: result.version.version },
            );

            const locked = db.getSceneById(scene.id);
            events?.publishVersion({
              sceneId: scene.id,
              slug: scene.slug,
              headVersion: result.version.version,
              version: toVersionInfo(result.version),
              lock: locked ? toLock(locked) : null,
            });
            // Holder auto-release inside commitVersion may have freed the lock.
            lockExpiry?.disarmIfFree(scene.id);

            const body: PushVersionResponse & MergePushExtras = {
              ...toPushResponse(result.version),
              merged: true,
              mergeParents: { local: parentVersion, remote: head },
              diff: mergeDiff,
            };
            return reply.status(201).send(body);
          }

          // ------------------------------------------------------------------
          // Normal / force path (merge=true with matching parent falls here)
          // ------------------------------------------------------------------

          // Content-addressed file store (SHA-1 verify each claimed id).
          const fileIds = storeSceneFiles(store, doc.files);

          // Optional client-rendered thumbnail (browser exportToBlob → /files).
          // Must already be in the store; never invented server-side.
          const thumbnailFileId = resolveThumbnailFileId(
            request.body.thumbnailFileId,
            store,
          );

          const elementsBlob = gzipJson(doc.elements);
          const appStateBlob = gzipJson(doc.appState);
          const elementCount = doc.elements.length;
          const hash = String(sceneHash(doc.elements));

          const result = db.commitVersion({
            sceneId: scene.id,
            parentVersion,
            force,
            author,
            message,
            elements: elementsBlob,
            app_state: appStateBlob,
            file_ids: fileIds,
            element_count: elementCount,
            scene_hash: hash,
            thumbnail_file_id: thumbnailFileId,
          });

          if (!result.ok) {
            if (result.reason === "not_found") {
              throw new AppError(
                ErrorCode.NOT_FOUND,
                `scene not found: ${slug}`,
                404,
              );
            }
            // One-round-trip conflict: include what the agent missed so it
            // does not have to call GET /diff (or, worse, --force) next.
            const conflictDiff = diffs
              ? diffs.conflictDiff(
                  scene.id,
                  result.parentVersion,
                  result.head,
                )
              : {
                  from: result.parentVersion,
                  to: result.head,
                  summary: {
                    added: 0,
                    deleted: 0,
                    updated: 0,
                    reordered: 0,
                  },
                  elements: [],
                  appState: [],
                };
            const details: ConflictDetails = {
              code: "conflict",
              head: result.head,
              parentVersion: result.parentVersion,
              diff: conflictDiff,
            };
            throw new AppError(
              ErrorCode.CONFLICT,
              `parentVersion ${result.parentVersion} does not match head ${result.head}`,
              409,
              details,
            );
          }

          // Wake long-poll waiters without a DB poll loop.
          const locked = db.getSceneById(scene.id);
          events?.publishVersion({
            sceneId: scene.id,
            slug: scene.slug,
            headVersion: result.version.version,
            version: toVersionInfo(result.version),
            lock: locked ? toLock(locked) : null,
          });
          // Holder auto-release inside commitVersion may have freed the lock.
          lockExpiry?.disarmIfFree(scene.id);

          return reply.status(201).send(toPushResponse(result.version));
        },
      );

      // -----------------------------------------------------------------
      // GET /scenes/:slug/versions
      // -----------------------------------------------------------------
      api.get<{
        Params: { slug: string };
        Querystring: { limit?: string; offset?: string };
      }>("/scenes/:slug/versions", async (request) => {
        const { slug } = request.params;
        const scene = db.getSceneBySlug(slug);
        if (!scene) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `scene not found: ${slug}`,
            404,
          );
        }

        const { limit, offset } = parseLimitOffset(request.query);
        const page = db.listVersionsPage(scene.id, {
          limit,
          offset,
          order: "desc",
        });

        return {
          versions: page.versions.map(toVersionInfo),
          total: page.total,
          limit,
          offset,
          headVersion: scene.head_version,
        };
      });
    },
    { prefix: "/api" },
  );
}
