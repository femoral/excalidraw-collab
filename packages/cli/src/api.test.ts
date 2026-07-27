import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiFetch } from "./api.js";
import { CliError, ExitCode } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const cfg: ResolvedConfig = {
  server: "http://example.test",
  token: "tok",
  path: "/tmp/unused-config.json",
};

test("apiFetch attaches Authorization and returns JSON body", async () => {
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    const headers = new Headers(init?.headers);
    seenAuth = headers.get("Authorization") ?? "";
    return new Response(JSON.stringify({ ok: true, n: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const body = await apiFetch<{ ok: boolean; n: number }>({
    path: "/api/scenes",
    config: cfg,
  });

  assert.equal(body.ok, true);
  assert.equal(body.n, 1);
  assert.equal(seenUrl, "http://example.test/api/scenes");
  assert.equal(seenAuth, "Bearer tok");
});

test("apiFetch unwraps server error envelope into CliError with code", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "CONFLICT",
          message: "parentVersion mismatch",
          details: { head: 4 },
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  await assert.rejects(
    () => apiFetch({ path: "/api/scenes/x/scene", config: cfg, method: "POST" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CONFLICT");
      assert.equal(err.message, "parentVersion mismatch");
      assert.equal(err.exitCode, ExitCode.CONFLICT);
      assert.deepEqual(err.details, { head: 4 });
      return true;
    },
  );
});

test("apiFetch maps LOCK_HELD", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "LOCK_HELD", message: "agent holds the turn" },
      }),
      { status: 409 },
    )) as typeof fetch;

  await assert.rejects(
    () => apiFetch({ path: "/api/scenes/x/lock", config: cfg, method: "POST" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.exitCode, ExitCode.LOCK_HELD);
      return true;
    },
  );
});

test("apiFetch requires server in config", async () => {
  await assert.rejects(
    () =>
      apiFetch({
        path: "/api/scenes",
        config: { server: undefined, token: "t", path: "" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      return true;
    },
  );
});

test("apiFetchResult surfaces 204 with empty body (long-poll timeout)", async () => {
  const { apiFetchResult } = await import("./api.js");
  globalThis.fetch = (async () =>
    new Response(null, { status: 204 })) as typeof fetch;

  const result = await apiFetchResult({
    path: "/api/scenes/x/events?since=1",
    config: cfg,
  });
  assert.equal(result.status, 204);
  assert.equal(result.body, undefined);
  assert.equal(result.text, "");
});
