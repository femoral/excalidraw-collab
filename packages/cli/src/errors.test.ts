import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CliError,
  ExitCode,
  UsageError,
  exitCodeForError,
  toErrorEnvelope,
} from "./errors.js";

test("exitCodeForError maps server codes", () => {
  assert.equal(exitCodeForError("CONFLICT"), ExitCode.CONFLICT);
  assert.equal(exitCodeForError("LOCK_HELD"), ExitCode.LOCK_HELD);
  assert.equal(exitCodeForError("USAGE"), ExitCode.USAGE);
  assert.equal(exitCodeForError("UNAUTHORIZED"), ExitCode.ERROR);
  assert.equal(exitCodeForError("NOT_FOUND"), ExitCode.ERROR);
  assert.equal(exitCodeForError("VALIDATION"), ExitCode.ERROR);
  assert.equal(exitCodeForError("INTERNAL"), ExitCode.ERROR);
  assert.equal(exitCodeForError(undefined), ExitCode.ERROR);
  assert.equal(exitCodeForError("SOMETHING_NEW"), ExitCode.ERROR);
});

test("CliError derives exit code from code", () => {
  const conflict = new CliError("version mismatch", { code: "CONFLICT" });
  assert.equal(conflict.exitCode, ExitCode.CONFLICT);
  assert.equal(conflict.code, "CONFLICT");

  const lock = new CliError("held", { code: "LOCK_HELD" });
  assert.equal(lock.exitCode, ExitCode.LOCK_HELD);

  const usage = new UsageError("bad args");
  assert.equal(usage.exitCode, ExitCode.USAGE);
  assert.equal(usage.code, "USAGE");
});

test("toErrorEnvelope shapes JSON error body", () => {
  const err = new CliError("nope", {
    code: "CONFLICT",
    details: { head: 3 },
  });
  assert.deepEqual(toErrorEnvelope(err), {
    error: { code: "CONFLICT", message: "nope", details: { head: 3 } },
  });
});
