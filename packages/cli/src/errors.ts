/**
 * CLI exit codes and server error-code mapping.
 *
 * Exit codes (from PLAN.md / issue #6):
 *   0 ok, 1 error, 2 usage, 4 conflict, 5 lock held
 *
 * Runtime keeps its own copy so the published CLI has zero runtime deps
 * (must not pull Fastify). Source of truth is packages/server `ErrorCode` /
 * `exitCodeForError` — `errors.drift.test.ts` imports the server at test time
 * and fails if this file diverges.
 */

/** Process exit codes used by the CLI. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFLICT: 4,
  LOCK_HELD: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Server error-code strings. Must match `ErrorCode` in packages/server exactly
 * (see errors.drift.test.ts).
 * @see packages/server/src/errors.ts — source of truth
 */
export const SERVER_ERROR_CODES = [
  "INTERNAL",
  "NOT_FOUND",
  "VALIDATION",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "LOCK_HELD",
  "NOT_READY",
  "NOT_IMPLEMENTED",
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number] | (string & {});

/**
 * Map a server (or CLI-local) error code string to a process exit code.
 * Keep in lockstep with packages/server `exitCodeForError`.
 * `USAGE` is CLI-local (parse failures), not a server ErrorCode.
 */
export function exitCodeForError(code: string | undefined): ExitCodeValue {
  switch (code) {
    case "VALIDATION":
    case "BAD_REQUEST":
    case "USAGE":
      return ExitCode.USAGE;
    case "CONFLICT":
      return ExitCode.CONFLICT;
    case "LOCK_HELD":
      return ExitCode.LOCK_HELD;
    default:
      return ExitCode.ERROR;
  }
}

/** Structured CLI failure; the dispatcher maps this to streams + exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  readonly details: unknown;

  constructor(
    message: string,
    options: {
      code?: string;
      exitCode?: ExitCodeValue;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.code = options.code ?? "ERROR";
    this.exitCode = options.exitCode ?? exitCodeForError(this.code);
    this.details = options.details;
  }
}

/** Usage / parse failures (exit 2). */
export class UsageError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "USAGE", exitCode: ExitCode.USAGE, details });
    this.name = "UsageError";
  }
}

/** Error body shape for --json failure output (matches server envelope style). */
export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function toErrorEnvelope(err: CliError): ErrorEnvelope {
  const body: ErrorEnvelope["error"] = {
    code: err.code,
    message: err.message,
  };
  if (err.details !== undefined) {
    body.details = err.details;
  }
  return { error: body };
}
