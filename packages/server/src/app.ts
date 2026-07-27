import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifyStatic from "@fastify/static";
import { type Config, loadConfig } from "./config.js";
import {
  AppError,
  ErrorCode,
  errorEnvelope,
  type ErrorEnvelope,
} from "./errors.js";

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

  const app = Fastify({
    logger: { level: config.logLevel },
    ...deps.fastifyOpts,
  });

  // Stash config for plugins/routes that need it later without closing over a
  // different object. Later issues can decorate more services here.
  app.decorate("config", config);

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

// Augment Fastify with the config decoration so later issues type-check cleanly.
declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
