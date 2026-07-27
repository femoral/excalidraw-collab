/**
 * Tests for login, whoami, and token commands (issue #14).
 * HTTP is stubbed via globalThis.fetch so we never need a listening server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { run } from "./dispatch.js";
import { configPath } from "./config.js";
import { ExitCode } from "./errors.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excalicli-auth-"));
  return {
    dir,
    env: { ...process.env, XDG_CONFIG_HOME: dir },
  };
}

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

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(status, { error: { code, message } });
}

// ─── login ───────────────────────────────────────────────────────────────────

test("login rejects a bad token without writing config", async () => {
  const { env, dir } = tempEnv();
  const cfgFile = configPath(env);
  assert.equal(fs.existsSync(cfgFile), false);

  globalThis.fetch = (async () =>
    errorResponse(401, "UNAUTHORIZED", "invalid or revoked token")) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: [
      "login",
      "--server",
      "http://example.test",
      "--token",
      "bad-token",
      "--json",
    ],
    env,
    io: c.io,
  });

  assert.equal(code, ExitCode.ERROR);
  assert.equal(fs.existsSync(cfgFile), false);
  // Config dir may or may not exist; the file must not.
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }) : [];
  assert.ok(
    !files.some((f) => String(f).endsWith("config.json")),
    "config.json must not be written on failed login",
  );

  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string };
  };
  assert.equal(parsed.error.code, "UNAUTHORIZED");
  assert.match(parsed.error.message, /invalid|revoked|token/i);
  assert.match(c.stderr, /invalid|revoked|token/i);
});

test("login writes 0600 config on success and emits parseable --json", async () => {
  const { env } = tempEnv();
  let seenUrl = "";
  let seenAuth = "";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    const headers = new Headers(init?.headers);
    seenAuth = headers.get("Authorization") ?? "";
    return jsonResponse(200, { scenes: [] });
  }) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: [
      "--json",
      "login",
      "--server",
      "http://example.test/",
      "--token",
      "good-secret",
    ],
    env,
    io: c.io,
  });

  assert.equal(code, ExitCode.OK);
  assert.equal(seenUrl, "http://example.test/api/scenes");
  assert.equal(seenAuth, "Bearer good-secret");

  const parsed = JSON.parse(c.stdout) as {
    server: string;
    path: string;
    ok: boolean;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.server, "http://example.test");
  assert.equal(parsed.path, configPath(env));
  assert.equal(c.stderr, "");

  const file = configPath(env);
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
    server: string;
    token: string;
  };
  assert.equal(onDisk.server, "http://example.test");
  assert.equal(onDisk.token, "good-secret");
});

test("login without --server exits usage with JSON error envelope", async () => {
  const { env } = tempEnv();
  const c = capture();
  const code = await run({
    argv: ["login", "--token", "t", "--json"],
    env,
    io: c.io,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
});

// ─── whoami ──────────────────────────────────────────────────────────────────

test("whoami prints token identity and author note", async () => {
  const { env } = tempEnv();
  // Write config so loadConfig resolves without env overrides.
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "tok" }),
    { mode: 0o600 },
  );

  globalThis.fetch = (async () =>
    jsonResponse(200, {
      id: "uuid-1",
      name: "agent-x",
      isAdmin: false,
    })) as typeof fetch;

  const human = capture();
  const humanCode = await run({
    argv: ["whoami"],
    env,
    io: human.io,
  });
  assert.equal(humanCode, ExitCode.OK);
  assert.match(human.stdout, /agent-x/);
  assert.match(human.stdout, /author in version history/i);
  assert.equal(human.stderr, "");

  const json = capture();
  const jsonCode = await run({
    argv: ["whoami", "--json"],
    env,
    io: json.io,
  });
  assert.equal(jsonCode, ExitCode.OK);
  const parsed = JSON.parse(json.stdout) as {
    id: string;
    name: string;
    isAdmin: boolean;
  };
  assert.equal(parsed.name, "agent-x");
  assert.equal(parsed.id, "uuid-1");
  assert.equal(parsed.isAdmin, false);
});

test("whoami --help mentions author in history", async () => {
  const c = capture();
  const code = await run({ argv: ["whoami", "--help"], io: c.io });
  assert.equal(code, ExitCode.OK);
  assert.match(c.stdout, /author/i);
  assert.match(c.stdout, /history/i);
});

// ─── token create / ls / revoke ──────────────────────────────────────────────

test("token create prints secret once with warning; --json is one object", async () => {
  const { env } = tempEnv();
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "admin-tok" }),
    { mode: 0o600 },
  );

  globalThis.fetch = (async (_input, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as { name: string };
    assert.equal(body.name, "bot");
    return jsonResponse(201, {
      id: "tok-id-1",
      name: "bot",
      token: "secret-shown-once",
      isAdmin: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsed: null,
    });
  }) as typeof fetch;

  const human = capture();
  const humanCode = await run({
    argv: ["token", "create", "bot"],
    env,
    io: human.io,
  });
  assert.equal(humanCode, ExitCode.OK);
  assert.match(human.stdout, /secret-shown-once/);
  assert.match(human.stdout, /cannot be retrieved again/i);
  assert.equal(human.stderr, "");

  const json = capture();
  const jsonCode = await run({
    argv: ["--json", "token", "create", "bot"],
    env,
    io: json.io,
  });
  assert.equal(jsonCode, ExitCode.OK);
  const parsed = JSON.parse(json.stdout) as {
    name: string;
    token: string;
    warning: string;
  };
  assert.equal(parsed.name, "bot");
  assert.equal(parsed.token, "secret-shown-once");
  assert.match(parsed.warning, /cannot be retrieved again/i);
});

test("token ls lists tokens under --json", async () => {
  const { env } = tempEnv();
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "admin-tok" }),
    { mode: 0o600 },
  );

  globalThis.fetch = (async () =>
    jsonResponse(200, {
      tokens: [
        {
          id: "a",
          name: "admin",
          isAdmin: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsed: null,
        },
        {
          id: "b",
          name: "agent",
          isAdmin: false,
          createdAt: "2026-01-02T00:00:00.000Z",
          lastUsed: "2026-01-03T00:00:00.000Z",
        },
      ],
    })) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: ["token", "ls", "--json"],
    env,
    io: c.io,
  });
  assert.equal(code, ExitCode.OK);
  const parsed = JSON.parse(c.stdout) as {
    tokens: Array<{ name: string; isAdmin: boolean }>;
  };
  assert.equal(parsed.tokens.length, 2);
  assert.equal(parsed.tokens[0]!.name, "admin");
  assert.equal(parsed.tokens[1]!.name, "agent");
});

test("token revoke looks up name then DELETEs by id", async () => {
  const { env } = tempEnv();
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "admin-tok" }),
    { mode: 0o600 },
  );

  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (method === "GET") {
      return jsonResponse(200, {
        tokens: [
          {
            id: "id-to-revoke",
            name: "doomed",
            isAdmin: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsed: null,
          },
        ],
      });
    }
    if (method === "DELETE") {
      assert.match(url, /\/api\/tokens\/id-to-revoke$/);
      return jsonResponse(204, null);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: ["--json", "token", "revoke", "doomed"],
    env,
    io: c.io,
  });
  assert.equal(code, ExitCode.OK);
  const parsed = JSON.parse(c.stdout) as {
    revoked: boolean;
    id: string;
    name: string;
  };
  assert.equal(parsed.revoked, true);
  assert.equal(parsed.id, "id-to-revoke");
  assert.equal(parsed.name, "doomed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[1]!.method, "DELETE");
});

test("token create with non-admin fails with clear message (not bare 403)", async () => {
  const { env } = tempEnv();
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "agent-tok" }),
    { mode: 0o600 },
  );

  globalThis.fetch = (async () =>
    errorResponse(403, "FORBIDDEN", "admin token required")) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: ["token", "create", "nope", "--json"],
    env,
    io: c.io,
  });
  assert.equal(code, ExitCode.ERROR);
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string };
  };
  assert.equal(parsed.error.code, "FORBIDDEN");
  assert.match(parsed.error.message, /admin token required/i);
  assert.doesNotMatch(parsed.error.message, /^403$/);
  assert.match(c.stderr, /admin token required/i);
  // Clearer than a bare server phrase alone: mention create/list/revoke scope.
  assert.match(parsed.error.message, /create|list|revoke/i);
});

test("token ls non-admin rejection is parseable JSON", async () => {
  const { env } = tempEnv();
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "agent-tok" }),
    { mode: 0o600 },
  );

  globalThis.fetch = (async () =>
    errorResponse(403, "FORBIDDEN", "admin token required")) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: ["--json", "token", "ls"],
    env,
    io: c.io,
  });
  assert.equal(code, ExitCode.ERROR);
  // Must be exactly one parseable JSON value.
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "FORBIDDEN");
});

test("token revoke unknown name returns NOT_FOUND with JSON", async () => {
  const { env } = tempEnv();
  fs.mkdirSync(path.dirname(configPath(env)), { recursive: true });
  fs.writeFileSync(
    configPath(env),
    JSON.stringify({ server: "http://example.test", token: "admin-tok" }),
    { mode: 0o600 },
  );

  globalThis.fetch = (async () =>
    jsonResponse(200, { tokens: [] })) as typeof fetch;

  const c = capture();
  const code = await run({
    argv: ["token", "revoke", "missing", "--json"],
    env,
    io: c.io,
  });
  assert.equal(code, ExitCode.ERROR);
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string };
  };
  assert.equal(parsed.error.code, "NOT_FOUND");
  assert.match(parsed.error.message, /missing/);
});
