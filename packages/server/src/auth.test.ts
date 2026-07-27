import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import {
  ADMIN_TOKEN_NAME,
  authorFromIdentity,
  BOOTSTRAP_SEEDED_MARKER,
  generateTokenSecret,
  isAdminIdentity,
  seedBootstrapToken,
  tokenHashesEqual,
  type RequestIdentity,
} from "./auth.js";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { hashToken, openDatabase, type Database } from "./db.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import type { TokenCreated, TokenInfo } from "./tokens.js";

/** Each test gets its own temp DATA_DIR; cleaned in afterEach. */
const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-auth-"));
  tempDirs.push(dir);
  return dir;
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    serveStatic: false,
    logLevel: "silent",
    ...overrides,
  };
}

async function buildAuthApp(opts: {
  dataDir: string;
  bootstrapToken?: string;
}): Promise<{ app: FastifyInstance; db: Database }> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const app = await buildApp({
    config: testConfig({
      dataDir: opts.dataDir,
      bootstrapToken: opts.bootstrapToken ?? "",
    }),
    db,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });
  openApps.push(app);
  return { app, db };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

afterEach(async () => {
  while (openApps.length > 0) {
    const app = openApps.pop()!;
    try {
      await app.close();
    } catch {
      // ignore
    }
  }
  while (openDbs.length > 0) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("tokenHashesEqual / identity helpers", () => {
  test("tokenHashesEqual is true for identical hex digests", () => {
    const h = hashToken("same-secret");
    assert.equal(tokenHashesEqual(h, h), true);
  });

  test("tokenHashesEqual is false for different digests", () => {
    const a = hashToken("a");
    const b = hashToken("b");
    assert.equal(tokenHashesEqual(a, b), false);
  });

  test("tokenHashesEqual rejects non-hex or length-mismatched inputs", () => {
    assert.equal(tokenHashesEqual("zz", "zz"), false);
    assert.equal(tokenHashesEqual("ab", "abcd"), false);
    assert.equal(tokenHashesEqual("", ""), false);
  });

  test("authorFromIdentity returns the token name only", () => {
    const identity: RequestIdentity = {
      tokenId: "id-1",
      name: "agent-x",
      isAdmin: false,
    };
    assert.equal(authorFromIdentity(identity), "agent-x");
    assert.equal(isAdminIdentity(identity), false);
    assert.equal(
      isAdminIdentity({ tokenId: "a", name: ADMIN_TOKEN_NAME, isAdmin: true }),
      true,
    );
  });

  test("generateTokenSecret returns a non-empty base64url string", () => {
    const a = generateTokenSecret();
    const b = generateTokenSecret();
    assert.ok(a.length >= 32);
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });
});

describe("bootstrap", () => {
  test("BOOTSTRAP_TOKEN seeds an admin token on first boot", async () => {
    const dataDir = tempDataDir();
    const secret = "bootstrap-secret-value";
    const { app, db } = await buildAuthApp({
      dataDir,
      bootstrapToken: secret,
    });

    const tokens = db.listTokens();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.name, ADMIN_TOKEN_NAME);
    assert.equal(tokens[0]!.token_hash, hashToken(secret));
    assert.ok(existsSync(path.join(dataDir, BOOTSTRAP_SEEDED_MARKER)));

    // Admin can list tokens with the bootstrap secret.
    const res = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(secret),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { tokens: TokenInfo[] };
    assert.equal(body.tokens.length, 1);
    assert.equal(body.tokens[0]!.name, ADMIN_TOKEN_NAME);
  });

  test("bootstrap does not re-seed or resurrect a revoked admin on later boots", async () => {
    const dataDir = tempDataDir();
    const bootstrapSecret = "first-boot-secret";

    const first = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });
    assert.equal(first.db.listTokens().length, 1);

    // Mint a non-admin so the system has history after admin is gone.
    const mint = await first.app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        ...bearer(bootstrapSecret),
        "content-type": "application/json",
      },
      payload: { name: "agent" },
    });
    assert.equal(mint.statusCode, 201);
    const agent = mint.json() as TokenCreated;

    const adminId = first.db.listTokens().find((t) => t.name === ADMIN_TOKEN_NAME)!
      .id;
    const del = await first.app.inject({
      method: "DELETE",
      url: `/api/tokens/${adminId}`,
      headers: bearer(bootstrapSecret),
    });
    assert.equal(del.statusCode, 204);
    assert.equal(first.db.getTokenById(adminId), undefined);

    await first.app.close();
    first.db.close();
    // Remove from cleanup trackers so afterEach doesn't double-close.
    openApps.pop();
    openDbs.pop();

    // Second boot with the same BOOTSTRAP_TOKEN must not resurrect admin.
    const second = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });
    const names = second.db.listTokens().map((t) => t.name);
    assert.deepEqual(names, ["agent"]);
    assert.equal(second.db.getTokenByHash(hashToken(bootstrapSecret)), undefined);

    // Bootstrap secret no longer authenticates.
    const denied = await second.app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(bootstrapSecret),
    });
    assert.equal(denied.statusCode, 401);

    // Agent token still works for auth, but is not admin.
    const asAgent = await second.app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(agent.token),
    });
    assert.equal(asAgent.statusCode, 403);
    assert.equal(
      (asAgent.json() as ErrorEnvelope).error.code,
      ErrorCode.FORBIDDEN,
    );
  });

  test("seedBootstrapToken is a no-op when bootstrap token is empty", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    assert.equal(seedBootstrapToken(db, ""), false);
    assert.equal(db.listTokens().length, 0);
    assert.equal(existsSync(path.join(dataDir, BOOTSTRAP_SEEDED_MARKER)), false);
  });
});

describe("Bearer auth rejection", () => {
  test("missing, malformed, invalid, and revoked tokens return 401 envelope", async () => {
    const dataDir = tempDataDir();
    const bootstrapSecret = "admin-secret";
    const { app, db } = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });

    const cases: Array<{ name: string; headers?: Record<string, string> }> = [
      { name: "missing header" },
      { name: "empty bearer", headers: { authorization: "Bearer " } },
      { name: "malformed scheme", headers: { authorization: "Token abc" } },
      { name: "no space", headers: { authorization: "Bearerabc" } },
      {
        name: "invalid secret",
        headers: bearer("totally-wrong-secret"),
      },
    ];

    for (const c of cases) {
      const res = await app.inject({
        method: "GET",
        url: "/api/tokens",
        headers: c.headers,
      });
      assert.equal(res.statusCode, 401, c.name);
      const body = res.json() as ErrorEnvelope;
      assert.equal(body.error.code, ErrorCode.UNAUTHORIZED, c.name);
      assert.equal(typeof body.error.message, "string", c.name);
    }

    // Revoke admin, then reuse the same secret → 401.
    const adminId = db.listTokens()[0]!.id;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${adminId}`,
      headers: bearer(bootstrapSecret),
    });
    assert.equal(del.statusCode, 204);

    const reuse = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(bootstrapSecret),
    });
    assert.equal(reuse.statusCode, 401);
    assert.equal(
      (reuse.json() as ErrorEnvelope).error.code,
      ErrorCode.UNAUTHORIZED,
    );
  });
});

describe("token lifecycle", () => {
  test("bootstrap → mint → use → revoke → reuse-after-revoke", async () => {
    const dataDir = tempDataDir();
    const bootstrapSecret = "lifecycle-admin";
    const { app, db } = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });

    // Mint a named agent token.
    const mint = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        ...bearer(bootstrapSecret),
        "content-type": "application/json",
      },
      payload: { name: "coder" },
    });
    assert.equal(mint.statusCode, 201);
    const created = mint.json() as TokenCreated;
    assert.equal(created.name, "coder");
    assert.equal(typeof created.id, "string");
    assert.equal(typeof created.token, "string");
    assert.ok(created.token.length > 0);
    assert.equal(typeof created.createdAt, "string");
    assert.equal(created.lastUsed, null);
    // Secret is stored hashed only.
    assert.equal(db.getTokenById(created.id)?.token_hash, hashToken(created.token));
    assert.notEqual(db.getTokenById(created.id)?.token_hash, created.token);

    // List never returns the secret or hash.
    const list = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(bootstrapSecret),
    });
    assert.equal(list.statusCode, 200);
    const listBody = list.json() as { tokens: TokenInfo[] };
    assert.equal(listBody.tokens.length, 2);
    const raw = list.body;
    assert.ok(!raw.includes(created.token), "list must not contain mint secret");
    assert.ok(
      !raw.includes(bootstrapSecret),
      "list must not contain bootstrap secret",
    );
    assert.ok(!raw.includes("token_hash"), "list must not contain hash field");
    for (const t of listBody.tokens) {
      assert.equal("token" in t, false);
      assert.equal("token_hash" in t, false);
      assert.ok("id" in t && "name" in t && "createdAt" in t && "lastUsed" in t);
    }

    // Non-admin token authenticates but cannot manage tokens.
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        ...bearer(created.token),
        "content-type": "application/json",
      },
      payload: { name: "other" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(
      (forbidden.json() as ErrorEnvelope).error.code,
      ErrorCode.FORBIDDEN,
    );

    const forbiddenList = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(created.token),
    });
    assert.equal(forbiddenList.statusCode, 403);

    // Revoke the agent token.
    const rev = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${created.id}`,
      headers: bearer(bootstrapSecret),
    });
    assert.equal(rev.statusCode, 204);
    assert.equal(db.getTokenById(created.id), undefined);

    // Reuse after revoke → 401.
    const after = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(created.token),
    });
    assert.equal(after.statusCode, 401);
    assert.equal(
      (after.json() as ErrorEnvelope).error.code,
      ErrorCode.UNAUTHORIZED,
    );
  });

  test("lastUsed is updated asynchronously after a successful request", async () => {
    const dataDir = tempDataDir();
    const bootstrapSecret = "touch-admin";
    const { app, db } = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });

    const admin = db.listTokens()[0]!;
    assert.equal(admin.last_used_at, null);

    const res = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(bootstrapSecret),
    });
    assert.equal(res.statusCode, 200);

    // Not required to be set on the critical path; wait for setImmediate.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const touched = db.getTokenById(admin.id);
    assert.equal(typeof touched?.last_used_at, "string");
    assert.ok(touched!.last_used_at!.length > 0);
  });

  test("DELETE unknown token returns 404 envelope", async () => {
    const dataDir = tempDataDir();
    const bootstrapSecret = "admin-del";
    const { app } = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tokens/does-not-exist",
      headers: bearer(bootstrapSecret),
    });
    assert.equal(res.statusCode, 404);
    assert.equal(
      (res.json() as ErrorEnvelope).error.code,
      ErrorCode.NOT_FOUND,
    );
  });

  test("duplicate token name returns 409", async () => {
    const dataDir = tempDataDir();
    const bootstrapSecret = "admin-dup";
    const { app } = await buildAuthApp({
      dataDir,
      bootstrapToken: bootstrapSecret,
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        ...bearer(bootstrapSecret),
        "content-type": "application/json",
      },
      payload: { name: "dup" },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        ...bearer(bootstrapSecret),
        "content-type": "application/json",
      },
      payload: { name: "dup" },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(
      (second.json() as ErrorEnvelope).error.code,
      ErrorCode.CONFLICT,
    );
  });
});
