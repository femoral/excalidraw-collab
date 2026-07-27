import { CliError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

/** Server error envelope: `{ error: { code, message, details? } }`. */
export type ServerErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function isServerErrorBody(value: unknown): value is ServerErrorBody {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const err = (value as { error?: unknown }).error;
  if (err === null || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: unknown; message?: unknown };
  return typeof e.code === "string" && typeof e.message === "string";
}

export type ApiFetchOptions = RequestInit & {
  /** Path relative to config.server (e.g. `/api/scenes`). Absolute URLs allowed. */
  path: string;
  /** Override resolved config (tests). */
  config?: ResolvedConfig;
};

/**
 * Typed fetch wrapper: attaches Bearer auth, JSON content-type, and unwraps
 * the server's `{ error: { code, message, details? } }` envelope into
 * {@link CliError} carrying the code (exit codes derived via errors.ts).
 */
export async function apiFetch<T = unknown>(
  options: ApiFetchOptions,
): Promise<T> {
  const { path: reqPath, config, ...init } = options;
  const server = config?.server;
  const token = config?.token;

  if (!server) {
    throw new CliError(
      "No server configured. Set EXCALICLI_SERVER or run login.",
      { code: "USAGE" },
    );
  }

  const url = reqPath.startsWith("http://") || reqPath.startsWith("https://")
    ? reqPath
    : new URL(reqPath, server.endsWith("/") ? server : `${server}/`).href;

  const headers = new Headers(init.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    throw new CliError(
      `Request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { code: "ERROR", cause },
    );
  }

  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    if (isServerErrorBody(body)) {
      throw new CliError(body.error.message, {
        code: body.error.code,
        details: body.error.details,
      });
    }
    throw new CliError(
      typeof body === "string" && body.length > 0
        ? body
        : `HTTP ${response.status} ${response.statusText}`,
      {
        code: "ERROR",
        details: { status: response.status, body },
      },
    );
  }

  return body as T;
}
