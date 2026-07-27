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

export type ApiFetchResult<T = unknown> = {
  status: number;
  body: T | undefined;
  /** Raw response text (useful for text/plain diffs). */
  text: string;
};

function resolveUrl(reqPath: string, server: string): string {
  return reqPath.startsWith("http://") || reqPath.startsWith("https://")
    ? reqPath
    : new URL(reqPath, server.endsWith("/") ? server : `${server}/`).href;
}

function buildHeaders(
  init: RequestInit,
  token: string | undefined,
  opts: { accept?: string } = {},
): Headers {
  const headers = new Headers(init.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", opts.accept ?? "application/json");
  }
  return headers;
}

function throwIfNotOk(
  response: Response,
  body: unknown,
  text: string,
): void {
  if (response.ok) return;
  if (isServerErrorBody(body)) {
    throw new CliError(body.error.message, {
      code: body.error.code,
      details: body.error.details,
    });
  }
  throw new CliError(
    typeof body === "string" && body.length > 0
      ? body
      : text.length > 0
        ? text
        : `HTTP ${response.status} ${response.statusText}`,
    {
      code: "ERROR",
      details: { status: response.status, body },
    },
  );
}

/**
 * Low-level fetch: returns HTTP status + body so callers can distinguish
 * 204 (long-poll timeout) from 200 without a second code path.
 */
export async function apiFetchResult<T = unknown>(
  options: ApiFetchOptions,
): Promise<ApiFetchResult<T>> {
  const { path: reqPath, config, ...init } = options;
  const server = config?.server;
  const token = config?.token;

  if (!server) {
    throw new CliError(
      "No server configured. Set EXCALICLI_SERVER or run login.",
      { code: "USAGE" },
    );
  }

  const url = resolveUrl(reqPath, server);
  const headers = buildHeaders(init, token);

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    // Abort is not an error for long-poll watch loops — rethrow as-is so
    // the caller can treat AbortError as a clean stop.
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
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

  throwIfNotOk(response, body, text);
  return {
    status: response.status,
    body: (text.length === 0 ? undefined : body) as T | undefined,
    text,
  };
}

/**
 * Typed fetch wrapper: attaches Bearer auth, JSON content-type, and unwraps
 * the server's `{ error: { code, message, details? } }` envelope into
 * {@link CliError} carrying the code (exit codes derived via errors.ts).
 */
export async function apiFetch<T = unknown>(
  options: ApiFetchOptions,
): Promise<T> {
  const result = await apiFetchResult<T>(options);
  return result.body as T;
}

/**
 * Fetch a text/plain body (e.g. `GET /diff?format=text`). Throws on non-OK.
 */
export async function apiFetchText(options: ApiFetchOptions): Promise<string> {
  const { path: reqPath, config, ...init } = options;
  const server = config?.server;
  const token = config?.token;

  if (!server) {
    throw new CliError(
      "No server configured. Set EXCALICLI_SERVER or run login.",
      { code: "USAGE" },
    );
  }

  const url = resolveUrl(reqPath, server);
  const headers = buildHeaders(init, token, { accept: "text/plain" });

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
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
  throwIfNotOk(response, body, text);
  return text;
}

/** Result of a successful binary (image) fetch. */
export type ApiBinaryResult = {
  bytes: Uint8Array;
  contentType: string | null;
  status: number;
};

/**
 * Fetch a binary body (PNG/SVG render endpoints). On non-OK responses, still
 * parses a JSON error envelope when present so {@link CliError} carries the
 * server code and `details.reason` for render-unavailable cases.
 */
export async function apiFetchBinary(
  options: ApiFetchOptions,
): Promise<ApiBinaryResult> {
  const { path: reqPath, config, ...init } = options;
  const server = config?.server;
  const token = config?.token;

  if (!server) {
    throw new CliError(
      "No server configured. Set EXCALICLI_SERVER or run login.",
      { code: "USAGE" },
    );
  }

  const url = resolveUrl(reqPath, server);
  const headers = buildHeaders(init, token, {
    accept: "image/png, image/svg+xml, application/json",
  });

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
    throw new CliError(
      `Request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { code: "ERROR", cause },
    );
  }

  if (!response.ok) {
    // Error responses are JSON envelopes — read as text so we can unwrap.
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    throwIfNotOk(response, body, text);
    // throwIfNotOk always throws when !ok; keep TS happy.
    throw new CliError(`HTTP ${response.status}`, { code: "ERROR" });
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  return {
    bytes: buffer,
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
}
