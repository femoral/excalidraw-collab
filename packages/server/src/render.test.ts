/**
 * Render endpoints + per-version cache (issue #26).
 *
 * Critical acceptance criteria (all asserted without Chromium):
 *   - second request for same version+options does not invoke the worker
 *   - RENDER_WORKER=off → 501 with actionable message
 *   - matching If-None-Match → 304
 *   - concurrent distinct renders respect the worker concurrency cap
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
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import { FileStore, IMMUTABLE_CACHE_CONTROL } from "./files.js";
import {
  etagMatches,
  parseRenderDark,
  parseRenderScale,
  SceneRenderService,
  type SceneRenderWorker,
} from "./render.js";
import { RenderCache } from "./render-cache.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

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
      // ignore
    }
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-render-"));
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

/** Fake PNG-ish payload whose content encodes call metadata. */
function fakePng(label: string): Uint8Array {
  const payload = Buffer.from(`PNG:${label}`, "utf8");
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, payload]);
}

function fakeSvg(label: string): Uint8Array {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>`,
    "utf8",
  );
}

type MockWorker = SceneRenderWorker & {
  /** Times `render` completed its acquire (worker was invoked). */
  readonly callCount: number;
  /** Peak concurrent in-flight renders. */
  readonly maxConcurrent: number;
  /** Current in-flight count. */
  readonly concurrent: number;
  readonly calls: ReadonlyArray<{
    format: string;
    scale?: number;
    darkMode?: boolean;
  }>;
};

/**
 * Mock worker that optionally enforces a concurrency cap (like the real
 * Playwright pool) and records every invocation for cache assertions.
 */
function createMockWorker(opts: {
  concurrency?: number;
  delayMs?: number;
} = {}): MockWorker {
  const concurrency = opts.concurrency ?? Infinity;
  const delayMs = opts.delayMs ?? 0;
  let active = 0;
  let maxConcurrent = 0;
  let callCount = 0;
  const calls: Array<{
    format: string;
    scale?: number;
    darkMode?: boolean;
  }> = [];
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        resolve();
      });
    });
  }

  function release(): void {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  return {
    get callCount() {
      return callCount;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    get concurrent() {
      return active;
    },
    get calls() {
      return calls;
    },
    async render(request) {
      await acquire();
      callCount += 1;
      calls.push({
        format: request.format,
        scale: request.options?.scale,
        darkMode: request.options?.darkMode,
      });
      try {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        const label = `${request.format}:s${request.options?.scale ?? 1}:d${request.options?.darkMode ? 1 : 0}:n${request.scene.elements.length}`;
        const bytes =
          request.format === "png" ? fakePng(label) : fakeSvg(label);
        return {
          bytes,
          mimeType:
            request.format === "png"
              ? ("image/png" as const)
              : ("image/svg+xml" as const),
          format: request.format,
        };
      } finally {
        release();
      }
    },
    async close() {
      // no-op
    },
  };
}

async function buildRenderApp(opts: {
  dataDir: string;
  bootstrapToken: string;
  renderWorker?: SceneRenderWorker | null;
  renderWorkerMode?: "on" | "off";
  renders?: SceneRenderService;
}): Promise<{
  app: FastifyInstance;
  db: Database;
  store: FileStore;
  worker: MockWorker | null;
  renders: SceneRenderService;
}> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const config = testConfig({
    dataDir: opts.dataDir,
    bootstrapToken: opts.bootstrapToken,
    renderWorker: opts.renderWorkerMode ?? "on",
  });
  const store = new FileStore(opts.dataDir, config.maxFileBytes);

  let worker: MockWorker | null = null;
  let renderWorker: SceneRenderWorker | null;
  if (opts.renderWorker !== undefined) {
    renderWorker = opts.renderWorker;
    if (opts.renderWorker && "callCount" in opts.renderWorker) {
      worker = opts.renderWorker as MockWorker;
    }
  } else if (opts.renders) {
    renderWorker = opts.renders.worker;
  } else if ((opts.renderWorkerMode ?? "on") === "off") {
    renderWorker = null;
  } else {
    worker = createMockWorker();
    renderWorker = worker;
  }

  const renders =
    opts.renders ??
    new SceneRenderService(
      db,
      store,
      renderWorker,
      new RenderCache(opts.dataDir),
      opts.dataDir,
    );

  const app = await buildApp({
    config,
    db,
    fileStore: store,
    renders,
    renderWorker,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });
  openApps.push(app);
  return { app, db, store, worker, renders };
}

async function createSceneWithVersion(
  app: FastifyInstance,
  token: string,
  slug: string,
  elements: Record<string, unknown>[] = [rect("a")],
): Promise<void> {
  const created = await app.inject({
    method: "POST",
    url: "/api/scenes",
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: { name: slug, slug },
  });
  assert.equal(created.statusCode, 201, created.body);

  const pushed = await app.inject({
    method: "POST",
    url: `/api/scenes/${slug}/scene`,
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: {
      parentVersion: 0,
      elements,
      message: "initial",
    },
  });
  assert.equal(pushed.statusCode, 201, pushed.body);
}

describe("parse helpers", () => {
  test("parseRenderScale defaults and validates", () => {
    assert.equal(parseRenderScale(undefined), 1);
    assert.equal(parseRenderScale("2"), 2);
    assert.equal(parseRenderScale(0.5), 0.5);
    assert.throws(() => parseRenderScale("0"), /scale/);
    assert.throws(() => parseRenderScale("-1"), /scale/);
    assert.throws(() => parseRenderScale("9"), /scale/);
  });

  test("parseRenderDark defaults and validates", () => {
    assert.equal(parseRenderDark(undefined), false);
    assert.equal(parseRenderDark("1"), true);
    assert.equal(parseRenderDark("true"), true);
    assert.equal(parseRenderDark("0"), false);
    assert.throws(() => parseRenderDark("maybe"), /dark/);
  });

  test("etagMatches handles lists, weak tags, and wildcard", () => {
    const etag = '"abc123"';
    assert.equal(etagMatches(undefined, etag), false);
    assert.equal(etagMatches(etag, etag), true);
    assert.equal(etagMatches("abc123", etag), true);
    assert.equal(etagMatches(`W/${etag}`, etag), true);
    assert.equal(etagMatches(`"other", ${etag}`, etag), true);
    assert.equal(etagMatches("*", etag), true);
    assert.equal(etagMatches('"nope"', etag), false);
  });
});

describe("GET /api/scenes/:slug/render.{png,svg}", () => {
  test("RENDER_WORKER=off returns 501 with actionable message and never calls a worker", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-off";
    const spy = createMockWorker();
    // Explicit null worker + off mode — routes must not touch spy.
    const { app } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
      renderWorker: null,
      renderWorkerMode: "off",
    });

    await createSceneWithVersion(app, token, "off-scene");

    for (const ext of ["png", "svg"] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/api/scenes/off-scene/render.${ext}`,
        headers: bearer(token),
      });
      assert.equal(res.statusCode, 501, res.body);
      const body = res.json() as ErrorEnvelope;
      assert.equal(body.error.code, ErrorCode.NOT_IMPLEMENTED);
      assert.match(body.error.message, /RENDER_WORKER/i);
      assert.match(body.error.message, /off/i);
    }
    assert.equal(spy.callCount, 0);
  });

  test("default off config (no injected worker) yields 501 without importing a worker", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-default-off";
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const config = testConfig({
      dataDir,
      bootstrapToken: token,
      renderWorker: "off",
    });
    const store = new FileStore(dataDir, config.maxFileBytes);
    const app = await buildApp({
      config,
      db,
      fileStore: store,
      // Do not inject renderWorker — resolve path must stay null.
      readinessCheck: () => db.isHealthy(),
      fastifyOpts: { logger: false },
    });
    openApps.push(app);

    await createSceneWithVersion(app, token, "default-off");
    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/default-off/render.png",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 501);
    assert.equal(app.renders?.worker, null);
    assert.equal(app.renders?.renderCount, 0);
  });

  test("second request for same version+options is served from cache without invoking the worker", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-cache";
    const { app, worker, renders } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
    });
    assert.ok(worker);

    await createSceneWithVersion(app, token, "cached");

    const first = await app.inject({
      method: "GET",
      url: "/api/scenes/cached/render.png?scale=2&dark=1",
      headers: bearer(token),
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers["content-type"], "image/png");
    assert.equal(first.headers["cache-control"], IMMUTABLE_CACHE_CONTROL);
    assert.ok(first.headers["etag"]);
    assert.equal(worker.callCount, 1);
    assert.equal(renders.renderCount, 1);
    const body1 = Buffer.from(first.rawPayload);

    const second = await app.inject({
      method: "GET",
      url: "/api/scenes/cached/render.png?scale=2&dark=1",
      headers: bearer(token),
    });
    assert.equal(second.statusCode, 200);
    assert.equal(worker.callCount, 1, "worker must not run on cache hit");
    assert.equal(renders.renderCount, 1);
    assert.deepEqual(Buffer.from(second.rawPayload), body1);
    assert.equal(second.headers["etag"], first.headers["etag"]);
  });

  test("different options or formats miss the cache and re-render", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-opts";
    const { app, worker } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
    });
    assert.ok(worker);
    await createSceneWithVersion(app, token, "opts");

    await app.inject({
      method: "GET",
      url: "/api/scenes/opts/render.png",
      headers: bearer(token),
    });
    await app.inject({
      method: "GET",
      url: "/api/scenes/opts/render.png?scale=2",
      headers: bearer(token),
    });
    await app.inject({
      method: "GET",
      url: "/api/scenes/opts/render.png?dark=true",
      headers: bearer(token),
    });
    await app.inject({
      method: "GET",
      url: "/api/scenes/opts/render.svg",
      headers: bearer(token),
    });
    assert.equal(worker.callCount, 4);
  });

  test("If-None-Match matching ETag returns 304 without body", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-etag";
    const { app, worker } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
    });
    assert.ok(worker);
    await createSceneWithVersion(app, token, "etag-scene");

    const first = await app.inject({
      method: "GET",
      url: "/api/scenes/etag-scene/render.png",
      headers: bearer(token),
    });
    assert.equal(first.statusCode, 200);
    const etag = first.headers["etag"];
    assert.ok(typeof etag === "string" && etag.length > 0);

    const second = await app.inject({
      method: "GET",
      url: "/api/scenes/etag-scene/render.png",
      headers: {
        ...bearer(token),
        "if-none-match": etag,
      },
    });
    assert.equal(second.statusCode, 304);
    assert.equal(second.headers["etag"], etag);
    assert.equal(second.headers["cache-control"], IMMUTABLE_CACHE_CONTROL);
    assert.equal(second.body, "");
    // Cache hit path for 304 — worker still only once.
    assert.equal(worker.callCount, 1);
  });

  test("concurrent identical requests coalesce to a single worker call", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-coalesce";
    const mock = createMockWorker({ delayMs: 40 });
    const { app, renders } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
      renderWorker: mock,
    });
    await createSceneWithVersion(app, token, "coalesce");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "GET",
          url: "/api/scenes/coalesce/render.png",
          headers: bearer(token),
        }),
      ),
    );
    for (const res of results) {
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.equal(mock.callCount, 1);
    assert.equal(renders.renderCount, 1);
  });

  test("burst of distinct renders does not exceed the worker concurrency cap", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-cap";
    const cap = 2;
    const mock = createMockWorker({ concurrency: cap, delayMs: 30 });
    const { app } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
      renderWorker: mock,
    });

    // Create several scenes so each request is a distinct cache key.
    const slugs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const slug = `cap-${i}`;
      slugs.push(slug);
      await createSceneWithVersion(app, token, slug, [
        rect(`el-${i}`, { versionNonce: i + 1 }),
      ]);
    }

    const results = await Promise.all(
      slugs.map((slug) =>
        app.inject({
          method: "GET",
          url: `/api/scenes/${slug}/render.png`,
          headers: bearer(token),
        }),
      ),
    );
    for (const res of results) {
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.equal(mock.callCount, 6);
    assert.ok(
      mock.maxConcurrent <= cap,
      `maxConcurrent ${mock.maxConcurrent} exceeded cap ${cap}`,
    );
    assert.ok(mock.maxConcurrent >= 1);
  });

  test("missing scene → 404; unauthenticated → 401", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-auth";
    const { app } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
    });

    const unauth = await app.inject({
      method: "GET",
      url: "/api/scenes/nope/render.png",
    });
    assert.equal(unauth.statusCode, 401);

    const missing = await app.inject({
      method: "GET",
      url: "/api/scenes/nope/render.png",
      headers: bearer(token),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(
      (missing.json() as ErrorEnvelope).error.code,
      ErrorCode.NOT_FOUND,
    );
  });

  test("invalid scale/dark → 400 VALIDATION", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-val";
    const { app } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
    });
    await createSceneWithVersion(app, token, "val");

    const badScale = await app.inject({
      method: "GET",
      url: "/api/scenes/val/render.png?scale=0",
      headers: bearer(token),
    });
    assert.equal(badScale.statusCode, 400);
    assert.equal(
      (badScale.json() as ErrorEnvelope).error.code,
      ErrorCode.VALIDATION,
    );

    const badDark = await app.inject({
      method: "GET",
      url: "/api/scenes/val/render.svg?dark=maybe",
      headers: bearer(token),
    });
    assert.equal(badDark.statusCode, 400);
  });

  test("version ref ?v= selects the requested version", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-render-ver";
    const { app, worker } = await buildRenderApp({
      dataDir,
      bootstrapToken: token,
    });
    assert.ok(worker);
    await createSceneWithVersion(app, token, "ver", [rect("a")]);

    // Push v2 with an extra element so element counts differ.
    const v2 = await app.inject({
      method: "POST",
      url: "/api/scenes/ver/scene",
      headers: { ...bearer(token), "content-type": "application/json" },
      payload: {
        parentVersion: 1,
        elements: [rect("a"), rect("b", { versionNonce: 2 })],
        message: "second",
      },
    });
    assert.equal(v2.statusCode, 201);

    const r1 = await app.inject({
      method: "GET",
      url: "/api/scenes/ver/render.png?v=1",
      headers: bearer(token),
    });
    const r2 = await app.inject({
      method: "GET",
      url: "/api/scenes/ver/render.png?v=2",
      headers: bearer(token),
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.notDeepEqual(
      Buffer.from(r1.rawPayload),
      Buffer.from(r2.rawPayload),
    );
    assert.equal(worker.callCount, 2);

    // Re-fetch v1 from cache.
    await app.inject({
      method: "GET",
      url: "/api/scenes/ver/render.png?v=1",
      headers: bearer(token),
    });
    assert.equal(worker.callCount, 2);
  });
});
