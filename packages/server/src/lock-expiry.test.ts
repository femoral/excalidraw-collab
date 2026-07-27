/**
 * Lock TTL expiry scheduler (issue #39): clears the DB claim and publishes
 * a multiplexed lock event so turn waiters wake without client polling.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import {
  SceneEventHub,
  type MultiplexedEventsResponse,
} from "./events.js";
import { LockExpiryScheduler } from "./lock-expiry.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-lock-exp-"));
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

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

afterEach(async () => {
  while (openApps.length > 0) {
    await openApps.pop()!.close();
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("LockExpiryScheduler", () => {
  test("expire clears lock and wakes global waiters", async () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const hub = new SceneEventHub();
    const sched = new LockExpiryScheduler(db, hub);

    const scene = db.insertScene({ id: "s1", name: "Arch", slug: "arch" });
    assert.ok(scene);
    const expiresAt = new Date(Date.now() + 40).toISOString();
    db.setSceneLock(scene.id, "human", expiresAt);
    sched.arm(scene.id, scene.slug, "human", expiresAt);
    assert.equal(sched.armedCount, 1);

    const pending = hub.waitGlobal(0, { timeoutMs: 5_000 });
    await Promise.resolve();

    const t0 = Date.now();
    const batch = await pending;
    const elapsed = Date.now() - t0;

    assert.ok(batch);
    assert.ok(batch!.length >= 1);
    const lockEv = batch!.find((e) => e.kind === "lock");
    assert.ok(lockEv, "expected lock event on expiry");
    assert.equal(lockEv!.lock, null);
    assert.equal(lockEv!.actor, "human");
    assert.ok(elapsed < 1_000, `expiry should fire ~40ms, took ${elapsed}ms`);

    const after = db.getSceneById(scene.id);
    assert.equal(after?.lock_holder, null);
    assert.equal(sched.armedCount, 0);
    sched.close();
  });

  test("disarm prevents publish after release", async () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const hub = new SceneEventHub();
    const sched = new LockExpiryScheduler(db, hub);

    const scene = db.insertScene({ id: "s1", name: "Arch", slug: "arch" });
    assert.ok(scene);
    const expiresAt = new Date(Date.now() + 30).toISOString();
    db.setSceneLock(scene.id, "human", expiresAt);
    sched.arm(scene.id, scene.slug, "human", expiresAt);
    sched.disarm(scene.id);
    db.setSceneLock(scene.id, null, null);

    const batch = await hub.waitGlobal(0, { timeoutMs: 80 });
    assert.equal(batch, null, "disarmed timer must not publish");
    sched.close();
  });
});

describe("lock TTL expiry via HTTP", () => {
  const token = "lock-expiry-bootstrap";

  test("claim with short ttl wakes multiplexed long-poll on free", async () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const events = new SceneEventHub();
    const app = await buildApp({
      config: testConfig({
        dataDir,
        bootstrapToken: token,
      }),
      db,
      events,
      eventsTimeoutMs: 5_000,
      readinessCheck: () => db.isHealthy(),
      fastifyOpts: { logger: false },
    });
    openApps.push(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "Arch", slug: "arch" },
    });
    assert.equal(create.statusCode, 201, create.body);

    // Cursor without waiting: resync path (since ahead of hub).
    const boot = await app.inject({
      method: "GET",
      url: `/api/events?since=${Number.MAX_SAFE_INTEGER}`,
      headers: bearer(token),
    });
    assert.equal(boot.statusCode, 200, boot.body);
    let cursor = (boot.json() as MultiplexedEventsResponse).cursor;

    const claim = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(token),
      payload: { ttl: 1 },
    });
    assert.equal(claim.statusCode, 200, claim.body);

    // Drain the claim event (buffered — must not long-poll).
    const afterClaim = await app.inject({
      method: "GET",
      url: `/api/events?since=${cursor}`,
      headers: bearer(token),
    });
    assert.equal(afterClaim.statusCode, 200, afterClaim.body);
    cursor = (afterClaim.json() as MultiplexedEventsResponse).cursor;
    assert.ok(
      (afterClaim.json() as MultiplexedEventsResponse).events.some(
        (e) => e.kind === "lock" && e.lock !== null,
      ),
      "expected claim event in buffer",
    );

    // Park until TTL expiry publishes lock:null.
    const t0 = Date.now();
    const pending = app.inject({
      method: "GET",
      url: `/api/events?since=${cursor}`,
      headers: bearer(token),
    });
    // Yield so the waiter registers before the ~1s timer fires.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    const res = await pending;
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(
      elapsed < 3_000,
      `expiry should wake within ~1s, took ${elapsed}ms`,
    );
    const body = res.json() as MultiplexedEventsResponse;
    const freeEv = body.events.find(
      (e) => e.kind === "lock" && e.lock === null,
    );
    assert.ok(freeEv, `expected free lock event, got ${res.body}`);
  });
});
