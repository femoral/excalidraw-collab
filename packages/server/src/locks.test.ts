/**
 * Advisory turn lock tests: claim, release, expiry, restart survival,
 * push auto-release by holder only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { gzipJson, openDatabase, type Database } from "./db.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import { DEFAULT_LOCK_TTL_SECONDS, type LockInfo } from "./locks.js";
import type { SceneInfo } from "./scenes.js";
import type { PushVersionResponse } from "./versions.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-locks-"));
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

async function buildLocksApp(opts: {
  dataDir: string;
  bootstrapToken: string;
}): Promise<{ app: FastifyInstance; db: Database }> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const app = await buildApp({
    config: testConfig({
      dataDir: opts.dataDir,
      bootstrapToken: opts.bootstrapToken,
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

async function createAgentToken(
  app: FastifyInstance,
  adminToken: string,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/tokens",
    headers: bearer(adminToken),
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { token: string };
  return body.token;
}

async function createScene(
  app: FastifyInstance,
  token: string,
  name: string,
  slug: string,
): Promise<SceneInfo> {
  const res = await app.inject({
    method: "POST",
    url: "/api/scenes",
    headers: bearer(token),
    payload: { name, slug },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as SceneInfo;
}

async function pushScene(
  app: FastifyInstance,
  token: string,
  slug: string,
  parentVersion: number,
  message: string,
): Promise<{ status: number; body: PushVersionResponse | ErrorEnvelope }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/scenes/${encodeURIComponent(slug)}/scene`,
    headers: bearer(token),
    payload: {
      parentVersion,
      elements: [],
      message,
    },
  });
  return {
    status: res.statusCode,
    body: res.json() as PushVersionResponse | ErrorEnvelope,
  };
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

describe("POST /api/scenes/:slug/lock", () => {
  test("claims the turn for the calling token identity (not body.holder)", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-claim";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    const agent = await createAgentToken(app, admin, "claude-code");
    await createScene(app, admin, "Arch", "arch");

    const res = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(agent),
      // Client-supplied holder must be ignored.
      payload: { ttl: 600, holder: "spoofed-name" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const lock = res.json() as LockInfo;
    assert.equal(lock.holder, "claude-code");
    assert.ok(lock.expiresAt);
    const expires = Date.parse(lock.expiresAt);
    assert.ok(expires > Date.now());
    // ~10 min TTL (± a few seconds of slack)
    assert.ok(expires - Date.now() < 610_000);
    assert.ok(expires - Date.now() > 590_000);

    const meta = await app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(admin),
    });
    const scene = meta.json() as SceneInfo;
    assert.equal(scene.lock?.holder, "claude-code");
  });

  test("defaults ttl to 30 minutes", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-default-ttl";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    await createScene(app, admin, "Arch", "arch");

    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    const lock = res.json() as LockInfo;
    const expires = Date.parse(lock.expiresAt);
    const expected = before + DEFAULT_LOCK_TTL_SECONDS * 1000;
    // Allow a few seconds of clock skew / request latency.
    assert.ok(Math.abs(expires - expected) < 5_000);
  });

  test("same holder may re-claim to refresh TTL", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-refresh";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    await createScene(app, admin, "Arch", "arch");

    const first = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: { ttl: 60 },
    });
    assert.equal(first.statusCode, 200);
    const firstLock = first.json() as LockInfo;

    const second = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: { ttl: 3600 },
    });
    assert.equal(second.statusCode, 200, second.body);
    const secondLock = second.json() as LockInfo;
    assert.equal(secondLock.holder, "admin");
    assert.ok(Date.parse(secondLock.expiresAt) > Date.parse(firstLock.expiresAt));
  });

  test("active lock held by another identity returns LOCK_HELD", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-held";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    const agent = await createAgentToken(app, admin, "codex");
    await createScene(app, admin, "Arch", "arch");

    const claim = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(agent),
      payload: { ttl: 600 },
    });
    assert.equal(claim.statusCode, 200);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: { ttl: 600 },
    });
    assert.equal(conflict.statusCode, 409);
    const body = conflict.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.LOCK_HELD);
    assert.match(body.error.message, /codex/);
    const details = body.error.details as LockInfo;
    assert.equal(details.holder, "codex");
  });

  test("expired lock never blocks a claim", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-expired";
    const { app, db } = await buildLocksApp({
      dataDir,
      bootstrapToken: admin,
    });
    const agent = await createAgentToken(app, admin, "stale-bot");
    const scene = await createScene(app, admin, "Arch", "arch");

    // Plant an already-expired lock for a different holder.
    const past = new Date(Date.now() - 60_000).toISOString();
    db.setSceneLock(scene.id, "stale-bot", past);

    // Scene list must not surface the expired lock.
    const meta = await app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(admin),
    });
    assert.equal((meta.json() as SceneInfo).lock, null);

    // Claim succeeds for a different identity.
    const claim = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: { ttl: 120 },
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const lock = claim.json() as LockInfo;
    assert.equal(lock.holder, "admin");
    // And the agent token was never needed for the claim path above —
    // keep the binding so the token mint path is exercised.
    assert.ok(agent.length > 0);
  });

  test("locks survive a server restart (database state)", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-restart";
    const first = await buildLocksApp({ dataDir, bootstrapToken: admin });
    await createScene(first.app, admin, "Arch", "arch");

    const claim = await first.app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: { ttl: 1800 },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = claim.json() as LockInfo;

    // Close app + db (simulates process exit). DB file remains on disk.
    await first.app.close();
    openApps.pop();
    first.db.close();
    openDbs.pop();

    // Reopen against the same DATA_DIR — lock must still be present.
    const second = await buildLocksApp({ dataDir, bootstrapToken: admin });
    const meta = await second.app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(admin),
    });
    assert.equal(meta.statusCode, 200, meta.body);
    const scene = meta.json() as SceneInfo;
    assert.ok(scene.lock);
    assert.equal(scene.lock!.holder, "admin");
    assert.equal(scene.lock!.expiresAt, claimed.expiresAt);

    // Direct DB row still holds the columns (not in-memory).
    const row = second.db.getSceneBySlug("arch");
    assert.equal(row?.lock_holder, "admin");
    assert.equal(row?.lock_expires_at, claimed.expiresAt);
  });

  test("requires auth", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-auth";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    await createScene(app, admin, "Arch", "arch");

    const res = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      payload: { ttl: 60 },
    });
    assert.equal(res.statusCode, 401);
  });

  test("404 for unknown slug", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-404";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });

    const res = await app.inject({
      method: "POST",
      url: "/api/scenes/missing/lock",
      headers: bearer(admin),
      payload: {},
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as ErrorEnvelope).error.code, ErrorCode.NOT_FOUND);
  });
});

describe("DELETE /api/scenes/:slug/lock", () => {
  test("releases the lock (any authenticated identity)", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-release";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    const agent = await createAgentToken(app, admin, "claude-code");
    await createScene(app, admin, "Arch", "arch");

    await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(agent),
      payload: { ttl: 600 },
    });

    // Human (admin) can free a crashed-agent lock.
    const del = await app.inject({
      method: "DELETE",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
    });
    assert.equal(del.statusCode, 204);

    const meta = await app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(admin),
    });
    assert.equal((meta.json() as SceneInfo).lock, null);
  });

  test("is idempotent when free", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-idempotent";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    await createScene(app, admin, "Arch", "arch");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
    });
    assert.equal(del.statusCode, 204);
  });
});

describe("push + lock interaction", () => {
  test("successful push by the lock holder releases the lock", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-push-holder";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    await createScene(app, admin, "Arch", "arch");

    await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(admin),
      payload: { ttl: 600 },
    });

    const pushed = await pushScene(app, admin, "arch", 0, "first turn");
    assert.equal(pushed.status, 201, JSON.stringify(pushed.body));

    const meta = await app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(admin),
    });
    assert.equal((meta.json() as SceneInfo).lock, null);
  });

  test("push by someone else succeeds and leaves the lock in place", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-push-other";
    const { app } = await buildLocksApp({ dataDir, bootstrapToken: admin });
    const agent = await createAgentToken(app, admin, "claude-code");
    await createScene(app, admin, "Arch", "arch");

    // Agent claims the turn.
    const claim = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(agent),
      payload: { ttl: 600 },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = claim.json() as LockInfo;

    // Human pushes anyway — advisory, not enforcement.
    const pushed = await pushScene(app, admin, "arch", 0, "human override");
    assert.equal(pushed.status, 201, JSON.stringify(pushed.body));

    const meta = await app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(admin),
    });
    const scene = meta.json() as SceneInfo;
    assert.ok(scene.lock);
    assert.equal(scene.lock!.holder, "claude-code");
    assert.equal(scene.lock!.expiresAt, claimed.expiresAt);
  });

  test("push never returns LOCK_HELD (server is advisory-only)", async () => {
    const dataDir = tempDataDir();
    const admin = "lock-admin-no-enforce";
    const { app, db } = await buildLocksApp({
      dataDir,
      bootstrapToken: admin,
    });
    await createScene(app, admin, "Arch", "arch");

    // Force a lock via DAL so we don't need a second token for this check.
    const row = db.getSceneBySlug("arch")!;
    db.setSceneLock(row.id, "someone-else", new Date(Date.now() + 600_000).toISOString());

    const pushed = await pushScene(app, admin, "arch", 0, "still works");
    assert.equal(pushed.status, 201);
    assert.ok(!("error" in pushed.body));
  });
});

describe("Database lock helpers", () => {
  test("setSceneLock / clearSceneLockIfHolder", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);

    const scene = db.insertScene({
      id: "s1",
      slug: "s1",
      name: "S1",
    });

    const exp = new Date(Date.now() + 60_000).toISOString();
    const locked = db.setSceneLock(scene.id, "agent", exp);
    assert.equal(locked?.lock_holder, "agent");
    assert.equal(locked?.lock_expires_at, exp);

    assert.equal(db.clearSceneLockIfHolder(scene.id, "other"), false);
    assert.equal(db.getSceneById(scene.id)?.lock_holder, "agent");

    assert.equal(db.clearSceneLockIfHolder(scene.id, "agent"), true);
    assert.equal(db.getSceneById(scene.id)?.lock_holder, null);
  });

  test("commitVersion releases only when author is the holder", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);

    const scene = db.insertScene({
      id: "s2",
      slug: "s2",
      name: "S2",
    });
    const exp = new Date(Date.now() + 600_000).toISOString();
    db.setSceneLock(scene.id, "holder", exp);

    // Non-holder commit keeps the lock.
    const other = db.commitVersion({
      sceneId: scene.id,
      parentVersion: 0,
      author: "other",
      message: "other push",
      elements: gzipJson([]),
      app_state: gzipJson({}),
    });
    assert.equal(other.ok, true);
    assert.equal(db.getSceneById(scene.id)?.lock_holder, "holder");

    // Holder commit clears it.
    const mine = db.commitVersion({
      sceneId: scene.id,
      parentVersion: 1,
      author: "holder",
      message: "holder push",
      elements: gzipJson([]),
      app_state: gzipJson({}),
    });
    assert.equal(mine.ok, true);
    assert.equal(db.getSceneById(scene.id)?.lock_holder, null);
  });
});
