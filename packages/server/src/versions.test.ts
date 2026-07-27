import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import {
  openDatabase,
  type Database,
} from "./db.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import { FileStore, hashFileContent } from "./files.js";
import {
  resolveVersionRef,
  type ConflictDetails,
  type PushVersionResponse,
  type VersionInfo,
} from "./versions.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-versions-"));
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

async function buildVersionsApp(opts: {
  dataDir: string;
  bootstrapToken: string;
}): Promise<{ app: FastifyInstance; db: Database; store: FileStore }> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const config = testConfig({
    dataDir: opts.dataDir,
    bootstrapToken: opts.bootstrapToken,
  });
  const store = new FileStore(opts.dataDir, config.maxFileBytes);
  const app = await buildApp({
    config,
    db,
    fileStore: store,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });
  openApps.push(app);
  return { app, db, store };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Minimal rectangle element accepted by normalizeScene. */
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

/** Tiny valid PNG (1×1) with a real content-hash fileId. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_FILE_ID = hashFileContent(PNG_BYTES);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

function imageElement(fileId: string): Record<string, unknown> {
  return {
    id: "img-1",
    type: "image",
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "transparent",
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
    versionNonce: 42,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    status: "saved",
    fileId,
    scale: [1, 1],
    crop: null,
  };
}

function filesMap(fileId: string): Record<string, unknown> {
  return {
    [fileId]: {
      id: fileId,
      mimeType: "image/png",
      dataURL: PNG_DATA_URL,
      created: 1_700_000_000_000,
    },
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
    files?: unknown;
    message: string;
    author?: string;
    thumbnailFileId?: string | null;
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
// resolveVersionRef unit tests
// ---------------------------------------------------------------------------

describe("resolveVersionRef", () => {
  test("head and empty default to head", () => {
    assert.equal(resolveVersionRef(undefined, 5), 5);
    assert.equal(resolveVersionRef("", 5), 5);
    assert.equal(resolveVersionRef("head", 5), 5);
  });

  test("head~N relative refs", () => {
    assert.equal(resolveVersionRef("head~0", 5), 5);
    assert.equal(resolveVersionRef("head~1", 5), 4);
    assert.equal(resolveVersionRef("head~2", 5), 3);
    assert.equal(resolveVersionRef("head~5", 5), 0);
  });

  test("absolute integer refs", () => {
    assert.equal(resolveVersionRef("1", 5), 1);
    assert.equal(resolveVersionRef("5", 5), 5);
    assert.equal(resolveVersionRef(3, 5), 3);
  });

  test("malformed refs throw VALIDATION", () => {
    assert.throws(
      () => resolveVersionRef("head~", 5),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, ErrorCode.VALIDATION);
        return true;
      },
    );
    assert.throws(() => resolveVersionRef("latest", 5));
    assert.throws(() => resolveVersionRef("head~-1", 5));
    assert.throws(() => resolveVersionRef("1.5", 5));
    assert.throws(() => resolveVersionRef(-1, 5));
  });
});

// ---------------------------------------------------------------------------
// Push / pull happy path
// ---------------------------------------------------------------------------

describe("POST/GET /api/scenes/:slug/scene", () => {
  test("first push commits as v1 and pull returns the document", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-first-push";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const elements = [rect("a", 11)];
    const res = await pushScene(app, token, {
      parentVersion: 0,
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
      message: "initial sketch",
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PushVersionResponse;
    assert.equal(body.version, 1);
    assert.equal(body.parentVersion, 0);
    assert.equal(body.author, "admin");
    assert.equal(body.message, "initial sketch");
    assert.equal(body.headVersion, 1);
    assert.equal(body.elementCount, 1);
    assert.equal(typeof body.sceneHash, "string");
    assert.equal(typeof body.createdAt, "string");

    assert.equal(db.getSceneBySlug("arch")?.head_version, 1);

    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    assert.equal(pull.statusCode, 200, pull.body);
    const doc = pull.json() as {
      type: string;
      version: number;
      elements: Array<{ id: string }>;
      appState: { viewBackgroundColor?: string };
      files: Record<string, unknown>;
    };
    assert.equal(doc.type, "excalidraw");
    assert.equal(doc.version, 2);
    assert.equal(doc.elements.length, 1);
    assert.equal(doc.elements[0]!.id, "a");
    assert.equal(doc.appState.viewBackgroundColor, "#ffffff");
    assert.deepEqual(doc.files, {});
  });

  test("empty scene (head 0) pulls as empty document", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-empty";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    assert.equal(pull.statusCode, 200);
    const doc = pull.json() as { elements: unknown[]; files: unknown };
    assert.deepEqual(doc.elements, []);
    assert.deepEqual(doc.files, {});
  });

  test("sequential pushes advance head gaplessly", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-seq";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    for (let i = 0; i < 5; i++) {
      const res = await pushScene(app, token, {
        parentVersion: i,
        elements: [rect(`e${i}`, i + 1)],
        message: `turn ${i + 1}`,
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((res.json() as PushVersionResponse).version, i + 1);
    }

    assert.equal(db.getSceneBySlug("arch")?.head_version, 5);
    const versions = db.listVersions(db.getSceneBySlug("arch")!.id);
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2, 3, 4, 5],
    );
  });

  test("stale parentVersion returns 409 with conflict details and diff", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-stale";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    assert.equal(
      (
        await pushScene(app, token, {
          parentVersion: 0,
          elements: [rect("a")],
          message: "v1",
        })
      ).statusCode,
      201,
    );

    const stale = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("b")],
      message: "stale",
    });
    assert.equal(stale.statusCode, 409);
    const env = stale.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.CONFLICT);
    const details = env.error.details as ConflictDetails;
    assert.equal(details.code, "conflict");
    assert.equal(details.head, 1);
    assert.equal(details.parentVersion, 0);
    // Issue #17: 409 must carry parent→head diff in the same response.
    assert.ok(details.diff, "conflict details must include diff");
    assert.equal(details.diff.from, 0);
    assert.equal(details.diff.to, 1);
    assert.equal(details.diff.summary.added, 1);
    assert.equal(details.diff.elements[0]!.op, "add");
    assert.equal(details.diff.elements[0]!.id, "a");
  });

  test("rejected push does not consume a version number", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-no-consume";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("b")],
      message: "rejected",
    });

    const scene = db.getSceneBySlug("arch")!;
    assert.equal(scene.head_version, 1);
    assert.equal(db.listVersions(scene.id).length, 1);
  });

  test("?force=true commits on a stale parent; history stays gapless", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-force";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("b")],
      message: "v2",
    });

    const forced = await pushScene(
      app,
      token,
      {
        parentVersion: 0,
        elements: [rect("forced")],
        message: "force overwrite",
      },
      { force: true },
    );
    assert.equal(forced.statusCode, 201, forced.body);
    const body = forced.json() as PushVersionResponse;
    assert.equal(body.version, 3);
    assert.equal(body.parentVersion, 0);

    const scene = db.getSceneBySlug("arch")!;
    assert.equal(scene.head_version, 3);
    assert.deepEqual(
      db.listVersions(scene.id).map((v) => v.version),
      [1, 2, 3],
    );

    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    const doc = pull.json() as { elements: Array<{ id: string }> };
    assert.equal(doc.elements[0]!.id, "forced");
  });

  test("author comes from token identity, never the request body", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-author";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Mint a named non-admin token via admin API.
    const mint = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(token),
      payload: { name: "agent-alpha" },
    });
    assert.equal(mint.statusCode, 201, mint.body);
    const agentToken = (mint.json() as { token: string }).token;

    const res = await pushScene(app, agentToken, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "agent turn",
      author: "spoofed-human",
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PushVersionResponse;
    assert.equal(body.author, "agent-alpha");

    const row = db.listVersions(db.getSceneBySlug("arch")!.id)[0]!;
    assert.equal(row.author, "agent-alpha");
  });

  test("missing or empty message is rejected", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-msg";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    const missing = await app.inject({
      method: "POST",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
      payload: {
        parentVersion: 0,
        elements: [rect("a")],
      },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(
      (missing.json() as ErrorEnvelope).error.code,
      ErrorCode.VALIDATION,
    );

    const empty = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "   ",
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(
      (empty.json() as ErrorEnvelope).error.code,
      ErrorCode.VALIDATION,
    );
  });

  test("files round-trip: pushed image rehydrates identically on pull", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-files";
    const { app, store } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Real content hash — not the fixture placeholder file_fixture_image_001.
    assert.match(PNG_FILE_ID, /^[0-9a-f]{40}$/);

    const res = await pushScene(app, token, {
      parentVersion: 0,
      elements: [imageElement(PNG_FILE_ID)],
      files: filesMap(PNG_FILE_ID),
      message: "with image",
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(store.exists(PNG_FILE_ID), true);

    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    assert.equal(pull.statusCode, 200, pull.body);
    const doc = pull.json() as {
      elements: Array<{ fileId?: string }>;
      files: Record<
        string,
        { id: string; mimeType: string; dataURL: string; created: number }
      >;
    };
    assert.equal(doc.elements[0]!.fileId, PNG_FILE_ID);
    assert.ok(doc.files[PNG_FILE_ID]);
    assert.equal(doc.files[PNG_FILE_ID]!.id, PNG_FILE_ID);
    assert.equal(doc.files[PNG_FILE_ID]!.mimeType, "image/png");
    assert.equal(doc.files[PNG_FILE_ID]!.dataURL, PNG_DATA_URL);
  });

  test("pull supports head, head~2, and absolute ?v=N", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-refs";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    for (let i = 0; i < 4; i++) {
      const r = await pushScene(app, token, {
        parentVersion: i,
        elements: [rect(`v${i + 1}`, i + 10)],
        message: `commit ${i + 1}`,
      });
      assert.equal(r.statusCode, 201, r.body);
    }

    async function pullIds(v?: string): Promise<string> {
      const url =
        v === undefined
          ? "/api/scenes/arch/scene"
          : `/api/scenes/arch/scene?v=${encodeURIComponent(v)}`;
      const res = await app.inject({
        method: "GET",
        url,
        headers: bearer(token),
      });
      assert.equal(res.statusCode, 200, res.body);
      const doc = res.json() as { elements: Array<{ id: string }> };
      return doc.elements[0]!.id;
    }

    assert.equal(await pullIds(), "v4");
    assert.equal(await pullIds("head"), "v4");
    assert.equal(await pullIds("head~0"), "v4");
    assert.equal(await pullIds("head~1"), "v3");
    assert.equal(await pullIds("head~2"), "v2");
    assert.equal(await pullIds("1"), "v1");
    assert.equal(await pullIds("3"), "v3");
  });

  test("out-of-range or malformed version refs return clean errors", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-bad-ref";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });

    const oob = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene?v=99",
      headers: bearer(token),
    });
    assert.equal(oob.statusCode, 404);
    assert.equal((oob.json() as ErrorEnvelope).error.code, ErrorCode.NOT_FOUND);

    const headPast = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene?v=head~5",
      headers: bearer(token),
    });
    assert.equal(headPast.statusCode, 404);

    const bad = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene?v=nope",
      headers: bearer(token),
    });
    assert.equal(bad.statusCode, 400);
    assert.equal((bad.json() as ErrorEnvelope).error.code, ErrorCode.VALIDATION);
  });

  test("requires auth", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-auth";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
    });
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// Concurrent pushes — the core correctness property
// ---------------------------------------------------------------------------

describe("optimistic concurrency", () => {
  test("two concurrent pushes with the same parentVersion: exactly one 200/201 and one 409", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-concurrent";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Seed head=1 so both contenders race on parentVersion=1.
    const seed = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("seed")],
      message: "seed",
    });
    assert.equal(seed.statusCode, 201);

    // Fire both without awaiting the first — real concurrency at the app layer.
    const p1 = pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("racer-a", 100)],
      message: "racer A",
    });
    const p2 = pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("racer-b", 200)],
      message: "racer B",
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(
      codes,
      [201, 409],
      `expected one 201 and one 409, got ${r1.statusCode} and ${r2.statusCode}:\n${r1.body}\n${r2.body}`,
    );

    const winner = r1.statusCode === 201 ? r1 : r2;
    const loser = r1.statusCode === 409 ? r1 : r2;
    assert.equal((winner.json() as PushVersionResponse).version, 2);
    const details = (loser.json() as ErrorEnvelope).error
      .details as ConflictDetails;
    assert.equal(details.code, "conflict");
    assert.equal(details.head, 2);
    assert.equal(details.parentVersion, 1);

    const scene = db.getSceneBySlug("arch")!;
    assert.equal(scene.head_version, 2);
    assert.equal(db.listVersions(scene.id).length, 2);
  });

  test("burst of interleaved pushes: versions stay gapless and monotonic; rejects do not consume numbers", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-burst";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Wave 1: many contenders all claiming parentVersion 0.
    const wave1 = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        pushScene(app, token, {
          parentVersion: 0,
          elements: [rect(`w1-${i}`, i + 1)],
          message: `wave1 ${i}`,
        }),
      ),
    );
    const w1ok = wave1.filter((r) => r.statusCode === 201);
    const w1conflict = wave1.filter((r) => r.statusCode === 409);
    assert.equal(w1ok.length, 1, "exactly one winner on parentVersion 0");
    assert.equal(w1conflict.length, 7);

    // Wave 2: contenders on parentVersion 1 (the new head).
    const wave2 = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pushScene(app, token, {
          parentVersion: 1,
          elements: [rect(`w2-${i}`, 50 + i)],
          message: `wave2 ${i}`,
        }),
      ),
    );
    assert.equal(wave2.filter((r) => r.statusCode === 201).length, 1);
    assert.equal(wave2.filter((r) => r.statusCode === 409).length, 5);

    // Sequential clean commits on top.
    for (let parent = 2; parent < 6; parent++) {
      const r = await pushScene(app, token, {
        parentVersion: parent,
        elements: [rect(`seq-${parent}`, 100 + parent)],
        message: `seq ${parent + 1}`,
      });
      assert.equal(r.statusCode, 201, r.body);
    }

    // A few more stale rejects mixed in.
    const stale = await Promise.all([
      pushScene(app, token, {
        parentVersion: 0,
        elements: [rect("stale-0")],
        message: "stale",
      }),
      pushScene(app, token, {
        parentVersion: 3,
        elements: [rect("stale-3")],
        message: "stale",
      }),
    ]);
    for (const r of stale) {
      assert.equal(r.statusCode, 409);
    }

    const scene = db.getSceneBySlug("arch")!;
    const versions = db.listVersions(scene.id);
    assert.equal(scene.head_version, 6);
    assert.equal(versions.length, 6);
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2, 3, 4, 5, 6],
    );
    // Monotonic created_at is not required, but version sequence is gapless.
    for (let i = 1; i < versions.length; i++) {
      assert.equal(versions[i]!.version, versions[i - 1]!.version + 1);
      assert.ok(
        versions[i]!.parent_version === versions[i]!.version - 1 ||
          // force is not used here; parent should be previous head at commit time
          versions[i]!.parent_version! < versions[i]!.version,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Version history listing
// ---------------------------------------------------------------------------

describe("GET /api/scenes/:slug/versions", () => {
  test("returns paginated history newest-first", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-log";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    await createScene(app, token);

    for (let i = 0; i < 5; i++) {
      assert.equal(
        (
          await pushScene(app, token, {
            parentVersion: i,
            elements: [rect(`e${i}`)],
            message: `msg ${i + 1}`,
          })
        ).statusCode,
        201,
      );
    }

    const page = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/versions?limit=2&offset=0",
      headers: bearer(token),
    });
    assert.equal(page.statusCode, 200, page.body);
    const body = page.json() as {
      versions: VersionInfo[];
      total: number;
      limit: number;
      offset: number;
      headVersion: number;
    };
    assert.equal(body.total, 5);
    assert.equal(body.limit, 2);
    assert.equal(body.offset, 0);
    assert.equal(body.headVersion, 5);
    assert.equal(body.versions.length, 2);
    assert.equal(body.versions[0]!.version, 5);
    assert.equal(body.versions[1]!.version, 4);
    assert.equal(body.versions[0]!.message, "msg 5");
    assert.equal(body.versions[0]!.author, "admin");

    const page2 = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/versions?limit=2&offset=2",
      headers: bearer(token),
    });
    const body2 = page2.json() as { versions: VersionInfo[] };
    assert.equal(body2.versions[0]!.version, 3);
    assert.equal(body2.versions[1]!.version, 2);
  });

  test("unknown scene is 404", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-log-404";
    const { app } = await buildVersionsApp({ dataDir, bootstrapToken: token });
    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/nope/versions",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Atomic head update
// ---------------------------------------------------------------------------

describe("commitVersion atomicity", () => {
  test("head_version and version row update together", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-atomic";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "one",
    });

    const scene = db.getSceneBySlug("arch")!;
    assert.equal(scene.head_version, 1);
    const v = db.getVersion(scene.id, 1);
    assert.ok(v);
    assert.equal(v.version, 1);
    // updated_at should match the version's created_at (same transaction clock).
    assert.equal(scene.updated_at, v.created_at);
  });
});

// ---------------------------------------------------------------------------
// Client-uploaded version thumbnails (issue #30)
// ---------------------------------------------------------------------------

describe("thumbnailFileId on commit", () => {
  test("push with pre-uploaded PNG stores thumbnail and surfaces it on list", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-thumb";
    const { app, db, store } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Upload a small PNG into the content-addressed store first.
    const upload = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        ...bearer(token),
        "content-type": "image/png",
      },
      payload: PNG_BYTES,
    });
    assert.equal(upload.statusCode, 201, upload.body);
    const uploaded = upload.json() as { fileId: string };
    assert.equal(uploaded.fileId, PNG_FILE_ID);
    assert.ok(store.exists(PNG_FILE_ID));

    const res = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "human commit with thumb",
      thumbnailFileId: PNG_FILE_ID,
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PushVersionResponse;
    assert.equal(body.thumbnailFileId, PNG_FILE_ID);

    const version = db.getVersion(db.getSceneBySlug("arch")!.id, 1)!;
    assert.equal(version.thumbnail_file_id, PNG_FILE_ID);

    // Scene list exposes head thumbnail without invoking the render worker.
    const list = await app.inject({
      method: "GET",
      url: "/api/scenes",
      headers: bearer(token),
    });
    assert.equal(list.statusCode, 200);
    const scenes = (list.json() as { scenes: Array<{ thumbnailFileId: string | null }> })
      .scenes;
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0]!.thumbnailFileId, PNG_FILE_ID);

    const meta = await app.inject({
      method: "GET",
      url: "/api/scenes/arch",
      headers: bearer(token),
    });
    assert.equal(meta.statusCode, 200);
    assert.equal(
      (meta.json() as { thumbnailFileId: string | null }).thumbnailFileId,
      PNG_FILE_ID,
    );

    // Thumbnail is anchored for GC (not only scene image file_ids).
    const refs = db.listReferencedFileIds();
    assert.ok(refs.includes(PNG_FILE_ID));
  });

  test("push without thumbnailFileId leaves null (agent path)", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-no-thumb";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const res = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "agent push",
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as PushVersionResponse;
    assert.equal(body.thumbnailFileId, null);

    const version = db.getVersion(db.getSceneBySlug("arch")!.id, 1)!;
    assert.equal(version.thumbnail_file_id, null);

    const list = await app.inject({
      method: "GET",
      url: "/api/scenes",
      headers: bearer(token),
    });
    const scenes = (list.json() as { scenes: Array<{ thumbnailFileId: string | null }> })
      .scenes;
    assert.equal(scenes[0]!.thumbnailFileId, null);
  });

  test("unknown thumbnailFileId is 400 (must upload first)", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-thumb-missing";
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const res = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "bad thumb",
      thumbnailFileId: "a".repeat(40),
    });
    assert.equal(res.statusCode, 400, res.body);
    const err = res.json() as ErrorEnvelope;
    assert.equal(err.error.code, ErrorCode.VALIDATION);
    assert.match(err.error.message, /not found in file store/i);
  });

  test("malformed thumbnailFileId is 400", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-thumb-bad";
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const res = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "bad id",
      thumbnailFileId: "not-a-hash",
    });
    assert.equal(res.statusCode, 400, res.body);
    const err = res.json() as ErrorEnvelope;
    assert.equal(err.error.code, ErrorCode.VALIDATION);
  });
});
