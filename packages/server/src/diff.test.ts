/**
 * Diff endpoint + conflict-with-diff tests (issue #17).
 *
 * Critical acceptance: a rejected push's 409 body alone carries the
 * classified changes with resolved labels — no follow-up GET required.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { diffScenes, formatDiff, isEmptyDiff, type SceneDiff } from "@excalidraw-collab/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import { DiffCache, SceneDiffService } from "./diff.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import { FileStore } from "./files.js";
import type { ConflictDetails } from "./versions.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-diff-"));
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

async function buildDiffApp(opts: {
  dataDir: string;
  bootstrapToken: string;
  diffs?: SceneDiffService;
}): Promise<{
  app: FastifyInstance;
  db: Database;
  store: FileStore;
  diffs: SceneDiffService;
}> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const config = testConfig({
    dataDir: opts.dataDir,
    bootstrapToken: opts.bootstrapToken,
  });
  const store = new FileStore(opts.dataDir, config.maxFileBytes);
  const diffs = opts.diffs ?? new SceneDiffService(db, store);
  const app = await buildApp({
    config,
    db,
    fileStore: store,
    diffs,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });
  openApps.push(app);
  return { app, db, store, diffs };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Minimal rectangle accepted by normalizeScene. */
function rect(
  id: string,
  opts: { x?: number; y?: number; versionNonce?: number } = {},
): Record<string, unknown> {
  return {
    id,
    type: "rectangle",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
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
    versionNonce: opts.versionNonce ?? 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

/**
 * Free text element — its own `text` is the resolved label in diffs.
 * Used so 409 bodies can be asserted for classified changes *with labels*.
 */
function textEl(
  id: string,
  text: string,
  opts: { x?: number; y?: number; versionNonce?: number } = {},
): Record<string, unknown> {
  return {
    id,
    type: "text",
    x: opts.x ?? 10,
    y: opts.y ?? 10,
    width: 120,
    height: 25,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 2,
    version: 1,
    versionNonce: opts.versionNonce ?? 2,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

async function createScene(
  app: FastifyInstance,
  token: string,
  name = "Architecture",
  slug = "arch",
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/scenes",
    headers: bearer(token),
    payload: { name, slug },
  });
  assert.equal(res.statusCode, 201, res.body);
}

async function pushScene(
  app: FastifyInstance,
  token: string,
  body: {
    parentVersion: number;
    elements: unknown[];
    appState?: unknown;
    message: string;
  },
  opts: { force?: boolean; slug?: string } = {},
) {
  const slug = opts.slug ?? "arch";
  const qs = opts.force ? "?force=true" : "";
  return app.inject({
    method: "POST",
    url: `/api/scenes/${slug}/scene${qs}`,
    headers: bearer(token),
    payload: body,
  });
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

// ---------------------------------------------------------------------------
// 409 conflict body carries the diff (the whole point of this issue)
// ---------------------------------------------------------------------------

describe("409 conflict-with-diff", () => {
  test("stale push 409 body alone contains classified changes with labels", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-409-labels";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    // v1: empty-ish base the agent pulled from.
    const v1 = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("base")],
      message: "v1 base",
    });
    assert.equal(v1.statusCode, 201, v1.body);

    // v2: the other side's turn — adds a labeled text element.
    const v2 = await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("base"), textEl("lbl", "Auth Service")],
      message: "v2 human added Auth Service",
    });
    assert.equal(v2.statusCode, 201, v2.body);

    // Agent still on parentVersion 1 → rejected. The 409 body must explain
    // what landed in v2 without any second request.
    const stale = await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("base"), rect("agent-box")],
      message: "stale agent push",
    });
    assert.equal(stale.statusCode, 409, stale.body);
    const env = stale.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.CONFLICT);

    const details = env.error.details as ConflictDetails;
    assert.equal(details.code, "conflict");
    assert.equal(details.head, 2);
    assert.equal(details.parentVersion, 1);
    assert.ok(details.diff, "409 must include diff");
    assert.equal(details.diff.from, 1);
    assert.equal(details.diff.to, 2);
    assert.equal(details.diff.summary.added, 1);
    assert.equal(details.diff.summary.deleted, 0);

    const added = details.diff.elements.filter((c) => c.op === "add");
    assert.equal(added.length, 1);
    assert.equal(added[0]!.id, "lbl");
    assert.equal(added[0]!.type, "text");
    assert.equal(
      added[0]!.label,
      "Auth Service",
      "resolved label must appear in the 409 body itself",
    );
    assert.match(added[0]!.describe, /Auth Service/);
  });

  test("conflict from parentVersion 0 diffs empty base → head", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-409-from-zero";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    assert.equal(
      (
        await pushScene(app, token, {
          parentVersion: 0,
          elements: [textEl("t", "Retry Queue")],
          message: "v1",
        })
      ).statusCode,
      201,
    );

    const stale = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("other")],
      message: "stale",
    });
    assert.equal(stale.statusCode, 409);
    const details = (stale.json() as ErrorEnvelope).error.details as ConflictDetails;
    assert.equal(details.parentVersion, 0);
    assert.equal(details.head, 1);
    assert.equal(details.diff.summary.added, 1);
    assert.equal(details.diff.elements[0]!.label, "Retry Queue");
  });
});

// ---------------------------------------------------------------------------
// GET /api/scenes/:slug/diff
// ---------------------------------------------------------------------------

describe("GET /api/scenes/:slug/diff", () => {
  test("returns SceneDiff JSON for absolute refs", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-json";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("a"), textEl("b", "Worker")],
      message: "v2",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=2",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    const diff = res.json() as SceneDiff;
    assert.equal(diff.from, 1);
    assert.equal(diff.to, 2);
    assert.equal(diff.summary.added, 1);
    assert.equal(diff.elements[0]!.label, "Worker");
  });

  test("accepts head and head~N refs", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-head-refs";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    for (let i = 0; i < 3; i++) {
      const res = await pushScene(app, token, {
        parentVersion: i,
        elements: [rect(`e${i}`, { versionNonce: i + 1 })],
        message: `v${i + 1}`,
      });
      assert.equal(res.statusCode, 201, res.body);
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=head~2&to=head",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    const diff = res.json() as SceneDiff;
    // head=3 → from=1, to=3
    assert.equal(diff.from, 1);
    assert.equal(diff.to, 3);
    assert.ok(diff.summary.added + diff.summary.deleted + diff.summary.updated > 0);
  });

  test("diff of a version against itself is empty", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-self";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a"), textEl("t", "X")],
      message: "v1",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=1",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    const diff = res.json() as SceneDiff;
    assert.equal(diff.from, 1);
    assert.equal(diff.to, 1);
    assert.ok(isEmptyDiff(diff), `expected empty self-diff, got ${JSON.stringify(diff)}`);
  });

  test("?format=text matches formatDiff exactly", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-text";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a", { x: 0, y: 0 })],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("a", { x: 50, y: 0, versionNonce: 9 }), textEl("note", "Cache")],
      message: "v2",
    });

    const jsonRes = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=2",
      headers: bearer(token),
    });
    assert.equal(jsonRes.statusCode, 200, jsonRes.body);
    const structured = jsonRes.json() as SceneDiff;

    const textRes = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=2&format=text",
      headers: bearer(token),
    });
    assert.equal(textRes.statusCode, 200, textRes.body);
    assert.match(textRes.headers["content-type"] ?? "", /text\/plain/);
    assert.equal(textRes.body, formatDiff(structured));
  });

  test("from=0 diffs empty base against a version", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-from-zero";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [textEl("t", "Hello")],
      message: "v1",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=0&to=1",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    const diff = res.json() as SceneDiff;
    assert.equal(diff.summary.added, 1);
    assert.equal(diff.elements[0]!.label, "Hello");
  });

  test("missing from/to returns 400 VALIDATION", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-missing-qs";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?to=1",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as ErrorEnvelope).error.code, ErrorCode.VALIDATION);
  });

  test("unknown scene returns 404", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-no-scene";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/nope/diff?from=1&to=2",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
  });

  test("out-of-range version returns 404", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-oor";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=9",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
  });

  test("unauthenticated request returns 401", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-auth";
    const { app } = await buildDiffApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=0&to=0",
    });
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// Cache: no recompute on hit; bounded eviction
// ---------------------------------------------------------------------------

describe("diff cache integration", () => {
  test("repeat GET /diff does not recompute", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-cache-hit";
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const config = testConfig({ dataDir, bootstrapToken: token });
    const store = new FileStore(dataDir, config.maxFileBytes);
    const diffs = new SceneDiffService(db, store, new DiffCache(64));
    const app = await buildApp({
      config,
      db,
      fileStore: store,
      diffs,
      readinessCheck: () => db.isHealthy(),
      fastifyOpts: { logger: false },
    });
    openApps.push(app);

    await createScene(app, token);
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("a"), rect("b")],
      message: "v2",
    });

    assert.equal(diffs.computeCount, 0);

    const first = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=2",
      headers: bearer(token),
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(diffs.computeCount, 1, "first request must compute once");

    const second = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=2",
      headers: bearer(token),
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(diffs.computeCount, 1, "repeat request must be a cache hit (no recompute)");
    assert.deepEqual(second.json(), first.json());
  });

  test("409 conflict and GET /diff share the cache", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-shared-cache";
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const config = testConfig({ dataDir, bootstrapToken: token });
    const store = new FileStore(dataDir, config.maxFileBytes);
    const diffs = new SceneDiffService(db, store, new DiffCache(64));
    const app = await buildApp({
      config,
      db,
      fileStore: store,
      diffs,
      readinessCheck: () => db.isHealthy(),
      fastifyOpts: { logger: false },
    });
    openApps.push(app);

    await createScene(app, token);
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [textEl("t", "A")],
      message: "v1",
    });

    // Stale push → 409 computes parent 0 → head 1.
    const stale = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("x")],
      message: "stale",
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(diffs.computeCount, 1);

    // Same pair via GET /diff must hit the cache.
    const get = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=0&to=1",
      headers: bearer(token),
    });
    assert.equal(get.statusCode, 200);
    assert.equal(diffs.computeCount, 1, "GET after 409 must not recompute");
    const from409 = ((stale.json() as ErrorEnvelope).error.details as ConflictDetails).diff;
    assert.deepEqual(get.json(), from409);
  });

  test("bounded cache evicts rather than growing forever", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-cache-evict";
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const config = testConfig({ dataDir, bootstrapToken: token });
    const store = new FileStore(dataDir, config.maxFileBytes);
    // Tiny bound so we can force eviction with a few versions.
    const cache = new DiffCache(2);
    const diffs = new SceneDiffService(db, store, cache);
    const app = await buildApp({
      config,
      db,
      fileStore: store,
      diffs,
      readinessCheck: () => db.isHealthy(),
      fastifyOpts: { logger: false },
    });
    openApps.push(app);

    await createScene(app, token);
    // Commit 4 versions so we have pairs (1,2), (2,3), (3,4).
    for (let i = 0; i < 4; i++) {
      const res = await pushScene(app, token, {
        parentVersion: i,
        elements: [rect(`e${i}`, { versionNonce: i + 10 })],
        message: `v${i + 1}`,
      });
      assert.equal(res.statusCode, 201, res.body);
    }

    const pairs = [
      [1, 2],
      [2, 3],
      [3, 4],
    ] as const;
    for (const [from, to] of pairs) {
      const res = await app.inject({
        method: "GET",
        url: `/api/scenes/arch/diff?from=${from}&to=${to}`,
        headers: bearer(token),
      });
      assert.equal(res.statusCode, 200, res.body);
    }

    assert.ok(
      cache.size <= cache.maxSize,
      `cache size ${cache.size} must not exceed max ${cache.maxSize}`,
    );
    assert.equal(cache.size, 2);
    // Oldest pair (1,2) should have been evicted after three inserts.
    assert.equal(diffs.computeCount, 3);

    // Re-request the oldest pair: must recompute (was evicted).
    const again = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/diff?from=1&to=2",
      headers: bearer(token),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(diffs.computeCount, 4, "evicted entry must recompute on next request");
    assert.ok(cache.size <= 2);
  });
});

// ---------------------------------------------------------------------------
// formatDiff parity unit (no HTTP): ensure service output matches core
// ---------------------------------------------------------------------------

describe("SceneDiffService vs core", () => {
  test("diffVersions result equals diffScenes on the same documents", async () => {
    const dataDir = tempDataDir();
    const token = "diff-token-parity";
    const { app, db, diffs } = await buildDiffApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a", { x: 0 })],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("a", { x: 40, versionNonce: 7 }), textEl("t", "Svc")],
      message: "v2",
    });

    const scene = db.getSceneBySlug("arch")!;
    const viaService = diffs.diffVersions(scene.id, 1, 2, scene.head_version);

    const a = diffs.loadDocumentAtVersion(scene.id, 1, scene.head_version);
    const b = diffs.loadDocumentAtVersion(scene.id, 2, scene.head_version);
    const viaCore = diffScenes(a, b, { from: 1, to: 2 });

    assert.deepEqual(viaService, viaCore);
    assert.equal(formatDiff(viaService), formatDiff(viaCore));
  });
});
