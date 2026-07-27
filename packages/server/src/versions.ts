/**
 * Version push/pull routes — the core of the turn model.
 *
 *   GET  /api/scenes/:slug/scene[?v=]
 *   POST /api/scenes/:slug/scene[?force=true]
 *   GET  /api/scenes/:slug/versions
 *
 * Optimistic concurrency: a push declares `parentVersion`. When it equals
 * head the push becomes head+1 in one SQLite transaction; otherwise 409.
 * `author` is always taken from the bearer token identity.
 */
import {
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
import { AppError, ErrorCode } from "./errors.js";
import {
  decodeDataURL,
  type FileStore,
} from "./files.js";

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
  };
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
 */
export async function registerVersionRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    store: FileStore;
    /** Shared with GET /diff so conflict diffs hit the same cache. */
    diffs?: SceneDiffService;
  },
): Promise<void> {
  const { db, store, diffs } = deps;
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
      // POST /scenes/:slug/scene[?force=true]
      // -----------------------------------------------------------------
      api.post<{
        Params: { slug: string };
        Querystring: { force?: string };
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

          // Content-addressed file store (SHA-1 verify each claimed id).
          const fileIds = storeSceneFiles(store, doc.files);

          const elementsBlob = gzipJson(doc.elements);
          const appStateBlob = gzipJson(doc.appState);
          const elementCount = doc.elements.length;
          const hash = String(sceneHash(doc.elements));

          // Author from token only — body.author is structurally ignored.
          const author = authorFromIdentity(identity);
          const force = parseForceQuery(request.query.force);

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
