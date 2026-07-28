/**
 * Backup / restore: SQLite backup API + portable archive + collision policy.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildApp } from "./app.js";
import {
  BACKUP_FORMAT,
  BACKUP_README,
  buildBackupArchive,
  restoreBackupArchive,
  type RestoreReport,
} from "./backup.js";
import { openDatabase, type Database } from "./db.js";
import { FileStore } from "./files.js";
import { unpackTarGz } from "./tar.js";
import { gzipJson } from "./db.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openDbs.length > 0) {
    try {
      openDbs.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function sha1(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** Seed two scenes with multi-version history and one shared image. */
function seedRichData(dataDir: string): {
  db: Database;
  store: FileStore;
  imageBytes: Buffer;
  fileId: string;
  sceneA: { id: string; slug: string };
  sceneB: { id: string; slug: string };
} {
  const db = openDatabase(dataDir);
  openDbs.push(db);
  const store = new FileStore(dataDir, 10 * 1024 * 1024);

  const imageBytes = Buffer.from("fake-png-payload-for-backup-test-" + "x".repeat(64), "utf8");
  const fileId = sha1(imageBytes);
  store.put({
    bytes: imageBytes,
    mimeType: "image/png",
    created: 1_700_000_000_000,
    claimedFileId: fileId,
  });

  const sceneA = { id: "scene-a-id", slug: "arch" };
  const sceneB = { id: "scene-b-id", slug: "notes" };

  db.insertScene({
    id: sceneA.id,
    slug: sceneA.slug,
    name: "Architecture",
    head_version: 0,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
  });
  db.insertVersion({
    scene_id: sceneA.id,
    version: 1,
    parent_version: null,
    author: "admin",
    message: "initial",
    created_at: "2024-01-01T00:00:01.000Z",
    elements: gzipJson([{ id: "r1", type: "rectangle", x: 0, y: 0 }]),
    app_state: gzipJson({ viewBackgroundColor: "#ffffff" }),
    file_ids: [],
    element_count: 1,
    scene_hash: "hash-a1",
  });
  db.insertVersion({
    scene_id: sceneA.id,
    version: 2,
    parent_version: 1,
    author: "agent",
    message: "added screenshot",
    created_at: "2024-01-01T00:00:02.000Z",
    elements: gzipJson([
      { id: "r1", type: "rectangle", x: 0, y: 0 },
      { id: "img1", type: "image", fileId },
    ]),
    app_state: gzipJson({ viewBackgroundColor: "#f8f9fa" }),
    file_ids: [fileId],
    element_count: 2,
    scene_hash: "hash-a2",
  });
  db.insertVersion({
    scene_id: sceneA.id,
    version: 3,
    parent_version: 2,
    author: "human",
    message: "tweaked layout",
    created_at: "2024-01-01T00:00:03.000Z",
    elements: gzipJson([
      { id: "r1", type: "rectangle", x: 10, y: 10 },
      { id: "img1", type: "image", fileId },
    ]),
    app_state: gzipJson({ viewBackgroundColor: "#f8f9fa" }),
    file_ids: [fileId],
    element_count: 2,
    scene_hash: "hash-a3",
  });
  db.updateSceneHead(sceneA.id, 3, "2024-01-01T00:00:03.000Z");

  db.insertScene({
    id: sceneB.id,
    slug: sceneB.slug,
    name: "Notes",
    head_version: 0,
    created_at: "2024-01-02T00:00:00.000Z",
    updated_at: "2024-01-02T00:00:00.000Z",
  });
  db.insertVersion({
    scene_id: sceneB.id,
    version: 1,
    parent_version: null,
    author: "admin",
    message: "blank notes",
    created_at: "2024-01-02T00:00:01.000Z",
    elements: gzipJson([]),
    app_state: gzipJson({}),
    file_ids: [],
    element_count: 0,
    scene_hash: "hash-b1",
  });
  db.updateSceneHead(sceneB.id, 1, "2024-01-02T00:00:01.000Z");

  return { db, store, imageBytes, fileId, sceneA, sceneB };
}

test("sqlite.backupTo produces a readable consistent snapshot file", async () => {
  const dataDir = tempDir("backup-sqlite-");
  const { db } = seedRichData(dataDir);
  const snap = path.join(tempDir("backup-snap-"), "snap.sqlite");
  const pages = await db.backupTo(snap);
  assert.ok(pages > 0);
  assert.ok(fs.existsSync(snap));

  const { DatabaseSync } = await import("node:sqlite");
  const ro = new DatabaseSync(snap, { readOnly: true });
  try {
    const n = ro.prepare("SELECT COUNT(*) AS n FROM scenes").get() as {
      n: number;
    };
    assert.equal(Number(n.n), 2);
    const versions = ro.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number };
    assert.equal(Number(versions.n), 4);
  } finally {
    ro.close();
  }
});

test("buildBackupArchive documents layout and includes history + files", async () => {
  const dataDir = tempDir("backup-arch-");
  const { db, store, fileId, imageBytes } = seedRichData(dataDir);
  const { bytes, manifest } = await buildBackupArchive(db, store);

  assert.equal(manifest.format, BACKUP_FORMAT);
  assert.equal(manifest.sceneCount, 2);
  assert.equal(manifest.fileCount, 1);
  assert.ok(bytes[0] === 0x1f && bytes[1] === 0x8b);

  const entries = unpackTarGz(bytes);
  const names = new Set(entries.map((e) => e.name));
  assert.ok(names.has("README.md"));
  assert.ok(names.has("MANIFEST.json"));
  assert.ok(names.has("scenes/arch/meta.json"));
  assert.ok(names.has("scenes/arch/versions/1.json"));
  assert.ok(names.has("scenes/arch/versions/2.json"));
  assert.ok(names.has("scenes/arch/versions/3.json"));
  assert.ok(names.has("scenes/notes/meta.json"));
  assert.ok(names.has("scenes/notes/versions/1.json"));
  assert.ok(names.has(`files/${fileId}`));
  assert.ok(names.has(`files/${fileId}.json`));

  const readme = entries.find((e) => e.name === "README.md")!;
  assert.ok(readme.data.toString("utf8").includes("scenes/<slug>/meta.json"));
  assert.ok(readme.data.toString("utf8").length > 100);
  // README constant stays in sync with archive.
  assert.ok(BACKUP_README.includes("MANIFEST.json"));

  const v3 = JSON.parse(
    entries.find((e) => e.name === "scenes/arch/versions/3.json")!.data.toString("utf8"),
  ) as {
    version: number;
    parentVersion: number;
    author: string;
    message: string;
    fileIds: string[];
  };
  assert.equal(v3.version, 3);
  assert.equal(v3.parentVersion, 2);
  assert.equal(v3.author, "human");
  assert.equal(v3.message, "tweaked layout");
  assert.deepEqual(v3.fileIds, [fileId]);

  const blob = entries.find((e) => e.name === `files/${fileId}`)!;
  assert.deepEqual(blob.data, imageBytes);
});

test("restore into empty DATA_DIR preserves versions, authors, messages, images", async () => {
  const srcDir = tempDir("backup-src-");
  const { db: srcDb, store: srcStore, imageBytes, fileId, sceneA, sceneB } = seedRichData(srcDir);
  const { bytes } = await buildBackupArchive(srcDb, srcStore);

  // Wipe source and open a fresh empty target.
  srcDb.close();
  openDbs.pop();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });

  const dstDb = openDatabase(srcDir);
  openDbs.push(dstDb);
  const dstStore = new FileStore(srcDir, 10 * 1024 * 1024);

  const report = restoreBackupArchive(dstDb, dstStore, bytes, "skip");
  assert.deepEqual(report.restored.slice().sort(), ["arch", "notes"]);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.filesRestored, 1);
  assert.ok(report.messages.some((m) => /Restored arch/.test(m)));

  const arch = dstDb.getSceneBySlug("arch")!;
  assert.equal(arch.slug, sceneA.slug);
  assert.equal(arch.head_version, 3);
  assert.equal(arch.name, "Architecture");

  const v1 = dstDb.getVersion(arch.id, 1)!;
  const v2 = dstDb.getVersion(arch.id, 2)!;
  const v3 = dstDb.getVersion(arch.id, 3)!;
  assert.equal(v1.author, "admin");
  assert.equal(v1.message, "initial");
  assert.equal(v1.parent_version, null);
  assert.equal(v2.author, "agent");
  assert.equal(v2.parent_version, 1);
  assert.equal(v3.author, "human");
  assert.equal(v3.message, "tweaked layout");
  assert.equal(v3.parent_version, 2);
  assert.equal(v3.scene_hash, "hash-a3");

  const notes = dstDb.getSceneBySlug("notes")!;
  assert.equal(notes.head_version, 1);
  assert.equal(dstDb.getVersion(notes.id, 1)!.author, "admin");

  const stored = dstStore.get(fileId)!;
  assert.deepEqual(stored.bytes, imageBytes);
  assert.equal(stored.mimeType, "image/png");
  void sceneB;
});

test("restore collision policy skip is visible; overwrite replaces history", async () => {
  const srcDir = tempDir("backup-coll-src-");
  const { db: srcDb, store: srcStore } = seedRichData(srcDir);
  const { bytes } = await buildBackupArchive(srcDb, srcStore);

  const dstDir = tempDir("backup-coll-dst-");
  const dstDb = openDatabase(dstDir);
  openDbs.push(dstDb);
  const dstStore = new FileStore(dstDir, 10 * 1024 * 1024);

  // Pre-existing "arch" with different history.
  dstDb.insertScene({
    id: "existing-arch",
    slug: "arch",
    name: "Old Arch",
    head_version: 0,
  });
  dstDb.insertVersion({
    scene_id: "existing-arch",
    version: 1,
    parent_version: null,
    author: "local",
    message: "local only",
    elements: gzipJson([{ id: "x", type: "text" }]),
    app_state: gzipJson({}),
    file_ids: [],
    element_count: 1,
    scene_hash: "local-hash",
  });
  dstDb.updateSceneHead("existing-arch", 1);

  const skipped = restoreBackupArchive(dstDb, dstStore, bytes, "skip");
  assert.ok(skipped.skipped.includes("arch"));
  assert.ok(skipped.restored.includes("notes"));
  assert.ok(skipped.messages.some((m) => /Skipped arch/.test(m)));
  // Existing history untouched.
  assert.equal(dstDb.getSceneBySlug("arch")!.head_version, 1);
  assert.equal(dstDb.getVersion("existing-arch", 1)!.author, "local");

  const over = restoreBackupArchive(dstDb, dstStore, bytes, "overwrite");
  assert.ok(over.overwritten.includes("arch"));
  assert.ok(over.messages.some((m) => /Overwrote arch/.test(m)));
  const arch = dstDb.getSceneBySlug("arch")!;
  assert.equal(arch.head_version, 3);
  assert.equal(dstDb.getVersion(arch.id, 3)!.author, "human");
  assert.equal(dstDb.getVersion(arch.id, 1)!.message, "initial");
});

test("restore collision policy abort fails with 409-shaped AppError and report", async () => {
  const srcDir = tempDir("backup-abort-src-");
  const { db: srcDb, store: srcStore } = seedRichData(srcDir);
  const { bytes } = await buildBackupArchive(srcDb, srcStore);

  const dstDir = tempDir("backup-abort-dst-");
  const dstDb = openDatabase(dstDir);
  openDbs.push(dstDb);
  const dstStore = new FileStore(dstDir, 10 * 1024 * 1024);
  dstDb.insertScene({
    id: "x",
    slug: "arch",
    name: "X",
    head_version: 0,
  });

  await assert.rejects(
    async () => {
      restoreBackupArchive(dstDb, dstStore, bytes, "abort");
    },
    (err: unknown) => {
      assert.ok(err && typeof err === "object" && "statusCode" in err);
      const e = err as { statusCode: number; code: string; details?: { report?: RestoreReport } };
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, "CONFLICT");
      assert.ok(e.details?.report?.messages.some((m) => /Aborted/.test(m)));
      return true;
    },
  );
});

test("HTTP GET /api/backup and POST /api/restore round-trip via inject", async () => {
  const dataDir = tempDir("backup-http-");
  const token = "bootstrap-backup-http-token";
  const { db, imageBytes, fileId } = seedRichData(dataDir);
  // Re-open is already done; seed used openDatabase. Need bootstrap token.
  // seedRichData didn't seed tokens — buildApp will seed bootstrap.
  const app = await buildApp({
    config: {
      port: 0,
      dataDir,
      bootstrapToken: token,
      renderWorker: "off",
      logLevel: "silent",
      serveStatic: false,
      staticRoot: "",
      maxFileBytes: 10 * 1024 * 1024,
    },
    db,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });

  try {
    const bak = await app.inject({
      method: "GET",
      url: "/api/backup",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(bak.statusCode, 200, bak.body);
    assert.match(bak.headers["content-type"] as string, /gzip/);
    assert.equal(bak.headers["x-backup-scene-count"], "2");
    const archive = Buffer.from(bak.rawPayload);

    // Wipe data dir contents while keeping process... actually delete via restore
    // into wiped dir: close, wipe, reopen, re-seed bootstrap, restore.
    await app.close();
    db.close();
    openDbs.pop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const db2 = openDatabase(dataDir);
    openDbs.push(db2);
    const app2 = await buildApp({
      config: {
        port: 0,
        dataDir,
        bootstrapToken: token,
        renderWorker: "off",
        logLevel: "silent",
        serveStatic: false,
        staticRoot: "",
        maxFileBytes: 10 * 1024 * 1024,
      },
      db: db2,
      readinessCheck: () => db2.isHealthy(),
      fastifyOpts: { logger: false },
    });

    try {
      const res = await app2.inject({
        method: "POST",
        url: "/api/restore?onCollision=skip",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/gzip",
        },
        payload: archive,
      });
      assert.equal(res.statusCode, 200, res.body);
      const report = res.json() as RestoreReport;
      assert.ok(report.restored.includes("arch"));
      assert.ok(report.restored.includes("notes"));
      assert.equal(report.filesRestored, 1);

      const meta = await app2.inject({
        method: "GET",
        url: "/api/scenes/arch",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(meta.statusCode, 200);
      assert.equal(meta.json().headVersion, 3);

      const versions = await app2.inject({
        method: "GET",
        url: "/api/scenes/arch/versions",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(versions.statusCode, 200);
      const list = versions.json() as {
        versions: Array<{
          version: number;
          author: string;
          message: string;
          parentVersion: number | null;
        }>;
      };
      assert.equal(list.versions.length, 3);
      const byV = Object.fromEntries(list.versions.map((v) => [v.version, v]));
      assert.equal(byV[1]!.author, "admin");
      assert.equal(byV[2]!.author, "agent");
      assert.equal(byV[3]!.author, "human");
      assert.equal(byV[3]!.message, "tweaked layout");
      assert.equal(byV[3]!.parentVersion, 2);

      const file = await app2.inject({
        method: "GET",
        url: `/api/files/${fileId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(file.statusCode, 200);
      assert.deepEqual(Buffer.from(file.rawPayload), imageBytes);
    } finally {
      await app2.close();
    }
  } finally {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }
});

test("GET /api/backup requires admin", async () => {
  const dataDir = tempDir("backup-auth-");
  const admin = "admin-tok";
  const db = openDatabase(dataDir);
  openDbs.push(db);
  const app = await buildApp({
    config: {
      port: 0,
      dataDir,
      bootstrapToken: admin,
      renderWorker: "off",
      logLevel: "silent",
      serveStatic: false,
      staticRoot: "",
      maxFileBytes: 1024 * 1024,
    },
    db,
    fastifyOpts: { logger: false },
  });
  try {
    // Mint a non-admin token.
    const minted = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        authorization: `Bearer ${admin}`,
        "content-type": "application/json",
      },
      payload: { name: "agent", isAdmin: false },
    });
    assert.equal(minted.statusCode, 201);
    const agentToken = (minted.json() as { token: string }).token;

    const denied = await app.inject({
      method: "GET",
      url: "/api/backup",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await app.close();
  }
});
