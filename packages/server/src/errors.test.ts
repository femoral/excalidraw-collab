import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ErrorCode,
  ExitCode,
  exitCodeForError,
  errorEnvelope,
} from "./errors.js";

describe("exitCodeForError", () => {
  test("maps validation/bad request to usage (2)", () => {
    assert.equal(exitCodeForError(ErrorCode.VALIDATION), ExitCode.USAGE);
    assert.equal(exitCodeForError(ErrorCode.BAD_REQUEST), ExitCode.USAGE);
  });

  test("maps conflict to 4 and lock held to 5", () => {
    assert.equal(exitCodeForError(ErrorCode.CONFLICT), ExitCode.CONFLICT);
    assert.equal(exitCodeForError(ErrorCode.LOCK_HELD), ExitCode.LOCK_HELD);
  });

  test("maps everything else to generic error (1)", () => {
    assert.equal(exitCodeForError(ErrorCode.INTERNAL), ExitCode.ERROR);
    assert.equal(exitCodeForError(ErrorCode.NOT_FOUND), ExitCode.ERROR);
    assert.equal(exitCodeForError(ErrorCode.UNAUTHORIZED), ExitCode.ERROR);
  });
});

describe("errorEnvelope", () => {
  test("omits details when not provided", () => {
    assert.deepEqual(errorEnvelope(ErrorCode.NOT_FOUND, "missing"), {
      error: { code: "NOT_FOUND", message: "missing" },
    });
  });

  test("includes details when provided", () => {
    assert.deepEqual(
      errorEnvelope(ErrorCode.VALIDATION, "bad", [{ field: "name" }]),
      {
        error: {
          code: "VALIDATION",
          message: "bad",
          details: [{ field: "name" }],
        },
      },
    );
  });
});
