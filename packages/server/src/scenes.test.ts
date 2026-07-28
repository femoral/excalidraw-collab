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
import { allocateSlug, isValidSlug, slugifyName, type SceneInfo } from "./scenes.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-scenes-"));
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

async function buildScenesApp(opts: {
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

describe("slugifyName / allocateSlug / isValidSlug", () => {
  test("slugifyName lowercases and hyphenates", () => {
    assert.equal(slugifyName("Architecture Diagram"), "architecture-diagram");
    assert.equal(slugifyName("  Hello   World!  "), "hello-world");
    assert.equal(slugifyName("Café résumé"), "cafe-resume");
    assert.equal(slugifyName("!!!"), "scene");
  });

  test("isValidSlug accepts only lowercase slug form", () => {
    assert.equal(isValidSlug("arch"), true);
    assert.equal(isValidSlug("arch-v2"), true);
    assert.equal(isValidSlug("Architecture"), false);
    assert.equal(isValidSlug("-arch"), false);
    assert.equal(isValidSlug("arch-"), false);
    assert.equal(isValidSlug("arch--v2"), false);
    assert.equal(isValidSlug(""), false);
  });

  test("allocateSlug suffixes on collision including soft-deleted", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    db.insertScene({ id: "s1", slug: "arch", name: "A" });
    assert.equal(allocateSlug(db, "arch"), "arch-2");
    db.insertScene({ id: "s2", slug: "arch-2", name: "B" });
    assert.equal(allocateSlug(db, "arch"), "arch-3");
    db.softDeleteScene("s1");
    // Soft-deleted still occupies "arch".
    assert.equal(allocateSlug(db, "arch"), "arch-3");
  });
});

describe("POST /api/scenes", () => {
  test("creates with explicit slug", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-explicit";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "Architecture", slug: "arch" },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as SceneInfo;
    assert.equal(body.name, "Architecture");
    assert.equal(body.slug, "arch");
    assert.equal(body.headVersion, 0);
    assert.equal(body.elementCount, 0);
    assert.equal(body.lock, null);
    assert.equal(typeof body.id, "string");
    assert.equal(typeof body.createdAt, "string");
    assert.equal(typeof body.updatedAt, "string");
  });

  test("creates without slug (auto-derived from name)", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-auto";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "My Cool Board" },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as SceneInfo;
    assert.equal(body.name, "My Cool Board");
    assert.equal(body.slug, "my-cool-board");
    assert.equal(body.headVersion, 0);
  });

  test("collision-suffixes several scenes with the same name", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-collide";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const slugs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/scenes",
        headers: bearer(token),
        payload: { name: "Architecture" },
      });
      assert.equal(res.statusCode, 201, res.body);
      slugs.push((res.json() as SceneInfo).slug);
    }
    assert.deepEqual(slugs, ["architecture", "architecture-2", "architecture-3"]);
  });

  test("explicit slug collision returns 409", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-slug-conflict";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "A", slug: "taken" },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "B", slug: "taken" },
    });
    assert.equal(second.statusCode, 409);
    const body = second.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.CONFLICT);
  });

  test("requires authentication", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-auth";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/scenes",
      payload: { name: "Nope" },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.UNAUTHORIZED);
  });
});

describe("GET /api/scenes", () => {
  test("listing shape includes name, slug, head, updatedAt, lock, elementCount, headAuthor, thumbnailFileId", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-list";
    const { app, db } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "Board", slug: "board" },
    });
    assert.equal(create.statusCode, 201);
    const created = create.json() as SceneInfo;
    assert.equal(created.headAuthor, null);
    assert.equal(created.thumbnailFileId, null);

    // Attach a head version so elementCount is non-zero.
    const emptyApp = gzipJson({});
    const thumbId = "b".repeat(40);
    db.insertVersion({
      scene_id: created.id,
      version: 1,
      parent_version: null,
      author: "admin",
      message: "seed",
      elements: gzipJson([{ id: "e1" }, { id: "e2" }]),
      app_state: emptyApp,
      element_count: 2,
      thumbnail_file_id: thumbId,
    });
    db.updateSceneHead(created.id, 1);
    db.setSceneLock(created.id, "admin", "2099-01-01T00:00:00.000Z");

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { scenes: SceneInfo[] };
    assert.equal(body.scenes.length, 1);
    const item = body.scenes[0]!;
    assert.equal(item.name, "Board");
    assert.equal(item.slug, "board");
    assert.equal(item.headVersion, 1);
    assert.equal(typeof item.updatedAt, "string");
    assert.deepEqual(item.lock, {
      holder: "admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(item.elementCount, 2);
    assert.equal(item.headAuthor, "admin");
    assert.equal(item.thumbnailFileId, thumbId);
  });
});

describe("PATCH /api/scenes/:slug", () => {
  test("renames display name without changing slug", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-rename";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "Old Name", slug: "keep-me" },
    });
    assert.equal(create.statusCode, 201);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/scenes/keep-me",
      headers: bearer(token),
      payload: { name: "New Name" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SceneInfo;
    assert.equal(body.name, "New Name");
    assert.equal(body.slug, "keep-me");
  });

  test("unknown slug returns 404", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-rename-404";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/scenes/missing",
      headers: bearer(token),
      payload: { name: "Nope" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as ErrorEnvelope).error.code, ErrorCode.NOT_FOUND);
  });
});

describe("GET /api/scenes/:slug", () => {
  test("returns metadata plus head", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-get";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "Detail", slug: "detail" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/detail",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as SceneInfo;
    assert.equal(body.slug, "detail");
    assert.equal(body.name, "Detail");
    assert.equal(body.headVersion, 0);
    assert.equal(body.elementCount, 0);
    assert.equal(body.lock, null);
  });

  test("unknown slug returns 404 with standard envelope", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-404";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/scenes/does-not-exist",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.NOT_FOUND);
    assert.match(body.error.message, /does-not-exist/);
  });
});

describe("DELETE /api/scenes/:slug", () => {
  test("soft delete removes from listings while rows persist", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-delete";
    const { app, db } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/scenes",
      headers: bearer(token),
      payload: { name: "Temp", slug: "temp" },
    });
    assert.equal(created.statusCode, 201);
    const scene = created.json() as SceneInfo;

    // Version history that must survive soft delete.
    db.insertVersion({
      scene_id: scene.id,
      version: 1,
      parent_version: null,
      author: "admin",
      message: "keep me",
      elements: gzipJson([]),
      app_state: gzipJson({}),
      element_count: 0,
    });
    db.updateSceneHead(scene.id, 1);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/scenes/temp",
      headers: bearer(token),
    });
    assert.equal(del.statusCode, 204);

    const list = await app.inject({
      method: "GET",
      url: "/api/scenes",
      headers: bearer(token),
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual((list.json() as { scenes: SceneInfo[] }).scenes, []);

    const get = await app.inject({
      method: "GET",
      url: "/api/scenes/temp",
      headers: bearer(token),
    });
    assert.equal(get.statusCode, 404);
    assert.equal((get.json() as ErrorEnvelope).error.code, ErrorCode.NOT_FOUND);

    // Rows survive: scene row + version still in the database.
    const row = db.getSceneBySlugIncludingDeleted("temp");
    assert.ok(row);
    assert.equal(typeof row.deleted_at, "string");
    assert.equal(db.listVersions(scene.id).length, 1);
    assert.equal(db.slugExists("temp"), true);
  });

  test("delete unknown slug returns 404", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-scenes-token-del-404";
    const { app } = await buildScenesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/scenes/missing",
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as ErrorEnvelope).error.code, ErrorCode.NOT_FOUND);
  });
});
