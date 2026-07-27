import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import {
  DB_FILENAME,
  gzipJson,
  gunzipJson,
  hashToken,
  openDatabase,
} from "./db.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";

/** Each test gets its own temp DATA_DIR; cleaned in afterEach. */
const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-db-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    serveStatic: false,
    logLevel: "silent",
    ...overrides,
  };
}

describe("Database migrations", () => {
  test("fresh DATA_DIR creates full schema via migration 001", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    try {
      const tables = db.listUserTables();
      assert.deepEqual(tables.sort(), [
        "drafts",
        "scenes",
        "schema_migrations",
        "tokens",
        "versions",
      ]);

      const migrations = db.listMigrations();
      assert.equal(migrations.length, 1);
      assert.equal(migrations[0]!.id, 1);
      assert.equal(migrations[0]!.name, "001_initial_schema");
      assert.equal(typeof migrations[0]!.applied_at, "string");

      // File-backed path is under DATA_DIR.
      assert.equal(db.dbPath, path.join(path.resolve(dataDir), DB_FILENAME));
    } finally {
      db.close();
    }
  });

  test("re-running migrations against an up-to-date database is a no-op", () => {
    const dataDir = tempDataDir();
    const db1 = openDatabase(dataDir);
    const first = db1.listMigrations();
    assert.equal(first.length, 1);
    db1.close();

    // Re-open same directory — migrate runs again.
    const db2 = openDatabase(dataDir);
    try {
      db2.migrateAgain();
      const second = db2.listMigrations();
      assert.equal(second.length, 1);
      assert.equal(second[0]!.id, first[0]!.id);
      assert.equal(second[0]!.name, first[0]!.name);
      assert.equal(second[0]!.applied_at, first[0]!.applied_at);

      // Schema still intact; insert still works.
      db2.insertScene({
        id: "s1",
        slug: "arch",
        name: "Architecture",
      });
      assert.equal(db2.getSceneBySlug("arch")?.name, "Architecture");
    } finally {
      db2.close();
    }
  });

  test("WAL mode is active on file-backed databases", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    try {
      assert.equal(db.journalMode(), "wal");
      assert.equal(db.foreignKeysEnabled(), true);
    } finally {
      db.close();
    }
  });
});

describe("Database constraints", () => {
  test("scenes.slug uniqueness rejects a duplicate slug", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    try {
      db.insertScene({ id: "s1", slug: "arch", name: "A" });
      assert.throws(
        () => db.insertScene({ id: "s2", slug: "arch", name: "B" }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /UNIQUE constraint failed/i);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("foreign keys reject an orphan versions row", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    try {
      assert.equal(db.foreignKeysEnabled(), true);
      const empty = gzipJson([]);
      assert.throws(
        () =>
          db.insertVersion({
            scene_id: "missing-scene",
            version: 1,
            parent_version: null,
            author: "agent",
            message: "orphan",
            elements: empty,
            app_state: empty,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /FOREIGN KEY constraint failed/i);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  test("foreign keys reject an orphan drafts row", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    try {
      const empty = gzipJson([]);
      assert.throws(
        () =>
          db.upsertDraft({
            scene_id: "missing-scene",
            elements: empty,
            app_state: empty,
            updated_by: "human",
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /FOREIGN KEY constraint failed/i);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });
});

describe("typed data-access layer", () => {
  test("round-trips scenes, versions, drafts, and tokens with gzip blobs", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    try {
      const scene = db.insertScene({
        id: "scene-1",
        slug: "arch",
        name: "Architecture",
      });
      assert.equal(scene.head_version, 0);
      assert.equal(db.getSceneBySlug("arch")?.id, "scene-1");

      const elements = [{ id: "e1", type: "rectangle", x: 0, y: 0 }];
      const appState = { viewBackgroundColor: "#ffffff" };
      const elementsBlob = gzipJson(elements);
      const appStateBlob = gzipJson(appState);

      const version = db.insertVersion({
        scene_id: scene.id,
        version: 1,
        parent_version: null,
        author: "agent",
        message: "initial",
        elements: elementsBlob,
        app_state: appStateBlob,
        file_ids: ["abc123"],
        element_count: 1,
        scene_hash: "hash-1",
      });
      assert.equal(version.version, 1);
      assert.deepEqual(gunzipJson(version.elements), elements);
      assert.deepEqual(gunzipJson(version.app_state), appState);
      assert.equal(version.file_ids, JSON.stringify(["abc123"]));

      db.updateSceneHead(scene.id, 1);
      assert.equal(db.getSceneById(scene.id)?.head_version, 1);

      const draft = db.upsertDraft({
        scene_id: scene.id,
        elements: gzipJson([{ id: "e2", type: "text" }]),
        app_state: appStateBlob,
        updated_by: "human",
      });
      assert.equal(draft.updated_by, "human");
      assert.equal(db.getDraft(scene.id)?.scene_id, scene.id);

      const tokenHash = hashToken("secret-token-value");
      const token = db.insertToken({
        id: "tok-1",
        name: "admin",
        token_hash: tokenHash,
      });
      assert.equal(db.getTokenByHash(tokenHash)?.name, "admin");
      assert.equal(token.last_used_at, null);
      db.touchToken(token.id);
      assert.equal(typeof db.getTokenById(token.id)?.last_used_at, "string");
    } finally {
      db.close();
    }
  });

  test("isHealthy is true while open and false after close", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    assert.equal(db.isHealthy(), true);
    db.close();
    assert.equal(db.isHealthy(), false);
  });

  test("hashToken is stable SHA-256 hex", () => {
    const a = hashToken("hello");
    const b = hashToken("hello");
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.match(a, /^[0-9a-f]+$/);
  });
});

describe("/readyz with live database", () => {
  test("GET /readyz returns 200 with a live DB readiness check", async () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        config: testConfig({ dataDir }),
        readinessCheck: () => db.isHealthy(),
        fastifyOpts: { logger: false },
      });

      const res = await app.inject({ method: "GET", url: "/readyz" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { status: "ready" });
    } finally {
      if (app) await app.close();
      db.close();
    }
  });

  test("GET /readyz returns non-200 when the DB is closed / broken", async () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    // Close immediately so the readiness check fails.
    db.close();

    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        config: testConfig({ dataDir }),
        readinessCheck: () => db.isHealthy(),
        fastifyOpts: { logger: false },
      });

      const res = await app.inject({ method: "GET", url: "/readyz" });
      assert.ok(
        res.statusCode >= 400,
        `expected non-200, got ${res.statusCode}`,
      );
      assert.equal(res.statusCode, 503);
      const body = res.json() as ErrorEnvelope;
      assert.equal(body.error.code, ErrorCode.NOT_READY);
    } finally {
      if (app) await app.close();
    }
  });
});
