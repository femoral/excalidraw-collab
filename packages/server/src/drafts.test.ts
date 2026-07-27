import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import {
  DB_FILENAME,
  openDatabase,
  type Database,
} from "./db.js";
import type { DraftResponse } from "./drafts.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import { FileStore } from "./files.js";
import type { PushVersionResponse, VersionInfo } from "./versions.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-drafts-"));
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

async function buildDraftsApp(opts: {
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

async function putDraft(
  app: FastifyInstance,
  token: string,
  body: {
    elements: unknown[];
    appState?: unknown;
    fileIds?: string[];
    basedOnVersion?: number;
    updatedBy?: string;
    author?: string;
  },
  slug = "arch",
) {
  return app.inject({
    method: "PUT",
    url: `/api/scenes/${slug}/draft`,
    headers: bearer(token),
    payload: body,
  });
}

async function getDraft(
  app: FastifyInstance,
  token: string,
  slug = "arch",
) {
  return app.inject({
    method: "GET",
    url: `/api/scenes/${slug}/draft`,
    headers: bearer(token),
  });
}

async function deleteDraft(
  app: FastifyInstance,
  token: string,
  slug = "arch",
) {
  return app.inject({
    method: "DELETE",
    url: `/api/scenes/${slug}/draft`,
    headers: bearer(token),
  });
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
  slug = "arch",
) {
  return app.inject({
    method: "POST",
    url: `/api/scenes/${slug}/scene`,
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
// PUT / GET round-trip
// ---------------------------------------------------------------------------

describe("PUT/GET /api/scenes/:slug/draft", () => {
  test("PUT overwrites working copy and GET returns it with head + stale", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-roundtrip";
    const { app, db } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const put = await putDraft(app, token, {
      elements: [rect("d1", 1)],
      appState: { viewBackgroundColor: "#ff0000", collaborators: {} },
      fileIds: ["a".repeat(40)],
      basedOnVersion: 0,
    });
    assert.equal(put.statusCode, 200, put.body);
    const putBody = put.json() as DraftResponse;
    assert.equal(putBody.elements.length, 1);
    assert.equal((putBody.elements[0] as { id: string }).id, "d1");
    // Non-persistable appState keys must be dropped by normalizeScene.
    assert.equal(putBody.appState.viewBackgroundColor, "#ff0000");
    assert.equal(
      (putBody.appState as { collaborators?: unknown }).collaborators,
      undefined,
    );
    assert.deepEqual(putBody.fileIds, ["a".repeat(40)]);
    assert.equal(putBody.updatedBy, "admin");
    assert.equal(putBody.basedOnVersion, 0);
    assert.equal(putBody.headVersion, 0);
    assert.equal(putBody.stale, false);
    assert.equal(typeof putBody.updatedAt, "string");

    assert.equal(db.countDrafts(), 1);
    assert.equal(db.countDrafts(db.getSceneBySlug("arch")!.id), 1);

    const get = await getDraft(app, token);
    assert.equal(get.statusCode, 200, get.body);
    const getBody = get.json() as DraftResponse;
    assert.equal(getBody.updatedBy, "admin");
    assert.equal(getBody.basedOnVersion, 0);
    assert.equal(getBody.headVersion, 0);
    assert.equal(getBody.stale, false);
    assert.equal((getBody.elements[0] as { id: string }).id, "d1");
  });

  test("client-supplied updatedBy/author are ignored; token name wins", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-identity";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const put = await putDraft(app, token, {
      elements: [rect("x")],
      basedOnVersion: 0,
      updatedBy: "impostor",
      author: "also-impostor",
    });
    assert.equal(put.statusCode, 200, put.body);
    const body = put.json() as DraftResponse;
    assert.equal(body.updatedBy, "admin");
    assert.notEqual(body.updatedBy, "impostor");
  });

  test("GET without a draft returns 404 NOT_FOUND", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-no-draft";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const get = await getDraft(app, token);
    assert.equal(get.statusCode, 404);
    const env = get.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.NOT_FOUND);
  });

  test("unknown scene returns 404", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-missing-scene";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });

    const put = await putDraft(
      app,
      token,
      { elements: [], basedOnVersion: 0 },
      "nope",
    );
    assert.equal(put.statusCode, 404);

    const get = await getDraft(app, token, "nope");
    assert.equal(get.statusCode, 404);
  });

  test("unauthenticated requests are rejected", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-auth";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const put = await app.inject({
      method: "PUT",
      url: "/api/scenes/arch/draft",
      payload: { elements: [] },
    });
    assert.equal(put.statusCode, 401);

    const get = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/draft",
    });
    assert.equal(get.statusCode, 401);
  });

  test("omitted basedOnVersion defaults to current head", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-default-base";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Commit v1 so head is 1.
    const push = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("committed")],
      message: "v1",
    });
    assert.equal(push.statusCode, 201, push.body);

    const put = await putDraft(app, token, {
      elements: [rect("working")],
    });
    assert.equal(put.statusCode, 200, put.body);
    const body = put.json() as DraftResponse;
    assert.equal(body.basedOnVersion, 1);
    assert.equal(body.headVersion, 1);
    assert.equal(body.stale, false);
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe("draft staleness", () => {
  test("GET reports stale:true when basedOnVersion is behind head", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-stale";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Draft based on empty head (0).
    const put = await putDraft(app, token, {
      elements: [rect("local-edit")],
      basedOnVersion: 0,
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal((put.json() as DraftResponse).stale, false);

    // Someone else commits a turn → head becomes 1.
    const push = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("remote")],
      message: "remote turn",
    });
    assert.equal(push.statusCode, 201, push.body);
    // Commit clears the draft (see commit-clears-draft test). Re-create a
    // draft that claims it was based on the older head.
    const putAgain = await putDraft(app, token, {
      elements: [rect("local-edit-kept")],
      basedOnVersion: 0,
    });
    assert.equal(putAgain.statusCode, 200, putAgain.body);
    const afterPut = putAgain.json() as DraftResponse;
    assert.equal(afterPut.basedOnVersion, 0);
    assert.equal(afterPut.headVersion, 1);
    assert.equal(afterPut.stale, true);

    const get = await getDraft(app, token);
    assert.equal(get.statusCode, 200, get.body);
    const body = get.json() as DraftResponse;
    assert.equal(body.stale, true);
    assert.equal(body.basedOnVersion, 0);
    assert.equal(body.headVersion, 1);
    // Draft content is still served — never lose work — but marked stale.
    assert.equal((body.elements[0] as { id: string }).id, "local-edit-kept");
  });

  test("stale flag is explicit; client need not compare numbers", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-stale-flag";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("v1")],
      message: "v1",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("v2")],
      message: "v2",
    });

    const put = await putDraft(app, token, {
      elements: [rect("based-on-v1")],
      basedOnVersion: 1,
    });
    const body = put.json() as DraftResponse;
    assert.equal(body.stale, true);
    assert.equal(typeof body.stale, "boolean");
    assert.ok("stale" in body);
    assert.ok("basedOnVersion" in body);
    assert.ok("headVersion" in body);
  });
});

// ---------------------------------------------------------------------------
// One-row upsert / no proportional DB growth
// ---------------------------------------------------------------------------

describe("draft upsert does not grow the database", () => {
  test("rapid successive PUTs keep a single row and do not grow proportionally", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-growth";
    const { app, db } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const payload = {
      elements: [rect("autosave", 1)],
      appState: { viewBackgroundColor: "#ffffff" },
      basedOnVersion: 0,
    };

    const first = await putDraft(app, token, payload);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(db.countDrafts(), 1);

    db.checkpointWal();
    const dbPath = path.join(path.resolve(dataDir), DB_FILENAME);
    const sizeAfterOne = statSync(dbPath).size;

    const N = 80;
    for (let i = 0; i < N; i++) {
      // Vary versionNonce so content is "new" but same size order.
      const res = await putDraft(app, token, {
        elements: [rect("autosave", i + 2)],
        appState: { viewBackgroundColor: "#ffffff" },
        basedOnVersion: 0,
      });
      assert.equal(res.statusCode, 200, res.body);
    }

    assert.equal(db.countDrafts(), 1, "must remain exactly one draft row");
    assert.equal(
      db.countDrafts(db.getSceneBySlug("arch")!.id),
      1,
    );

    db.checkpointWal();
    const sizeAfterMany = statSync(dbPath).size;

    // One more PUT of the same shape would add ~payload bytes if we were
    // inserting rows; after N overwrites the file must not grow like N *
    // first-save. Allow modest absolute growth (indexes/freelist/page size)
    // but reject linear growth: final size < sizeAfterOne + N * 200.
    const linearBound = sizeAfterOne + N * 200;
    assert.ok(
      sizeAfterMany < linearBound,
      `db grew too much: after1=${sizeAfterOne} after${N}=${sizeAfterMany} linearBound=${linearBound}`,
    );
    // And still well under 10× the post-first-save size for this tiny payload.
    assert.ok(
      sizeAfterMany < sizeAfterOne * 10,
      `db size after ${N} puts (${sizeAfterMany}) is not within 10× of first save (${sizeAfterOne})`,
    );

    // Last write wins.
    const get = await getDraft(app, token);
    const body = get.json() as DraftResponse;
    assert.equal(
      (body.elements[0] as { versionNonce: number }).versionNonce,
      N + 1,
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE + commit clears draft
// ---------------------------------------------------------------------------

describe("DELETE draft and commit clearing", () => {
  test("DELETE discards the working copy", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-delete";
    const { app, db } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    await putDraft(app, token, {
      elements: [rect("to-discard")],
      basedOnVersion: 0,
    });
    assert.equal(db.countDrafts(), 1);

    const del = await deleteDraft(app, token);
    assert.equal(del.statusCode, 204, del.body);
    assert.equal(db.countDrafts(), 0);

    const get = await getDraft(app, token);
    assert.equal(get.statusCode, 404);

    // Second delete is 404.
    const del2 = await deleteDraft(app, token);
    assert.equal(del2.statusCode, 404);
  });

  test("committing a version clears that scene's draft end-to-end", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-commit-clears";
    const { app, db } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    const put = await putDraft(app, token, {
      elements: [rect("wip")],
      basedOnVersion: 0,
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(db.countDrafts(), 1);

    const push = await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("committed-turn")],
      message: "commit turn",
    });
    assert.equal(push.statusCode, 201, push.body);
    const pushed = push.json() as PushVersionResponse;
    assert.equal(pushed.version, 1);

    // Draft is gone.
    assert.equal(db.countDrafts(), 0);
    const get = await getDraft(app, token);
    assert.equal(get.statusCode, 404);
    const env = get.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.NOT_FOUND);
  });

  test("drafts never appear in GET /versions history", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-not-in-history";
    const { app } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token);

    // Two real commits.
    await pushScene(app, token, {
      parentVersion: 0,
      elements: [rect("v1")],
      message: "first",
    });
    await pushScene(app, token, {
      parentVersion: 1,
      elements: [rect("v2")],
      message: "second",
    });

    // Many draft autosaves — must not pollute history.
    for (let i = 0; i < 20; i++) {
      const res = await putDraft(app, token, {
        elements: [rect("draft-only", i)],
        basedOnVersion: 2,
      });
      assert.equal(res.statusCode, 200, res.body);
    }

    const hist = await app.inject({
      method: "GET",
      url: "/api/scenes/arch/versions",
      headers: bearer(token),
    });
    assert.equal(hist.statusCode, 200, hist.body);
    const page = hist.json() as {
      versions: VersionInfo[];
      total: number;
      headVersion: number;
    };
    assert.equal(page.total, 2);
    assert.equal(page.versions.length, 2);
    assert.equal(page.headVersion, 2);
    assert.deepEqual(
      page.versions.map((v) => v.version).sort(),
      [1, 2],
    );
    // No draft authors/messages sneak into history.
    for (const v of page.versions) {
      assert.ok(v.message === "first" || v.message === "second");
    }
  });

  test("commit clears only the committed scene's draft", async () => {
    const dataDir = tempDataDir();
    const token = "drafts-token-other-scene";
    const { app, db } = await buildDraftsApp({
      dataDir,
      bootstrapToken: token,
    });
    await createScene(app, token, "A", "a");
    await createScene(app, token, "B", "b");

    await putDraft(app, token, { elements: [rect("da")], basedOnVersion: 0 }, "a");
    await putDraft(app, token, { elements: [rect("db")], basedOnVersion: 0 }, "b");
    assert.equal(db.countDrafts(), 2);

    const push = await pushScene(
      app,
      token,
      {
        parentVersion: 0,
        elements: [rect("a-committed")],
        message: "commit a",
      },
      "a",
    );
    assert.equal(push.statusCode, 201, push.body);

    assert.equal(db.countDrafts(), 1);
    const getA = await getDraft(app, token, "a");
    assert.equal(getA.statusCode, 404);
    const getB = await getDraft(app, token, "b");
    assert.equal(getB.statusCode, 200, getB.body);
    assert.equal(
      ((getB.json() as DraftResponse).elements[0] as { id: string }).id,
      "db",
    );
  });
});
