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
import type { SceneMergeService } from "./merge.js";
import { MERGE_WORKER_DISABLED_MESSAGE } from "./merge.js";
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
  merge?: SceneMergeService | null;
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
    merge: opts.merge,
  });
  openApps.push(app);
  return { app, db, store };
}

/**
 * Test double that mirrors upstream reconcileElements version rule:
 *   local wins when local.version > remote.version, or same version with
 *   lower versionNonce; otherwise remote. Elements only on one side are kept.
 * Used so HTTP merge tests stay free of Playwright while still asserting
 * the same decision surface (not a novel conflict policy).
 */
function versionRuleMergeService(): SceneMergeService {
  return {
    async merge({ localElements, remoteElements }) {
      type El = {
        id: string;
        version?: number;
        versionNonce?: number;
        [k: string]: unknown;
      };
      const local = localElements as El[];
      const remote = remoteElements as El[];
      const localMap = new Map(local.map((e) => [e.id, e]));
      const out: El[] = [];
      const added = new Set<string>();

      for (const r of remote) {
        if (added.has(r.id)) continue;
        const l = localMap.get(r.id);
        if (l) {
          const lv = l.version ?? 0;
          const rv = r.version ?? 0;
          const lvn = l.versionNonce ?? 0;
          const rvn = r.versionNonce ?? 0;
          // Match shouldDiscardRemoteElement: local wins if newer version, or
          // same version and lower versionNonce.
          if (lv > rv || (lv === rv && lvn < rvn)) {
            out.push(l);
          } else {
            out.push(r);
          }
        } else {
          out.push(r);
        }
        added.add(r.id);
      }
      for (const l of local) {
        if (!added.has(l.id)) {
          out.push(l);
          added.add(l.id);
        }
      }
      return { elements: out };
    },
  };
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
  opts: { force?: boolean; merge?: boolean; slug?: string } = {},
) {
  const slug = opts.slug ?? "arch";
  const params = new URLSearchParams();
  if (opts.force) params.set("force", "true");
  if (opts.merge) params.set("merge", "true");
  const qs = params.toString() ? `?${params.toString()}` : "";
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

  test("?merge=true without render worker returns 501 with actionable message", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-merge-off";
    // No merge service injected → same as RENDER_WORKER=off.
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });

    const res = await pushScene(
      app,
      token,
      {
        parentVersion: 0,
        elements: [rect("b")],
        message: "stale merge attempt",
      },
      { merge: true },
    );
    assert.equal(res.statusCode, 501, res.body);
    const env = res.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.NOT_IMPLEMENTED);
    assert.match(env.error.message, /RENDER_WORKER=on/);
    assert.equal(env.error.message, MERGE_WORKER_DISABLED_MESSAGE);
  });

  test("?merge=true + force is rejected as validation error", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-merge-force";
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
      merge: versionRuleMergeService(),
    });
    await createScene(app, token);
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("a")],
      message: "v1",
    });

    const res = await pushScene(
      app,
      token,
      {
        parentVersion: 0,
        elements: [rect("b")],
        message: "both",
      },
      { force: true, merge: true },
    );
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(
      (res.json() as ErrorEnvelope).error.code,
      ErrorCode.VALIDATION,
    );
  });

  test("merge of divergent edits to different elements keeps both", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-merge-both";
    const { app, db } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
      merge: versionRuleMergeService(),
    });
    await createScene(app, token);

    // Base: element A and B at version 1.
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [
        { ...rect("a"), x: 0, version: 1, versionNonce: 1 },
        { ...rect("b"), x: 100, version: 1, versionNonce: 1 },
      ],
      message: "base",
    });

    // Remote advances A (stays on parent 1).
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [
        { ...rect("a"), x: 50, version: 2, versionNonce: 2 },
        { ...rect("b"), x: 100, version: 1, versionNonce: 1 },
      ],
      message: "remote moved a",
    });

    // Local still on parent 1, edited B only.
    const merged = await pushScene(
      app,
      token,
      {
        parentVersion: 1,
        elements: [
          { ...rect("a"), x: 0, version: 1, versionNonce: 1 },
          { ...rect("b"), x: 200, version: 2, versionNonce: 3 },
        ],
        message: "local moved b",
      },
      { merge: true },
    );
    assert.equal(merged.statusCode, 201, merged.body);
    const body = merged.json() as PushVersionResponse;
    assert.equal(body.merged, true);
    assert.deepEqual(body.mergeParents, { local: 1, remote: 2 });
    assert.ok(body.diff, "merge response must include a diff");
    assert.match(body.message, /merge: parents v1\+v2/);
    assert.equal(body.version, 3);

    // Both edits survive: A at remote's x=50, B at local's x=200.
    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    const doc = pull.json() as {
      elements: Array<{ id: string; x: number }>;
    };
    const byId = Object.fromEntries(doc.elements.map((e) => [e.id, e]));
    assert.equal(byId.a!.x, 50, "remote edit to A must survive");
    assert.equal(byId.b!.x, 200, "local edit to B must survive");

    const scene = db.getSceneBySlug("arch")!;
    assert.equal(scene.head_version, 3);
  });

  test("merge same-element conflict is deterministic and follows version rule", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-merge-same";
    const merge = versionRuleMergeService();
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
      merge,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [{ ...rect("a"), x: 0, version: 1, versionNonce: 10 }],
      message: "base",
    });

    // Remote: higher version on A.
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [{ ...rect("a"), x: 99, version: 3, versionNonce: 99 }],
      message: "remote",
    });

    const localPayload = {
      parentVersion: 1,
      elements: [{ ...rect("a"), x: 1, version: 2, versionNonce: 1 }],
      message: "local lower version",
    };

    const first = await pushScene(app, token, localPayload, { merge: true });
    assert.equal(first.statusCode, 201, first.body);
    const firstBody = first.json() as PushVersionResponse;
    assert.equal(firstBody.merged, true);
    assert.ok(firstBody.diff);

    // Pull committed scene after first merge.
    const pull1 = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene?v=3",
      headers: bearer(token),
    });
    const doc1 = pull1.json() as {
      elements: Array<{ id: string; x: number; version: number }>;
    };
    assert.equal(doc1.elements.length, 1);
    // Remote has version 3 > local 2 → remote wins (x=99).
    assert.equal(doc1.elements[0]!.x, 99);
    assert.equal(doc1.elements[0]!.version, 3);

    // Re-run the same merge inputs via the service alone for determinism.
    const again1 = await merge.merge({
      localElements: localPayload.elements,
      remoteElements: [{ ...rect("a"), x: 99, version: 3, versionNonce: 99 }],
      appState: {},
    });
    const again2 = await merge.merge({
      localElements: localPayload.elements,
      remoteElements: [{ ...rect("a"), x: 99, version: 3, versionNonce: 99 }],
      appState: {},
    });
    assert.deepEqual(again1.elements, again2.elements);
    assert.equal((again1.elements[0] as { x: number }).x, 99);

    // Local wins when version is higher.
    const dataDir2 = tempDataDir();
    const token2 = "versions-token-merge-same-local";
    const { app: app2 } = await buildVersionsApp({
      dataDir: dataDir2,
      bootstrapToken: token2,
      merge: versionRuleMergeService(),
    });
    await createScene(app2, token2, "Arch2", "arch2");
    await pushScene(
      app2,
      token2,
      {
        parentVersion: 0,
        elements: [{ ...rect("a"), x: 0, version: 1, versionNonce: 10 }],
        message: "base",
      },
      { slug: "arch2" },
    );
    await pushScene(
      app2,
      token2,
      {
        parentVersion: 1,
        elements: [{ ...rect("a"), x: 50, version: 2, versionNonce: 20 }],
        message: "remote lower",
      },
      { slug: "arch2" },
    );
    const localWins = await pushScene(
      app2,
      token2,
      {
        parentVersion: 1,
        elements: [{ ...rect("a"), x: 7, version: 5, versionNonce: 1 }],
        message: "local higher version",
      },
      { merge: true, slug: "arch2" },
    );
    assert.equal(localWins.statusCode, 201, localWins.body);
    const pullLocal = await app2.inject({
      method: "GET",
      url: "/api/scenes/arch2/scene",
      headers: bearer(token2),
    });
    const docLocal = pullLocal.json() as {
      elements: Array<{ x: number; version: number }>;
    };
    assert.equal(docLocal.elements[0]!.x, 7);
    assert.equal(docLocal.elements[0]!.version, 5);
  });

  test("merge keeps hand-edited client changes that never bumped version (agent workflow)", async () => {
    // Regression: agents edit pulled JSON without bumping version/versionNonce.
    // Before the prepareLocalElementsForMerge fix, reconcileElements discarded
    // the whole client turn and reported an empty merge-decided diff.
    const dataDir = tempDataDir();
    const token = "versions-token-merge-hand-edit";
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
      merge: versionRuleMergeService(),
    });
    await createScene(app, token);

    // v1: API + DB boxes (as a skeleton convert would produce), both at v=1.
    const baseApi = {
      ...rect("api"),
      x: 0,
      backgroundColor: "transparent",
      version: 1,
      versionNonce: 100,
    };
    const baseDb = {
      ...rect("db"),
      x: 300,
      backgroundColor: "transparent",
      version: 1,
      versionNonce: 101,
    };
    const baseArrow = {
      ...rect("arrow"),
      type: "arrow",
      x: 0,
      y: 40,
      width: 300,
      height: 0,
      version: 1,
      versionNonce: 102,
    };
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [baseApi, baseDb, baseArrow],
      message: "skeleton: API DB arrow",
    });

    // v2 (human): only DB fill changes — bumps version like the real editor.
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [
        { ...baseApi },
        {
          ...baseDb,
          backgroundColor: "#ffc9c9",
          version: 2,
          versionNonce: 200,
        },
        { ...baseArrow },
      ],
      message: "human recolours DB",
    });

    // Agent still on parent v1: hand-edits API fill only — does NOT touch
    // version / versionNonce (exactly how agents edit .excalidraw JSON).
    const agentLocal = [
      {
        ...baseApi,
        backgroundColor: "#b2f2bb",
        // deliberately stale:
        version: 1,
        versionNonce: 100,
      },
      { ...baseDb },
      { ...baseArrow },
    ];
    const merged = await pushScene(
      app,
      token,
      {
        parentVersion: 1,
        elements: agentLocal,
        message: "agent recolours the API box",
      },
      { merge: true },
    );
    assert.equal(merged.statusCode, 201, merged.body);
    const body = merged.json() as PushVersionResponse;
    assert.equal(body.merged, true);
    assert.equal(body.version, 3);
    assert.ok(body.diff, "merge response must include merge-decided diff");

    // Invariant that would have caught the data-loss bug: when the committed
    // scene differs from remote head, the reported merge diff must not be empty.
    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    const doc = pull.json() as {
      elements: Array<{ id: string; backgroundColor?: string }>;
    };
    const byId = Object.fromEntries(doc.elements.map((e) => [e.id, e]));
    assert.equal(
      byId.api!.backgroundColor,
      "#b2f2bb",
      "agent hand-edit to API must survive merge",
    );
    assert.equal(
      byId.db!.backgroundColor,
      "#ffc9c9",
      "human edit to DB must survive merge",
    );

    const diff = body.diff!;
    const nonEmpty =
      diff.summary.added +
        diff.summary.deleted +
        diff.summary.updated +
        diff.summary.reordered >
      0;
    assert.ok(
      nonEmpty,
      "merge-decided diff must not be empty when committed version differs from remote head",
    );
    assert.ok(
      diff.elements.some(
        (c) =>
          c.op === "update" &&
          c.id === "api" &&
          c.props.some(
            (p) => p.key === "backgroundColor" && p.to === "#b2f2bb",
          ),
      ),
      "merge-decided diff must report the API fill from the client",
    );
  });

  test("merge preserves client-side additions and deletions", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-merge-add-del";
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
      merge: versionRuleMergeService(),
    });
    await createScene(app, token);

    const a = { ...rect("a"), x: 0, version: 1, versionNonce: 1 };
    const b = { ...rect("b"), x: 100, version: 1, versionNonce: 2 };
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [a, b],
      message: "base a+b",
    });

    // Remote restyles A only (different element from the one local will delete).
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [
        {
          ...a,
          backgroundColor: "#ffc9c9",
          version: 2,
          versionNonce: 20,
        },
        { ...b },
      ],
      message: "remote restyle a",
    });

    // Local on parent 1: hard-delete B, add C — no version bumps on hand-edits.
    const c = {
      ...rect("c"),
      x: 200,
      version: 1,
      versionNonce: 30,
      backgroundColor: "#a5d8ff",
    };
    const merged = await pushScene(
      app,
      token,
      {
        parentVersion: 1,
        elements: [{ ...a }, c],
        message: "local delete b add c",
      },
      { merge: true },
    );
    assert.equal(merged.statusCode, 201, merged.body);
    const body = merged.json() as PushVersionResponse;
    assert.equal(body.merged, true);
    assert.ok(body.diff);

    const pull = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/scene",
      headers: bearer(token),
    });
    const doc = pull.json() as {
      elements: Array<{
        id: string;
        isDeleted?: boolean;
        backgroundColor?: string;
      }>;
    };
    const live = doc.elements.filter((e) => e.isDeleted !== true);
    const byId = Object.fromEntries(doc.elements.map((e) => [e.id, e]));

    assert.ok(
      live.some((e) => e.id === "c"),
      "client addition must survive merge",
    );
    assert.equal(byId.c!.backgroundColor, "#a5d8ff");

    // B deleted by client: either absent or tombstoned (remote left B alone).
    const bEl = byId.b;
    assert.ok(
      bEl === undefined || bEl.isDeleted === true,
      "client deletion of B must survive merge",
    );
    assert.equal(
      byId.a!.backgroundColor,
      "#ffc9c9",
      "remote restyle of A must survive",
    );
    assert.ok(
      live.some((e) => e.id === "a"),
      "remote-edited A must remain live",
    );

    // Non-empty merge-decided diff when result ≠ remote head.
    const s = body.diff!.summary;
    assert.ok(
      s.added + s.deleted + s.updated + s.reordered > 0,
      "merge-decided diff must not be empty when result differs from remote head",
    );
  });

  test("merge that changes nothing reports empty merge-decided diff", async () => {
    const dataDir = tempDataDir();
    const token = "versions-token-merge-noop";
    const { app } = await buildVersionsApp({
      dataDir,
      bootstrapToken: token,
      merge: versionRuleMergeService(),
    });
    await createScene(app, token);

    const a = { ...rect("a"), version: 1, versionNonce: 1 };
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [a],
      message: "v1",
    });
    // Remote makes no content change that local lacks — local resubmits parent
    // content while a no-op remote bump of version only… use content-identical
    // remote with a second element so heads diverge, then local merges parent
    // equal to remote content for shared ids and no extra client edits.
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [{ ...a, version: 1, versionNonce: 1 }],
      message: "remote identical content",
    });

    // Local still on parent 0? parent 1 with identical content — actually
    // parentVersion 1 === head 2 is false. Local sends same elements as parent
    // (v1 content) while head is v2 with same content → merge result == head.
    const merged = await pushScene(
      app,
      token,
      {
        parentVersion: 1,
        elements: [{ ...a }],
        message: "noop merge",
      },
      { merge: true },
    );
    assert.equal(merged.statusCode, 201, merged.body);
    const body = merged.json() as PushVersionResponse;
    assert.equal(body.merged, true);
    const s = body.diff!.summary;
    assert.equal(s.added, 0);
    assert.equal(s.deleted, 0);
    assert.equal(s.updated, 0);
    assert.equal(s.reordered, 0);
    assert.equal(body.diff!.elements.length, 0);
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
