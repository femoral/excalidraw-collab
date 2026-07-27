import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifyStatic from "@fastify/static";
import { registerWhoamiRoute, seedBootstrapToken } from "./auth.js";
import { registerBackupRoutes } from "./backup.js";
import { type Config, loadConfig } from "./config.js";
import type { Database } from "./db.js";
import {
  AppError,
  ErrorCode,
  errorEnvelope,
  type ErrorEnvelope,
} from "./errors.js";
import { registerDiffRoutes, SceneDiffService } from "./diff.js";
import { registerDraftRoutes } from "./drafts.js";
import {
  EVENTS_TIMEOUT_MS,
  registerEventRoutes,
  SceneEventHub,
} from "./events.js";
import { FileStore, registerFileRoutes } from "./files.js";
import { registerLockRoutes } from "./locks.js";
import type { SceneMergeService } from "./merge.js";
import {
  registerRenderRoutes,
  SceneRenderService,
  type SceneRenderWorker,
} from "./render.js";
import { RenderCache } from "./render-cache.js";
import { registerSceneRoutes } from "./scenes.js";
import {
  registerSkeletonRoutes,
  type SkeletonConverter,
  type SkeletonConverterHolder,
} from "./skeleton.js";
import { registerTokenRoutes } from "./tokens.js";
import { registerVersionRoutes } from "./versions.js";

/** Injectable readiness probe; issue #5 will plug SQLite reachability here. */
export type ReadinessCheck = () => boolean | Promise<boolean>;

export type BuildAppDeps = {
  /** Pre-loaded config. Defaults to `loadConfig()` from `process.env`. */
  config?: Config;
  /**
   * Called by `GET /readyz`. Defaults to always-ready; later the SQLite layer
   * supplies a real check without reshaping the route.
   */
  readinessCheck?: ReadinessCheck;
  /** Extra Fastify options (tests typically pass `{ logger: false }`). */
  fastifyOpts?: FastifyServerOptions;
  /**
   * Open database handle. When provided, bootstrap runs and `/api/tokens`
   * is registered. Health probes work without it (unit tests of the shell).
   */
  db?: Database;
  /**
   * Content-addressed file store. When omitted and `db` is set, a store is
   * created under `config.dataDir`. Inject in tests to share a temp DATA_DIR.
   */
  fileStore?: FileStore;
  /**
   * Shared scene-diff service (GET /diff + 409 conflict bodies). When
   * omitted and `db` + file store are set, a default service is created.
   * Inject in tests to observe `computeCount` / a small cache bound.
   */
  diffs?: SceneDiffService;
  /**
   * In-process scene event hub for long-poll `GET /events`. When omitted
   * and `db` is set, a default hub is created. Inject in tests.
   */
  events?: SceneEventHub;
  /**
   * Long-poll timeout for `GET /events` (ms). Defaults to
   * {@link EVENTS_TIMEOUT_MS} (30 s). Shorten in tests.
   */
  eventsTimeoutMs?: number;
  /**
   * Skeleton → full-elements converter (render worker). When omitted or null,
   * `POST /api/skeleton/convert` returns 501 with a clear message.
   * Pass a {@link SkeletonConverterHolder} to late-bind after listen.
   * Inject a mock in tests; production wires Playwright via main.ts.
   */
  skeletonConverter?: SkeletonConverter | SkeletonConverterHolder | null;
  /**
   * Shared PNG/SVG render worker. When omitted:
   *   - `config.renderWorker === "on"` → opened via `@excalidraw-collab/render`
   *     (`openRenderWorker`, never loads Playwright when env is off)
   *   - otherwise → `null` (routes return 501)
   * Pass an explicit `null` or a mock in tests.
   */
  renderWorker?: SceneRenderWorker | null;
  /**
   * Shared scene-render service (GET render.png/svg). When omitted and
   * db + file store are set, a default service is created.
   */
  renders?: SceneRenderService;
  /**
   * Base URL of the web app that serves `/render` (for the Playwright
   * worker). Defaults to `http://127.0.0.1:<config.port>` when the
   * server also hosts static assets.
   */
  renderBaseUrl?: string;
  /**
   * Server-side merge (render worker adapter). When omitted, `?merge=true`
   * on a stale parent returns 501. Inject a mock in tests.
   */
  merge?: SceneMergeService | null;
};

function isFastifyError(err: unknown): err is FastifyError {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as FastifyError).statusCode === "number"
  );
}

function validationDetails(err: FastifyError): unknown {
  if (Array.isArray(err.validation)) {
    return err.validation;
  }
  return undefined;
}

/**
 * Build a fully-wired Fastify instance without listening.
 * Tests drive it via `app.inject()`; `main.ts` calls `listen`.
 */
export async function buildApp(
  deps: BuildAppDeps = {},
): Promise<FastifyInstance> {
  const config = deps.config ?? loadConfig();
  const readinessCheck: ReadinessCheck =
    deps.readinessCheck ?? (() => true);

  // Global body limit must cover JSON BinaryFileData uploads (base64 bloat).
  // Per-route limits on /api/files refine this further.
  const bodyLimit = Math.ceil(config.maxFileBytes * 1.4) + 4096;

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit,
    ...deps.fastifyOpts,
  });

  // Stash config for plugins/routes that need it later without closing over a
  // different object. Later issues can decorate more services here.
  app.decorate("config", config);
  if (deps.db) {
    app.decorate("db", deps.db);
  }

  const fileStore =
    deps.fileStore ??
    (deps.db
      ? new FileStore(config.dataDir, config.maxFileBytes)
      : undefined);
  if (fileStore) {
    app.decorate("fileStore", fileStore);
  }

  registerErrorHandlers(app, config);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    let ready: boolean;
    try {
      ready = await readinessCheck();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "readiness check failed";
      return reply
        .status(503)
        .send(errorEnvelope(ErrorCode.NOT_READY, message));
    }
    if (!ready) {
      return reply
        .status(503)
        .send(errorEnvelope(ErrorCode.NOT_READY, "not ready"));
    }
    return { status: "ready" };
  });

  if (deps.db) {
    // First-boot admin seed (no-op when already bootstrapped or token empty).
    seedBootstrapToken(deps.db, config.bootstrapToken);
    await registerWhoamiRoute(app, deps.db);
    await registerTokenRoutes(app, deps.db);
    await registerSceneRoutes(app, deps.db);
    await registerDraftRoutes(app, { db: deps.db });

    // Long-poll hub: shared by version commits, lock claim/release, and
    // both GET /api/events (multiplexed) and GET /api/scenes/:slug/events.
    const events = deps.events ?? new SceneEventHub();
    app.decorate("events", events);
    await registerLockRoutes(app, deps.db, events);
    await registerSkeletonRoutes(app, {
      db: deps.db,
      converter: deps.skeletonConverter ?? null,
    });
    await registerEventRoutes(app, {
      db: deps.db,
      events,
      timeoutMs: deps.eventsTimeoutMs ?? EVENTS_TIMEOUT_MS,
    });

    if (fileStore) {
      await registerFileRoutes(app, {
        db: deps.db,
        store: fileStore,
        config,
      });
      // Admin backup/restore (SQLite backup API + portable tar.gz).
      await registerBackupRoutes(app, {
        db: deps.db,
        store: fileStore,
      });
      // One DiffService for GET /diff and 409 conflict bodies so both share
      // the same bounded immutable cache.
      const diffs =
        deps.diffs ?? new SceneDiffService(deps.db, fileStore);
      app.decorate("diffs", diffs);
      await registerVersionRoutes(app, {
        db: deps.db,
        store: fileStore,
        diffs,
        events,
        merge: deps.merge,
      });
      await registerDiffRoutes(app, {
        db: deps.db,
        store: fileStore,
        diffs,
      });

      // Render service: one shared worker (or null → 501). Injected
      // workers win over config so tests never need Chromium.
      const { renders, ownedWorker } = await createRenderService(
        deps,
        config,
        fileStore,
      );
      app.decorate("renders", renders);
      await registerRenderRoutes(app, {
        db: deps.db,
        store: fileStore,
        renders,
        config,
      });

      if (ownedWorker) {
        app.addHook("onClose", async () => {
          try {
            await ownedWorker.close();
          } catch {
            // ignore shutdown races
          }
        });
      }
    }
  }

  if (config.serveStatic) {
    await registerStatic(app, config);
  }

  return app;
}

function registerErrorHandlers(app: FastifyInstance, config: Config): void {
  app.setErrorHandler((err, request, reply) => {
    if (reply.sent) return;

    if (err instanceof AppError) {
      const body = errorEnvelope(err.code, err.message, err.details);
      return reply.status(err.statusCode).send(body);
    }

    // Fastify schema validation → 400 VALIDATION
    if (isFastifyError(err) && err.validation) {
      const body = errorEnvelope(
        ErrorCode.VALIDATION,
        err.message || "request validation failed",
        validationDetails(err),
      );
      return reply.status(err.statusCode ?? 400).send(body);
    }

    // Other Fastify errors with a known status (e.g. body parse failures)
    if (isFastifyError(err) && err.statusCode && err.statusCode < 500) {
      const code =
        err.statusCode === 404 ? ErrorCode.NOT_FOUND : ErrorCode.BAD_REQUEST;
      const body = errorEnvelope(code, err.message);
      return reply.status(err.statusCode).send(body);
    }

    request.log.error({ err }, "unhandled error");
    const body: ErrorEnvelope = errorEnvelope(
      ErrorCode.INTERNAL,
      "internal server error",
    );
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler(async (request, reply) => {
    // SPA fallback for browser navigations when static serving is on.
    if (
      config.serveStatic &&
      request.method === "GET" &&
      !request.url.startsWith("/api") &&
      !request.url.startsWith("/healthz") &&
      !request.url.startsWith("/readyz")
    ) {
      try {
        return await reply.sendFile("index.html");
      } catch {
        // fall through to JSON 404 if index.html is missing
      }
    }

    return reply
      .status(404)
      .send(
        errorEnvelope(
          ErrorCode.NOT_FOUND,
          `Route ${request.method}:${request.url} not found`,
        ),
      );
  });
}

async function registerStatic(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  const root = path.resolve(config.staticRoot);
  if (!existsSync(root)) {
    throw new Error(
      `STATIC_ROOT does not exist: ${root} (set STATIC_ROOT or disable SERVE_STATIC)`,
    );
  }

  await app.register(fastifyStatic, {
    root,
    // Let our notFoundHandler own the SPA fallback rather than @fastify/static's.
    wildcard: false,
  });
}

/**
 * Build or accept a {@link SceneRenderService}.
 *
 * - Explicit `deps.renders` is used as-is (no worker lifecycle owned here).
 * - Explicit `deps.renderWorker` (including `null`) wires a new service;
 *   the caller owns close.
 * - When config says `on` and nothing was injected, open via
 *   `@excalidraw-collab/render` (`openRenderWorker`) and own its close.
 * - Otherwise worker is `null` → routes return 501; Playwright is never
 *   imported on that path.
 */
async function createRenderService(
  deps: BuildAppDeps,
  config: Config,
  fileStore: FileStore,
): Promise<{
  renders: SceneRenderService;
  /** Worker opened by us; close on app shutdown. */
  ownedWorker: SceneRenderWorker | null;
}> {
  if (deps.renders) {
    return { renders: deps.renders, ownedWorker: null };
  }

  let worker: SceneRenderWorker | null;
  let ownedWorker: SceneRenderWorker | null = null;

  if (deps.renderWorker !== undefined) {
    worker = deps.renderWorker;
  } else if (config.renderWorker === "on") {
    // Dynamic import keeps Playwright out of the cold graph when off.
    // openRenderWorker with forced env never loads worker.js when "off";
    // we force "on" here because config already said on.
    const { openRenderWorker } = await import("@excalidraw-collab/render");
    const baseUrl =
      deps.renderBaseUrl ?? `http://127.0.0.1:${config.port}`;
    worker = await openRenderWorker(
      { baseUrl },
      { RENDER_WORKER: "on" },
    );
    ownedWorker = worker;
  } else {
    worker = null;
  }

  const renders = new SceneRenderService(
    deps.db!,
    fileStore,
    worker,
    new RenderCache(config.dataDir),
    config.dataDir,
  );
  return { renders, ownedWorker };
}

// Augment Fastify with decorations so later issues type-check cleanly.
declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    /** Present when `buildApp` was given a `db` handle. */
    db?: Database;
    /** Content-addressed file store (present when db/fileStore is configured). */
    fileStore?: FileStore;
    /** Scene diff service (present when db/fileStore is configured). */
    diffs?: SceneDiffService;
    /** Long-poll event hub (present when db is configured). */
    events?: SceneEventHub;
    /** Scene render service (present when db/fileStore is configured). */
    renders?: SceneRenderService;
    /** Server-side merge service (present when a render worker is wired). */
    merge?: SceneMergeService | null;
  }
}
