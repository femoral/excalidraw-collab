/**
 * Scene diff routes and a cached compute path shared with 409 conflict
 * responses (PLAN.md §5, §7; issue #17).
 *
 *   GET /api/scenes/:slug/diff?from=&to=[&format=text]
 *
 * `from` / `to` reuse {@link resolveVersionRef} (N, head, head~N). Diffs are
 * immutable once both ends exist, so the cache never invalidates entries —
 * only bounds them with LRU eviction.
 */
import {
  diffScenes,
  formatDiff,
  isEmptyDiff,
  type SceneDiff,
  type SceneDocument,
} from "@excalidraw-collab/core";
import type { FastifyInstance } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Database } from "./db.js";
import { DiffCache, diffCacheKey } from "./diff-cache.js";
import { AppError, ErrorCode } from "./errors.js";
import type { FileStore } from "./files.js";
import { emptySceneDocument, resolveVersionRef, versionToDocument } from "./versions.js";

export { DEFAULT_DIFF_CACHE_MAX, DiffCache, diffCacheKey } from "./diff-cache.js";

/**
 * Computes scene diffs with a bounded cache. Shared by the GET /diff route
 * and the 409 conflict body so both paths benefit from the same memoization.
 *
 * `computeCount` increments only on a real `diffScenes` call (cache miss),
 * which lets tests prove a repeat request does not recompute.
 */
export class SceneDiffService {
  readonly cache: DiffCache;
  /** Number of times `diffScenes` ran (cache misses). For tests. */
  computeCount = 0;

  constructor(
    private readonly db: Database,
    private readonly store: FileStore,
    cache?: DiffCache,
  ) {
    this.cache = cache ?? new DiffCache();
  }

  /**
   * Load the scene document at an absolute version number.
   * Version 0 is the empty base (no row). Versions outside 0..head or
   * missing rows throw NOT_FOUND.
   */
  loadDocumentAtVersion(sceneId: string, version: number, head: number): SceneDocument {
    if (!Number.isInteger(version) || version < 0) {
      throw new AppError(ErrorCode.NOT_FOUND, `version not found: ${version}`, 404);
    }
    if (version === 0) {
      return emptySceneDocument();
    }
    if (version > head) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `version not found: ${version} (head is ${head})`,
        404,
      );
    }
    const row = this.db.getVersion(sceneId, version);
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, `version not found: ${version}`, 404);
    }
    // Files are not part of SceneDiff; still rehydrate for a complete
    // SceneDocument shape (diffScenes only reads elements + appState).
    return versionToDocument(this.store, row);
  }

  /**
   * Diff two absolute versions of a scene. Results are cached under
   * `(sceneId, from, to)`. Self-diffs short-circuit to an empty result
   * without loading blobs (still cached).
   */
  diffVersions(sceneId: string, from: number, to: number, head: number): SceneDiff {
    const key = diffCacheKey(sceneId, from, to);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      return hit;
    }

    let diff: SceneDiff;
    if (from === to) {
      // Identity: no blob load, still memoize for the cache-hit path.
      diff = {
        from,
        to,
        summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
        elements: [],
        appState: [],
      };
      // Count as a compute so the first call is distinguishable from a hit;
      // subsequent identical requests must not increment.
      this.computeCount += 1;
    } else {
      const a = this.loadDocumentAtVersion(sceneId, from, head);
      const b = this.loadDocumentAtVersion(sceneId, to, head);
      this.computeCount += 1;
      diff = diffScenes(a, b, { from, to });
    }

    this.cache.set(key, diff);
    return diff;
  }

  /**
   * Diff for a 409 conflict: parentVersion → head.
   *
   * When the declared parent has no row (e.g. force-pushed history with a
   * non-existent parent claim), treat the parent side as empty so the
   * agent still gets a useful "what is on head" explanation rather than a
   * secondary error.
   */
  conflictDiff(sceneId: string, parentVersion: number, head: number): SceneDiff {
    const key = diffCacheKey(sceneId, parentVersion, head);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      return hit;
    }

    let fromDoc: SceneDocument;
    if (parentVersion <= 0) {
      fromDoc = emptySceneDocument();
    } else {
      const row = this.db.getVersion(sceneId, parentVersion);
      fromDoc = row ? versionToDocument(this.store, row) : emptySceneDocument();
    }

    let toDoc: SceneDocument;
    if (head <= 0) {
      toDoc = emptySceneDocument();
    } else {
      const row = this.db.getVersion(sceneId, head);
      if (!row) {
        // Head claims a version with no row — treat as empty rather than
        // failing the conflict response itself.
        toDoc = emptySceneDocument();
      } else {
        toDoc = versionToDocument(this.store, row);
      }
    }

    this.computeCount += 1;
    const diff = diffScenes(fromDoc, toDoc, {
      from: parentVersion,
      to: head,
    });
    this.cache.set(key, diff);
    return diff;
  }
}

function parseFormat(raw: unknown): "json" | "text" {
  if (raw === undefined || raw === null || raw === "") return "json";
  if (typeof raw !== "string") {
    throw new AppError(ErrorCode.VALIDATION, `invalid format: expected "json" or "text"`, 400);
  }
  const v = raw.trim().toLowerCase();
  if (v === "json") return "json";
  if (v === "text") return "text";
  throw new AppError(
    ErrorCode.VALIDATION,
    `invalid format: ${JSON.stringify(raw)} (expected "json" or "text")`,
    400,
  );
}

function requireRef(name: "from" | "to", raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new AppError(ErrorCode.VALIDATION, `query parameter "${name}" is required`, 400);
  }
  return raw;
}

/**
 * Register `GET /api/scenes/:slug/diff` under Bearer auth.
 * Returns the same `SceneDiffService` instance versions routes should use
 * for 409 bodies (pass it into {@link registerVersionRoutes} when both are
 * registered).
 */
export async function registerDiffRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    store: FileStore;
    /** Shared service; created when omitted. */
    diffs?: SceneDiffService;
  },
): Promise<SceneDiffService> {
  const { db, store } = deps;
  const diffs = deps.diffs ?? new SceneDiffService(db, store);
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      // -----------------------------------------------------------------
      // GET /scenes/:slug/diff?from=&to=[&format=text]
      // -----------------------------------------------------------------
      api.get<{
        Params: { slug: string };
        Querystring: { from?: string; to?: string; format?: string };
      }>("/scenes/:slug/diff", async (request, reply) => {
        const { slug } = request.params;
        const scene = db.getSceneBySlug(slug);
        if (!scene) {
          throw new AppError(ErrorCode.NOT_FOUND, `scene not found: ${slug}`, 404);
        }

        const fromRaw = requireRef("from", request.query.from);
        const toRaw = requireRef("to", request.query.to);
        const format = parseFormat(request.query.format);

        const head = scene.head_version;
        const from = resolveVersionRef(fromRaw, head);
        const to = resolveVersionRef(toRaw, head);

        if (!Number.isInteger(from) || from < 0) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `version not found: ${fromRaw} (head is ${head})`,
            404,
          );
        }
        if (!Number.isInteger(to) || to < 0) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `version not found: ${toRaw} (head is ${head})`,
            404,
          );
        }

        // Absolute versions above head (or missing rows inside 1..head)
        // are NOT_FOUND. Version 0 is the empty base and is always valid.
        if (from > head) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `version not found: ${fromRaw} (head is ${head})`,
            404,
          );
        }
        if (to > head) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `version not found: ${toRaw} (head is ${head})`,
            404,
          );
        }
        if (from >= 1 && !db.getVersion(scene.id, from)) {
          throw new AppError(ErrorCode.NOT_FOUND, `version not found: ${from}`, 404);
        }
        if (to >= 1 && !db.getVersion(scene.id, to)) {
          throw new AppError(ErrorCode.NOT_FOUND, `version not found: ${to}`, 404);
        }

        const diff = diffs.diffVersions(scene.id, from, to, head);

        if (format === "text") {
          const text = formatDiff(diff);
          return reply.type("text/plain; charset=utf-8").send(text);
        }

        return diff;
      });
    },
    { prefix: "/api" },
  );

  return diffs;
}

/** Re-export for callers that only need emptiness checks. */
export { isEmptyDiff, formatDiff };
