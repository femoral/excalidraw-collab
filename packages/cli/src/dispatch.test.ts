import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "./dispatch.js";
import { ExitCode, registerCommand } from "./index.js";
import { CliError } from "./errors.js";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(s: string) {
          stdout += s;
        },
      },
      stderr: {
        write(s: string) {
          stderr += s;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test("excali --help lists commands on stdout", async () => {
  const c = capture();
  const code = await run({ argv: ["--help"], io: c.io });
  assert.equal(code, ExitCode.OK);
  assert.match(c.stdout, /Usage: excali/);
  assert.match(c.stdout, /version/);
  assert.equal(c.stderr, "");
});

test("unknown command exits 2 with usage on stderr", async () => {
  const c = capture();
  const code = await run({ argv: ["not-a-real-command"], io: c.io });
  assert.equal(code, ExitCode.USAGE);
  assert.equal(c.stdout, "");
  assert.match(c.stderr, /Unknown command: not-a-real-command/);
  assert.match(c.stderr, /Usage: excali/);
});

test("version stub: human table on stdout", async () => {
  const c = capture();
  const code = await run({ argv: ["version"], io: c.io });
  assert.equal(code, ExitCode.OK);
  assert.match(c.stdout, /name\s+version/);
  assert.match(c.stdout, /excali/);
  assert.equal(c.stderr, "");
});

test("version stub: --json emits one JSON object on stdout", async () => {
  const c = capture();
  const code = await run({ argv: ["version", "--json"], io: c.io });
  assert.equal(code, ExitCode.OK);
  assert.equal(c.stderr, "");
  const parsed = JSON.parse(c.stdout) as { name: string; version: string };
  assert.equal(parsed.name, "excali");
  assert.equal(typeof parsed.version, "string");
});

test("global --json before subcommand works", async () => {
  const c = capture();
  const code = await run({ argv: ["--json", "version"], io: c.io });
  assert.equal(code, ExitCode.OK);
  const parsed = JSON.parse(c.stdout) as { name: string };
  assert.equal(parsed.name, "excali");
});

test("failed command with --json: stdout is valid JSON, message on stderr", async () => {
  registerCommand({
    name: "fail-stub",
    description: "test-only failing command",
    run() {
      throw new CliError("parentVersion mismatch", {
        code: "CONFLICT",
        details: { head: 2 },
      });
    },
  });

  const c = capture();
  const code = await run({ argv: ["--json", "fail-stub"], io: c.io });
  assert.equal(code, ExitCode.CONFLICT);
  assert.match(c.stderr, /parentVersion mismatch/);
  // stdout must be exactly one parseable JSON value (never half-JSON).
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string; details?: { head: number } };
  };
  assert.equal(parsed.error.code, "CONFLICT");
  assert.equal(parsed.error.message, "parentVersion mismatch");
  assert.equal(parsed.error.details?.head, 2);
});

test("failed command without --json: empty stdout, error on stderr", async () => {
  registerCommand({
    name: "fail-plain",
    description: "test-only",
    run() {
      throw new CliError("boom", { code: "INTERNAL" });
    },
  });

  const c = capture();
  const code = await run({ argv: ["fail-plain"], io: c.io });
  assert.equal(code, ExitCode.ERROR);
  assert.equal(c.stdout, "");
  assert.match(c.stderr, /boom/);
});

test("LOCK_HELD maps to exit 5 under --json with valid stdout JSON", async () => {
  registerCommand({
    name: "lock-stub",
    description: "test-only",
    run() {
      throw new CliError("lock held", { code: "LOCK_HELD" });
    },
  });

  const c = capture();
  const code = await run({ argv: ["lock-stub", "--json"], io: c.io });
  assert.equal(code, ExitCode.LOCK_HELD);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "LOCK_HELD");
});
