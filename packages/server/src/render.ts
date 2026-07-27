/**
 * Scene render routes and cached compute path (PLAN.md §7, §9; issue #26).
 *
 *   GET /api/scenes/:slug/render.png[?v=&scale=&dark=]
 *   GET /api/scenes/:slug/render.svg[?v=&scale=&dark=]
 *
 * Versions are immutable, so a render for (sceneId, version, options) is
 * computed at most once and served from disk thereafter. When the render
 * worker is disabled (`RENDER_WORKER=off`), routes return 501 with an
 * actionable message — never hang, never 500.
 *
 * All HTTP handlers share one worker instance; the worker already caps
 * concurrency. Identical in-flight requests coalesce so concurrent cache
 * misses for the same key hit Chromium only once.
 *
 * Dark mode (issue #38): `?dark=` is the sole source of truth for export
 * theme. Do not read the instance default (`meta.instance_theme`) or the
 * host OS prefers-color-scheme — a cached render that changed after a
 * settings flip would be a genuine bug. Thumbnails stay light via the
 * client's fixed THUMBNAIL_EXPORT.darkMode=false.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";
import { IMMUTABLE_CACHE_CONTROL, type FileStore } from "./files.js";
import {
  RenderCache,
  renderCacheEtag,
  type RenderCacheKey,
  type RenderCacheOptions,
  type RenderFormat,
} from "./render-cache.js";
import {
  emptySceneDocument,
  resolveVersionRef,
  versionToDocument,
} from "./versions.js";

/**
 * Minimal worker surface the server needs. Matches
 * `@excalidraw-collab/render`'s `RenderWorker` without forcing a static
 * Playwright import into this module.
 */
export type SceneRenderWorker = {
  render(request: {
    scene: {
      elements: readonly unknown[];
      appState?: Record<string, unknown>;
      files?: Record<string, unknown> | null;
    };
    format: RenderFormat;
    options?: {
      scale?: number;
      background?: boolean;
      darkMode?: boolean;
      padding?: number;
    };
  }): Promise<{
    bytes: Uint8Array;
    mimeType: "image/png" | "image/svg+xml";
    format: RenderFormat;
  }>;
  close(): Promise<void>;
};

export type SceneRenderResult = {
  bytes: Buffer;
  mimeType: "image/png" | "image/svg+xml";
  format: RenderFormat;
  etag: string;
  /** True when the response body came from the on-disk cache. */
  fromCache: boolean;
};

/**
 * Loads scene versions, talks to the render worker, and memoizes results
 * on disk. `renderCount` increments only when the worker is invoked
 * (cache miss / first compute), so tests can prove a second request
 * never touches Chromium.
 */
export class SceneRenderService {
  readonly cache: RenderCache;
  /**
   * Shared worker. `null` means the feature is disabled — callers should
   * not invoke {@link render}; routes map this to 501.
   */
  readonly worker: SceneRenderWorker | null;
  /** Number of times the worker was invoked (cache misses). For tests. */
  renderCount = 0;
  /**
   * In-flight computes keyed by etag/path identity so concurrent misses
   * for the same key share one worker call.
   */
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly db: Database,
    private readonly store: FileStore,
    worker: SceneRenderWorker | null,
    cache?: RenderCache,
    dataDir?: string,
  ) {
    this.worker = worker;
    this.cache =
      cache ??
      new RenderCache(dataDir ?? ".");
  }

  /**
   * Render (or load from cache) a scene version.
   * Throws {@link AppError} NOT_IMPLEMENTED when the worker is off.
   */
  async render(
    sceneId: string,
    version: number,
    format: RenderFormat,
    options: RenderCacheOptions,
    head: number,
  ): Promise<SceneRenderResult> {
    if (this.worker === null) {
      throw renderWorkerDisabledError();
    }

    const key: RenderCacheKey = {
      sceneId,
      version,
      format,
      options,
    };
    const etag = renderCacheEtag(key);
    const mimeType: SceneRenderResult["mimeType"] =
      format === "png" ? "image/png" : "image/svg+xml";

    const cached = this.cache.get(key);
    if (cached) {
      return {
        bytes: cached,
        mimeType,
        format,
        etag,
        fromCache: true,
      };
    }

    const inflightKey = etag;
    let pending = this.inflight.get(inflightKey);
    if (!pending) {
      pending = this.computeAndStore(key, head);
      this.inflight.set(inflightKey, pending);
      // Always clear the slot when settled so a failure can retry.
      pending.finally(() => {
        this.inflight.delete(inflightKey);
      }).catch(() => {
        // swallow — caller awaits `pending` for the real error
      });
    }

    const bytes = await pending;
    return {
      bytes,
      mimeType,
      format,
      etag,
      fromCache: false,
    };
  }

  private async computeAndStore(
    key: RenderCacheKey,
    head: number,
  ): Promise<Buffer> {
    // Double-check disk: another request may have finished between the
    // first get and acquiring the inflight slot.
    const raced = this.cache.get(key);
    if (raced) return raced;

    if (this.worker === null) {
      throw renderWorkerDisabledError();
    }

    const scene = this.loadSceneForRender(key.sceneId, key.version, head);
    this.renderCount += 1;
    let result: {
      bytes: Uint8Array;
      mimeType: "image/png" | "image/svg+xml";
      format: RenderFormat;
    };
    try {
      result = await this.worker.render({
        scene: {
          elements: scene.elements,
          appState: scene.appState as Record<string, unknown> | undefined,
          files: scene.files ?? null,
        },
        format: key.format,
        options: {
          scale: key.options.scale,
          darkMode: key.options.dark,
        },
      });
    } catch (err) {
      // Optional Playwright missing → same 501 family as RENDER_WORKER=off.
      throw mapWorkerRenderError(err);
    }

    const bytes = Buffer.from(result.bytes);
    this.cache.put(key, bytes);
    return bytes;
  }

  /**
   * Load the `.excalidraw` document for a version. Version 0 is the empty
   * base (no row). Versions outside 0..head or missing rows → NOT_FOUND.
   */
  loadSceneForRender(
    sceneId: string,
    version: number,
    head: number,
  ): {
    elements: readonly unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown> | null;
  } {
    if (!Number.isInteger(version) || version < 0) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `version not found: ${version}`,
        404,
      );
    }
    if (version === 0) {
      const empty = emptySceneDocument();
      return {
        elements: empty.elements,
        appState: empty.appState as Record<string, unknown>,
        files: empty.files ?? {},
      };
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
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `version not found: ${version}`,
        404,
      );
    }
    return versionToDocument(this.store, row);
  }
}

/** Why render is unavailable — surfaced in the 501 envelope `details`. */
export type RenderUnavailableReason = "disabled" | "not_installed";

/**
 * Actionable 501 when RENDER_WORKER is off.
 * `details.reason` is `"disabled"` so operators can distinguish from a
 * render-free image that skipped optional Playwright.
 */
export function renderWorkerDisabledError(): AppError {
  return new AppError(
    ErrorCode.NOT_IMPLEMENTED,
    "PNG/SVG rendering is not available: RENDER_WORKER=off. Set RENDER_WORKER=on and ensure Playwright/Chromium are installed (optional dependency of @excalidraw-collab/render) to enable render endpoints.",
    501,
    { reason: "disabled" satisfies RenderUnavailableReason },
  );
}

/**
 * Actionable 501 when Playwright was not installed (optionalDependency
 * skipped). Same status/code as {@link renderWorkerDisabledError}; only
 * `details.reason` differs (`"not_installed"`).
 */
export function renderWorkerNotInstalledError(
  causeMessage?: string,
): AppError {
  const details: {
    reason: RenderUnavailableReason;
    cause?: string;
  } = { reason: "not_installed" };
  if (causeMessage && causeMessage.length > 0) {
    details.cause = causeMessage;
  }
  return new AppError(
    ErrorCode.NOT_IMPLEMENTED,
    "PNG/SVG rendering is not available: Playwright is not installed. This deployment was built without render support (optional dependency skipped — e.g. pnpm install --no-optional). Install optional dependencies or rebuild with Playwright, then set RENDER_WORKER=on.",
    501,
    details,
  );
}

/**
 * Map a worker failure into an HTTP-facing error. `NOT_INSTALLED` becomes
 * 501; other errors rethrow unchanged (AppError) or as INTERNAL.
 */
export function mapWorkerRenderError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (isRenderNotInstalledError(err)) {
    const message = err instanceof Error ? err.message : undefined;
    throw renderWorkerNotInstalledError(message);
  }
  throw err;
}

/** Duck-type RenderError from @excalidraw-collab/render (no static import of Playwright). */
export function isRenderNotInstalledError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "RenderError" && e.code === "NOT_INSTALLED";
}

/** Default scale when `?scale=` is omitted. */
export const DEFAULT_RENDER_SCALE = 1;

/** Hard upper bound on `?scale=` to avoid pathological memory use. */
export const MAX_RENDER_SCALE = 8;

export function parseRenderScale(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_RENDER_SCALE;
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `scale must be a positive number, got ${JSON.stringify(raw)}`,
      400,
    );
  }
  if (n > MAX_RENDER_SCALE) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `scale must be <= ${MAX_RENDER_SCALE}, got ${n}`,
      400,
    );
  }
  return n;
}

export function parseRenderDark(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  }
  throw new AppError(
    ErrorCode.VALIDATION,
    `dark must be a boolean (true/false/1/0), got ${JSON.stringify(raw)}`,
    400,
  );
}

/**
 * Whether `If-None-Match` matches a strong etag (quoted form).
 * Supports comma-separated lists and the `*` wildcard.
 */
export function etagMatches(
  ifNoneMatch: string | string[] | undefined,
  etag: string,
): boolean {
  if (ifNoneMatch === undefined) return false;
  const header = Array.isArray(ifNoneMatch)
    ? ifNoneMatch.join(",")
    : ifNoneMatch;
  const trimmed = header.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;

  const want = normalizeEtag(etag);
  for (const part of trimmed.split(",")) {
    if (normalizeEtag(part) === want) return true;
  }
  return false;
}

function normalizeEtag(raw: string): string {
  let t = raw.trim();
  // Weak validators compare equal to strong for If-None-Match (RFC 9110).
  if (t.startsWith("W/")) t = t.slice(2).trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t;
  }
  return `"${t}"`;
}

function sendRenderReply(
  request: FastifyRequest,
  reply: FastifyReply,
  result: SceneRenderResult,
): FastifyReply {
  // Conditional GET before body work is already done; still honour 304.
  const inm = request.headers["if-none-match"];
  if (etagMatches(inm, result.etag)) {
    return reply
      .status(304)
      .header("ETag", result.etag)
      .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
      .send();
  }

  return reply
    .status(200)
    .header("Content-Type", result.mimeType)
    .header("Content-Length", result.bytes.byteLength)
    .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
    .header("ETag", result.etag)
    .send(result.bytes);
}

/**
 * Register `GET .../render.png` and `.../render.svg` under Bearer auth.
 */
export async function registerRenderRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    store: FileStore;
    /** Shared service; created when omitted. */
    renders?: SceneRenderService;
    /**
     * When `renders` is omitted, build a service with this worker
     * (`null` → 501 path).
     */
    worker?: SceneRenderWorker | null;
    config?: Config;
  },
): Promise<SceneRenderService> {
  const { db, store } = deps;
  const renders =
    deps.renders ??
    new SceneRenderService(
      db,
      store,
      deps.worker ?? null,
      undefined,
      deps.config?.dataDir,
    );
  const authPreHandler = createAuthPreHandler(db);

  const handle = async (
    request: FastifyRequest<{
      Params: { slug: string };
      Querystring: { v?: string; scale?: string; dark?: string };
    }>,
    reply: FastifyReply,
    format: RenderFormat,
  ): Promise<FastifyReply> => {
    // Fail fast when disabled — never hang waiting for a missing worker.
    if (renders.worker === null) {
      throw renderWorkerDisabledError();
    }

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

    if (!Number.isInteger(resolved) || resolved < 0) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `version not found: ${request.query.v ?? "head"} (head is ${head})`,
        404,
      );
    }
    if (resolved > head) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `version not found: ${request.query.v ?? "head"} (head is ${head})`,
        404,
      );
    }
    if (resolved >= 1 && !db.getVersion(scene.id, resolved)) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `version not found: ${resolved}`,
        404,
      );
    }

    const scale = parseRenderScale(request.query.scale);
    const dark = parseRenderDark(request.query.dark);

    // Cheap conditional path: if the cache already has the entry, we can
    // answer 304 without reading the full body when If-None-Match matches.
    const key: RenderCacheKey = {
      sceneId: scene.id,
      version: resolved,
      format,
      options: { scale, dark },
    };
    const etag = renderCacheEtag(key);
    const inm = request.headers["if-none-match"];
    if (etagMatches(inm, etag) && renders.cache.has(key)) {
      return reply
        .status(304)
        .header("ETag", etag)
        .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
        .send();
    }

    const result = await renders.render(
      scene.id,
      resolved,
      format,
      { scale, dark },
      head,
    );
    return sendRenderReply(request, reply, result);
  };

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      api.get<{
        Params: { slug: string };
        Querystring: { v?: string; scale?: string; dark?: string };
      }>("/scenes/:slug/render.png", async (request, reply) => {
        return handle(request, reply, "png");
      });

      api.get<{
        Params: { slug: string };
        Querystring: { v?: string; scale?: string; dark?: string };
      }>("/scenes/:slug/render.svg", async (request, reply) => {
        return handle(request, reply, "svg");
      });
    },
    { prefix: "/api" },
  );

  return renders;
}
