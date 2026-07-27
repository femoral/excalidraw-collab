/**
 * CLI exit codes and server error-code mapping.
 *
 * Exit codes (from PLAN.md / issue #6):
 *   0 ok, 1 error, 2 usage, 4 conflict, 5 lock held
 *
 * Source of truth for server error codes: packages/server error-code enum
 * (issue #4). Declared here so this package builds before that lands; a later
 * issue can replace SERVER_ERROR_CODES with a direct import without touching
 * call sites of {@link exitCodeForError} / {@link CliError}.
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
 * Server error-code strings. Keep aligned with packages/server (issue #4).
 * @see packages/server — error-code enum (source of truth)
 */
export const SERVER_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "LOCK_HELD",
  "INTERNAL",
  "BAD_REQUEST",
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number] | (string & {});

/** Map a server (or CLI) error code string to a process exit code. */
export function exitCodeForError(code: string | undefined): ExitCodeValue {
  switch (code) {
    case "CONFLICT":
      return ExitCode.CONFLICT;
    case "LOCK_HELD":
      return ExitCode.LOCK_HELD;
    case "USAGE":
      return ExitCode.USAGE;
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
