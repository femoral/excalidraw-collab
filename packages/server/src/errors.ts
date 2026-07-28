/**
 * Shared API error codes. The CLI imports these and maps them to process exit
 * codes mechanically:
 *   0 ok · 1 error · 2 usage · 4 conflict · 5 lock held · 6 timeout
 */
export const ErrorCode = {
  INTERNAL: "INTERNAL",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  LOCK_HELD: "LOCK_HELD",
  NOT_READY: "NOT_READY",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** CLI / process exit codes derived from API outcomes. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFLICT: 4,
  LOCK_HELD: 5,
  /** Client-side wait deadline (`watch --timeout`); not a server HTTP status. */
  TIMEOUT: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Map an API error code to the CLI exit code agents should see. */
export function exitCodeForError(code: ErrorCode): ExitCode {
  switch (code) {
    case ErrorCode.VALIDATION:
    case ErrorCode.BAD_REQUEST:
      return ExitCode.USAGE;
    case ErrorCode.CONFLICT:
      return ExitCode.CONFLICT;
    case ErrorCode.LOCK_HELD:
      return ExitCode.LOCK_HELD;
    default:
      return ExitCode.ERROR;
  }
}

/** Shape of every non-success HTTP body. */
export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
};

export function errorEnvelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  const body: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

/** Application error that maps cleanly onto the error envelope. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
