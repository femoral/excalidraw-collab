import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOKEN_STORAGE_KEY,
  applyUnauthorized,
  clearStoredToken,
  normalizeTokenInput,
  readStoredToken,
  reduceAuth,
  writeStoredToken,
  type AuthState,
  type TokenStorage,
} from "./auth.ts";

function memoryStorage(seed: Record<string, string> = {}): TokenStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test("readStoredToken trims and rejects empty", () => {
  const s = memoryStorage({ [TOKEN_STORAGE_KEY]: "  abc  " });
  assert.equal(readStoredToken(s), "abc");
  s.setItem(TOKEN_STORAGE_KEY, "   ");
  assert.equal(readStoredToken(s), null);
  assert.equal(readStoredToken(memoryStorage()), null);
});

test("write/clear round-trip", () => {
  const s = memoryStorage();
  writeStoredToken(s, "secret");
  assert.equal(s.getItem(TOKEN_STORAGE_KEY), "secret");
  clearStoredToken(s);
  assert.equal(s.getItem(TOKEN_STORAGE_KEY), null);
});

test("hydrate with token → checking; without → anonymous", () => {
  const withToken = reduceAuth(
    { status: "anonymous" },
    { type: "hydrate", token: "t1" },
  );
  assert.deepEqual(withToken, { status: "checking", token: "t1" });

  const without = reduceAuth(
    { status: "checking", token: "x" },
    { type: "hydrate", token: null },
  );
  assert.deepEqual(without, { status: "anonymous" });
});

test("login moves to checking with trimmed token", () => {
  const next = reduceAuth(
    { status: "anonymous" },
    { type: "login", token: "  tok  " },
  );
  assert.deepEqual(next, { status: "checking", token: "tok" });

  const empty = reduceAuth(
    { status: "anonymous" },
    { type: "login", token: "  " },
  );
  assert.deepEqual(empty, { status: "anonymous" });
});

test("session_verified promotes checking → authenticated", () => {
  const start: AuthState = { status: "checking", token: "t" };
  assert.deepEqual(reduceAuth(start, { type: "session_verified" }), {
    status: "authenticated",
    token: "t",
  });
  // anonymous stays anonymous (no token to promote)
  assert.deepEqual(
    reduceAuth({ status: "anonymous" }, { type: "session_verified" }),
    { status: "anonymous" },
  );
});

test("unauthorized and logout always return anonymous", () => {
  const authed: AuthState = { status: "authenticated", token: "t" };
  assert.deepEqual(reduceAuth(authed, { type: "unauthorized" }), {
    status: "anonymous",
  });
  assert.deepEqual(reduceAuth(authed, { type: "logout" }), {
    status: "anonymous",
  });
});

test("401-clears-token: applyUnauthorized wipes storage and returns anonymous", () => {
  const s = memoryStorage({ [TOKEN_STORAGE_KEY]: "revoked-token" });
  const next = applyUnauthorized(s);
  assert.deepEqual(next, { status: "anonymous" });
  assert.equal(s.getItem(TOKEN_STORAGE_KEY), null);
  // Idempotent
  assert.deepEqual(applyUnauthorized(s), { status: "anonymous" });
});

test("normalizeTokenInput", () => {
  assert.equal(normalizeTokenInput("  a  "), "a");
  assert.equal(normalizeTokenInput(""), null);
  assert.equal(normalizeTokenInput("   "), null);
});
