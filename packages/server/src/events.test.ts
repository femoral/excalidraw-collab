/**
 * Long-poll events + SceneEventHub tests (issue #24).
 *
 * Critical: notify path is asserted by concurrent inject (no sleep-and-hope),
 * idle wait costs only one setTimeout (no interval / DB poll), and close()
 * drains in-flight waiters promptly.
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
  EVENTS_TIMEOUT_MS,
  SceneEventHub,
  type MultiplexedEventsResponse,
  type SceneEventResponse,
} from "./events.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import { FileStore } from "./files.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-events-"));
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

async function buildEventsApp(opts: {
  dataDir: string;
  bootstrapToken: string;
  eventsTimeoutMs?: number;
  events?: SceneEventHub;
}): Promise<{
  app: FastifyInstance;
  db: Database;
  store: FileStore;
  events: SceneEventHub;
}> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const config = testConfig({
    dataDir: opts.dataDir,
    bootstrapToken: opts.bootstrapToken,
  });
  const store = new FileStore(opts.dataDir, config.maxFileBytes);
  const events = opts.events ?? new SceneEventHub();
  const app = await buildApp({
    config,
    db,
    fileStore: store,
    events,
    eventsTimeoutMs: opts.eventsTimeoutMs,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });
  openApps.push(app);
  return { app, db, store, events };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function rect(id: string, versionNonce = 1): Record<string, unknown> {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

async function createScene(
  app: FastifyInstance,
  token: string,
  name: string,
  slug: string,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/scenes",
    headers: bearer(token),
    payload: { name, slug },
  });
  assert.equal(res.statusCode, 201, res.body);
}

async function pushVersion(
  app: FastifyInstance,
  token: string,
  slug: string,
  parentVersion: number,
  elements: Record<string, unknown>[],
  message: string,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/scenes/${slug}/scene`,
    headers: bearer(token),
    payload: {
      parentVersion,
      elements,
      message,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
}

afterEach(async () => {
  while (openApps.length > 0) {
    const app = openApps.pop()!;
    await app.close();
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ---------------------------------------------------------------------------
// SceneEventHub unit tests
// ---------------------------------------------------------------------------

describe("SceneEventHub", () => {
  test("wait resolves immediately when getHead is already past since", async () => {
    const hub = new SceneEventHub();
    const t0 = Date.now();
    const head = await hub.wait("s1", 2, {
      timeoutMs: 5_000,
      getHead: () => 5,
    });
    const elapsed = Date.now() - t0;
    assert.equal(head, 5);
    assert.ok(elapsed < 200, `expected immediate resolve, took ${elapsed}ms`);
    assert.equal(hub.waiterCount, 0);
  });

  test("publish wakes waiters with since behind head (no sleep-and-hope)", async () => {
    const hub = new SceneEventHub();
    let head = 1;
    const pending = hub.wait("s1", 1, {
      timeoutMs: 5_000,
      getHead: () => head,
    });
    // Let the waiter register (microtask).
    await Promise.resolve();
    assert.equal(hub.waiterCount, 1);

    head = 2;
    hub.publish("s1", 2);
    const result = await pending;
    assert.equal(result, 2);
    assert.equal(hub.waiterCount, 0);
  });

  test("timeout returns null and frees the waiter", async () => {
    const hub = new SceneEventHub();
    const t0 = Date.now();
    const result = await hub.wait("s1", 0, {
      timeoutMs: 40,
      getHead: () => 0,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result, null);
    assert.ok(elapsed >= 30, `timeout too early: ${elapsed}ms`);
    assert.ok(elapsed < 500, `timeout too late: ${elapsed}ms`);
    assert.equal(hub.waiterCount, 0);
  });

  test("close drains in-flight waiters promptly", async () => {
    const hub = new SceneEventHub();
    const pending = hub.wait("s1", 0, {
      timeoutMs: 60_000,
      getHead: () => 0,
    });
    await Promise.resolve();
    assert.equal(hub.waiterCount, 1);

    const t0 = Date.now();
    hub.close();
    const result = await pending;
    const elapsed = Date.now() - t0;
    assert.equal(result, null);
    assert.ok(elapsed < 200, `close should be prompt, took ${elapsed}ms`);
    assert.equal(hub.waiterCount, 0);
  });

  test("publish does not wake waiters for a different scene", async () => {
    const hub = new SceneEventHub();
    const pending = hub.wait("scene-a", 0, {
      timeoutMs: 80,
      getHead: () => 0,
    });
    await Promise.resolve();
    hub.publish("scene-b", 1);
    const result = await pending;
    assert.equal(result, null, "other-scene publish must not resolve waiter");
  });

  test("idle wait uses no intervals and parks on a single timer", async () => {
    const hub = new SceneEventHub();
    const realSetInterval = globalThis.setInterval;
    let intervalCalls = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervalCalls += 1;
      return realSetInterval(...args);
    }) as typeof setInterval;

    try {
      const pending = hub.wait("s1", 0, {
        timeoutMs: 60,
        getHead: () => 0,
      });
      await Promise.resolve();
      assert.equal(hub.waiterCount, 1);
      // While parked: zero setInterval usage from the hub.
      assert.equal(intervalCalls, 0, "hub must not spin setInterval while idle");
      await pending;
      assert.equal(intervalCalls, 0);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

describe("GET /api/scenes/:slug/events", () => {
  const token = "events-bootstrap-token";

  test("returns immediately when since is already behind head", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");
    await pushVersion(app, token, "arch", 0, [rect("a")], "v1");
    await pushVersion(app, token, "arch", 1, [rect("a"), rect("b")], "v2");

    const t0 = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/events?since=0",
      headers: bearer(token),
    });
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 300, `expected immediate 200, took ${elapsed}ms`);
    const body = res.json() as SceneEventResponse;
    assert.equal(body.headVersion, 2);
    assert.equal(body.version, 2);
    assert.equal(body.message, "v2");
    assert.equal(typeof body.author, "string");
    assert.equal(typeof body.sceneHash, "string");
  });

  test("notify path: in-flight long-poll resolves on push (no sleep)", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");
    await pushVersion(app, token, "arch", 0, [rect("a")], "initial");

    // Start long-poll at current head (1) — should park.
    const pending = app.inject({
      method: "GET",
      url: "/api/scenes/arch/events?since=1",
      headers: bearer(token),
    });

    // Yield so the waiter is registered before we push.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const t0 = Date.now();
    await pushVersion(app, token, "arch", 1, [rect("a"), rect("b")], "second");
    const res = await pending;
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 1000, `watch/notify should react within 1s, took ${elapsed}ms`);
    const body = res.json() as SceneEventResponse;
    assert.equal(body.headVersion, 2);
    assert.equal(body.version, 2);
    assert.equal(body.message, "second");
  });

  test("times out with 204 when head does not move", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 50,
    });
    await createScene(app, token, "Arch", "arch");

    const t0 = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/events?since=0",
      headers: bearer(token),
    });
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 204, res.body);
    assert.equal(res.body, "");
    assert.ok(elapsed >= 40, `timeout too early: ${elapsed}ms`);
    assert.ok(elapsed < 800, `timeout too late: ${elapsed}ms`);
  });

  test("app.close drains in-flight long-poll (SIGTERM path)", async () => {
    const dataDir = tempDataDir();
    const { app, events } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 60_000,
    });
    await createScene(app, token, "Arch", "arch");

    const pending = app.inject({
      method: "GET",
      url: "/api/scenes/arch/events?since=0",
      headers: bearer(token),
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(events.waiterCount >= 1, "expected a registered waiter");

    const t0 = Date.now();
    // Remove from afterEach tracking so we close exactly once here.
    const idx = openApps.indexOf(app);
    if (idx >= 0) openApps.splice(idx, 1);
    await app.close();
    const res = await pending;
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 204, res.body);
    assert.ok(elapsed < 500, `shutdown drain should be prompt, took ${elapsed}ms`);
    assert.equal(events.waiterCount, 0);
  });

  test("missing since → 400 VALIDATION", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token, "Arch", "arch");

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/events",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.VALIDATION);
  });

  test("unknown scene → 404", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/nope/events?since=0",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
  });

  test("unauthenticated → 401", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/events?since=0",
    });
    assert.equal(res.statusCode, 401);
  });

  test("default timeout constant is 30 seconds", () => {
    assert.equal(EVENTS_TIMEOUT_MS, 30_000);
  });
});

// ---------------------------------------------------------------------------
// Multiplexed GET /api/events?since=N (issue #37)
// ---------------------------------------------------------------------------

describe("GET /api/events (multiplexed)", () => {
  const token = "events-mux-bootstrap-token";

  test("since cursor: returns buffered events past since immediately", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");
    await createScene(app, token, "Flow", "flow");
    await pushVersion(app, token, "arch", 0, [rect("a")], "arch-v1");
    await pushVersion(app, token, "flow", 0, [rect("b")], "flow-v1");
    await pushVersion(app, token, "arch", 1, [rect("a"), rect("c")], "arch-v2");

    const t0 = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/api/events?since=0",
      headers: bearer(token),
    });
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 300, `expected immediate 200, took ${elapsed}ms`);
    const body = res.json() as MultiplexedEventsResponse;
    assert.ok(body.events.length >= 3, `expected ≥3 events, got ${body.events.length}`);
    assert.equal(body.cursor, body.events[body.events.length - 1]!.seq);
    // Events are ordered by ascending seq.
    for (let i = 1; i < body.events.length; i++) {
      assert.ok(body.events[i]!.seq > body.events[i - 1]!.seq);
    }
    const slugs = new Set(body.events.map((e) => e.slug));
    assert.ok(slugs.has("arch"));
    assert.ok(slugs.has("flow"));
    const lastArch = [...body.events].reverse().find((e) => e.slug === "arch");
    assert.ok(lastArch);
    assert.equal(lastArch!.kind, "version");
    assert.equal(lastArch!.headVersion, 2);
    assert.equal(lastArch!.message, "arch-v2");
  });

  test("since cursor: advancing past last seq yields empty or wait", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 50,
    });
    await createScene(app, token, "Arch", "arch");
    await pushVersion(app, token, "arch", 0, [rect("a")], "v1");

    const first = await app.inject({
      method: "GET",
      url: "/api/events?since=0",
      headers: bearer(token),
    });
    assert.equal(first.statusCode, 200, first.body);
    const { cursor } = first.json() as MultiplexedEventsResponse;
    assert.ok(cursor >= 1);

    // since == cursor: nothing new → 204 timeout.
    const t0 = Date.now();
    const idle = await app.inject({
      method: "GET",
      url: `/api/events?since=${cursor}`,
      headers: bearer(token),
    });
    const elapsed = Date.now() - t0;
    assert.equal(idle.statusCode, 204, idle.body);
    assert.ok(elapsed >= 40, `timeout too early: ${elapsed}ms`);
  });

  test("since cursor resync when client is ahead of hub (restart)", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");

    const t0 = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/api/events?since=999999",
      headers: bearer(token),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 300, `resync should be immediate, took ${elapsed}ms`);
    const body = res.json() as MultiplexedEventsResponse;
    assert.equal(body.events.length, 0);
    assert.equal(body.cursor, 0);
  });

  test("notify path: in-flight multiplexed poll resolves on push", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");
    await pushVersion(app, token, "arch", 0, [rect("a")], "initial");

    // Establish cursor.
    const boot = await app.inject({
      method: "GET",
      url: "/api/events?since=0",
      headers: bearer(token),
    });
    assert.equal(boot.statusCode, 200, boot.body);
    const { cursor } = boot.json() as MultiplexedEventsResponse;

    const pending = app.inject({
      method: "GET",
      url: `/api/events?since=${cursor}`,
      headers: bearer(token),
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const t0 = Date.now();
    await pushVersion(app, token, "arch", 1, [rect("a"), rect("b")], "second");
    const res = await pending;
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 200, res.body);
    assert.ok(elapsed < 1000, `mux notify should react within 1s, took ${elapsed}ms`);
    const body = res.json() as MultiplexedEventsResponse;
    assert.ok(body.events.length >= 1);
    assert.ok(body.cursor > cursor);
    const ev = body.events[body.events.length - 1]!;
    assert.equal(ev.kind, "version");
    assert.equal(ev.slug, "arch");
    assert.equal(ev.headVersion, 2);
    assert.equal(ev.message, "second");
  });

  test("lock claim/release appear on the multiplexed stream", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");

    // Park a waiter at cursor 0 before any events exist.
    const pending = app.inject({
      method: "GET",
      url: "/api/events?since=0",
      headers: bearer(token),
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const claim = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/lock",
      headers: bearer(token),
      payload: { ttl: 120 },
    });
    assert.equal(claim.statusCode, 200, claim.body);

    const res = await pending;
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as MultiplexedEventsResponse;
    const lockEv = body.events.find((e) => e.kind === "lock");
    assert.ok(lockEv, "expected a lock event");
    assert.equal(lockEv!.slug, "arch");
    assert.ok(lockEv!.lock);
    assert.equal(lockEv!.lock!.holder, "admin");
    assert.equal(lockEv!.actor, "admin");

    // Release fans out too.
    const cursor2 = body.cursor;
    const pending2 = app.inject({
      method: "GET",
      url: `/api/events?since=${cursor2}`,
      headers: bearer(token),
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const rel = await app.inject({
      method: "DELETE",
      url: "/api/scenes/arch/lock",
      headers: bearer(token),
    });
    assert.equal(rel.statusCode, 204, rel.body);
    const res2 = await pending2;
    assert.equal(res2.statusCode, 200, res2.body);
    const body2 = res2.json() as MultiplexedEventsResponse;
    const unlockEv = body2.events.find((e) => e.kind === "lock");
    assert.ok(unlockEv);
    assert.equal(unlockEv!.lock, null);
  });

  test("per-scene endpoint still works unchanged alongside multiplexed", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
      eventsTimeoutMs: 5_000,
    });
    await createScene(app, token, "Arch", "arch");
    await pushVersion(app, token, "arch", 0, [rect("a")], "v1");

    const perScene = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/events?since=0",
      headers: bearer(token),
    });
    assert.equal(perScene.statusCode, 200, perScene.body);
    const pe = perScene.json() as SceneEventResponse;
    assert.equal(pe.headVersion, 1);
    assert.equal(pe.message, "v1");

    const mux = await app.inject({
      method: "GET",
      url: "/api/events?since=0",
      headers: bearer(token),
    });
    assert.equal(mux.statusCode, 200, mux.body);
    const me = mux.json() as MultiplexedEventsResponse;
    assert.ok(me.events.some((e) => e.kind === "version" && e.slug === "arch"));
  });

  test("missing since → 400 VALIDATION", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/events",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.VALIDATION);
  });

  test("unauthenticated → 401", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildEventsApp({
      dataDir,
      bootstrapToken: token,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/events?since=0",
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("SceneEventHub global waiters", () => {
  test("waitGlobal resolves immediately when buffer is past since", async () => {
    const hub = new SceneEventHub();
    hub.publishVersion({
      sceneId: "s1",
      slug: "arch",
      headVersion: 1,
      version: {
        version: 1,
        parentVersion: null,
        author: "a",
        message: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        elementCount: 1,
        sceneHash: "h",
        thumbnailFileId: null,
      },
      lock: null,
    });
    const t0 = Date.now();
    const batch = await hub.waitGlobal(0, { timeoutMs: 5_000 });
    const elapsed = Date.now() - t0;
    assert.ok(batch);
    assert.equal(batch!.length, 1);
    assert.equal(batch![0]!.slug, "arch");
    assert.ok(elapsed < 200);
    assert.equal(hub.globalWaiterCount, 0);
  });

  test("publishLock wakes global waiters without scene waiters", async () => {
    const hub = new SceneEventHub();
    const scenePending = hub.wait("s1", 0, {
      timeoutMs: 80,
      getHead: () => 0,
    });
    const globalPending = hub.waitGlobal(0, { timeoutMs: 5_000 });
    await Promise.resolve();
    assert.equal(hub.waiterCount, 1);
    assert.equal(hub.globalWaiterCount, 1);

    hub.publishLock({
      sceneId: "s1",
      slug: "arch",
      headVersion: 0,
      lock: { holder: "agent", expiresAt: "2099-01-01T00:00:00.000Z" },
      actor: "agent",
    });

    const global = await globalPending;
    assert.ok(global);
    assert.equal(global![0]!.kind, "lock");
    assert.equal(global![0]!.lock?.holder, "agent");

    const scene = await scenePending;
    assert.equal(scene, null, "lock must not wake per-scene version waiters");
  });
});
