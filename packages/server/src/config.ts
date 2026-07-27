export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export type RenderWorkerMode = "on" | "off";

export type Config = {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Root directory for SQLite DB and content-addressed files. */
  dataDir: string;
  /**
   * Bootstrap admin token read on first run (hashed into the tokens table).
   * Empty string means "not provided".
   */
  bootstrapToken: string;
  /** Whether the Playwright render worker is enabled. */
  renderWorker: RenderWorkerMode;
  /** Fastify / pino log level. */
  logLevel: LogLevel;
  /** Serve the built web app + SPA fallback. Off by default. */
  serveStatic: boolean;
  /** Directory of the built web app (used only when serveStatic is true). */
  staticRoot: string;
};

const LOG_LEVELS = new Set<LogLevel>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

/** Thrown when an env var fails validation. Message always names the variable. */
export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, reason: string) {
    super(`${variable}: ${reason}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

function parseBool(raw: string, variable: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  throw new ConfigError(
    variable,
    `expected a boolean (true/false/on/off/1/0), got ${JSON.stringify(raw)}`,
  );
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(
      "PORT",
      `expected an integer 1–65535, got ${JSON.stringify(raw)}`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(
      "PORT",
      `expected an integer 1–65535, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parseLogLevel(raw: string): LogLevel {
  const v = raw.trim().toLowerCase() as LogLevel;
  if (!LOG_LEVELS.has(v)) {
    throw new ConfigError(
      "LOG_LEVEL",
      `expected one of ${[...LOG_LEVELS].join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

function parseRenderWorker(raw: string): RenderWorkerMode {
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return "on";
  if (v === "off" || v === "false" || v === "0") return "off";
  throw new ConfigError(
    "RENDER_WORKER",
    `expected "on" or "off", got ${JSON.stringify(raw)}`,
  );
}

/**
 * Load and validate config from an env-like record.
 * Fails fast with {@link ConfigError} naming the offending variable.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const port = env.PORT !== undefined && env.PORT !== "" ? parsePort(env.PORT) : 3000;

  const dataDir =
    env.DATA_DIR !== undefined && env.DATA_DIR !== "" ? env.DATA_DIR : "./data";
  if (dataDir.includes("\0")) {
    throw new ConfigError("DATA_DIR", "path must not contain null bytes");
  }

  const bootstrapToken =
    env.BOOTSTRAP_TOKEN !== undefined ? env.BOOTSTRAP_TOKEN : "";

  const renderWorker =
    env.RENDER_WORKER !== undefined && env.RENDER_WORKER !== ""
      ? parseRenderWorker(env.RENDER_WORKER)
      : "off";

  const logLevel =
    env.LOG_LEVEL !== undefined && env.LOG_LEVEL !== ""
      ? parseLogLevel(env.LOG_LEVEL)
      : "info";

  const serveStatic =
    env.SERVE_STATIC !== undefined && env.SERVE_STATIC !== ""
      ? parseBool(env.SERVE_STATIC, "SERVE_STATIC")
      : false;

  const staticRoot =
    env.STATIC_ROOT !== undefined && env.STATIC_ROOT !== ""
      ? env.STATIC_ROOT
      : "./public";
  if (staticRoot.includes("\0")) {
    throw new ConfigError("STATIC_ROOT", "path must not contain null bytes");
  }

  return {
    port,
    dataDir,
    bootstrapToken,
    renderWorker,
    logLevel,
    serveStatic,
    staticRoot,
  };
}
