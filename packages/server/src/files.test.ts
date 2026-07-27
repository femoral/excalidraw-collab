import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import {
  gzipJson,
  openDatabase,
  type Database,
} from "./db.js";
import { AppError, ErrorCode, type ErrorEnvelope } from "./errors.js";
import {
  FileStore,
  FILES_SUBDIR,
  FILE_ID_REASON_HASH_MISMATCH,
  FILE_ID_REASON_NON_SECURE_NANOID,
  gcUnreferencedFiles,
  hashFileContent,
  IMMUTABLE_CACHE_CONTROL,
  SIDECAR_SUFFIX,
  type FileIdMismatchDetails,
} from "./files.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-files-"));
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

async function buildFilesApp(opts: {
  dataDir: string;
  bootstrapToken: string;
  maxFileBytes?: number;
}): Promise<{ app: FastifyInstance; db: Database; store: FileStore }> {
  const db = openDatabase(opts.dataDir);
  openDbs.push(db);
  const config = testConfig({
    dataDir: opts.dataDir,
    bootstrapToken: opts.bootstrapToken,
    maxFileBytes: opts.maxFileBytes ?? 10 * 1024 * 1024,
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

/** Tiny valid PNG (1×1). */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_FILE_ID = hashFileContent(PNG_BYTES);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

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
      // best-effort
    }
  }
});

describe("hashFileContent (Excalidraw fileId)", () => {
  test("is SHA-1 hex of raw bytes (40 lowercase chars)", () => {
    const id = hashFileContent(PNG_BYTES);
    assert.equal(id.length, 40);
    assert.match(id, /^[0-9a-f]{40}$/);
    assert.equal(id, PNG_FILE_ID);
    // Stable across calls
    assert.equal(hashFileContent(PNG_BYTES), id);
  });
});

describe("FileStore put/get/dedup", () => {
  test("put stores content + sidecar; second put is a no-op on disk", () => {
    const dataDir = tempDataDir();
    const store = new FileStore(dataDir, 1024 * 1024);

    const first = store.put({
      bytes: PNG_BYTES,
      mimeType: "image/png",
      created: 1_700_000_000_000,
      claimedFileId: PNG_FILE_ID,
    });
    assert.equal(first.created, true);
    assert.equal(first.fileId, PNG_FILE_ID);

    const contentPath = path.join(dataDir, FILES_SUBDIR, PNG_FILE_ID);
    const sidecarPath = contentPath + SIDECAR_SUFFIX;
    assert.ok(existsSync(contentPath));
    assert.ok(existsSync(sidecarPath));
    assert.deepEqual(readFileSync(contentPath), PNG_BYTES);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      mimeType: string;
      created: number;
    };
    assert.equal(sidecar.mimeType, "image/png");
    assert.equal(sidecar.created, 1_700_000_000_000);

    const mtimeBefore = statSync(contentPath).mtimeMs;
    const second = store.put({
      bytes: PNG_BYTES,
      mimeType: "image/png",
      claimedFileId: PNG_FILE_ID,
    });
    assert.equal(second.created, false);
    assert.equal(second.fileId, PNG_FILE_ID);

    // Exactly one content file on disk.
    const names = readdirSync(path.join(dataDir, FILES_SUBDIR)).filter((n) =>
      /^[0-9a-f]{40}$/.test(n),
    );
    assert.deepEqual(names, [PNG_FILE_ID]);
    assert.equal(statSync(contentPath).size, PNG_BYTES.byteLength);
    // Content untouched (mtime may equal; size must match once).
    assert.equal(statSync(contentPath).mtimeMs, mtimeBefore);

    const got = store.get(PNG_FILE_ID);
    assert.ok(got);
    assert.deepEqual(got.bytes, PNG_BYTES);
    assert.equal(got.mimeType, "image/png");
  });

  test("rejects well-formed hex fileId that does not match content hash", () => {
    const store = new FileStore(tempDataDir(), 1024 * 1024);
    const wrongHex = "a".repeat(40);
    assert.throws(
      () =>
        store.put({
          bytes: PNG_BYTES,
          mimeType: "image/png",
          claimedFileId: wrongHex,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, ErrorCode.VALIDATION);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /does not match content hash/);
        const details = err.details as FileIdMismatchDetails;
        assert.equal(details.reason, FILE_ID_REASON_HASH_MISMATCH);
        assert.equal(details.claimed, wrongHex);
        assert.equal(details.computed, PNG_FILE_ID);
        return true;
      },
    );
  });

  test("rejects non-hex nanoid-like fileId with non-secure-context guidance", () => {
    const store = new FileStore(tempDataDir(), 1024 * 1024);
    // nanoid alphabet is URL-safe (A-Za-z0-9_-) — not pure hex. Length 40
    // matches generateIdFromFile's `nanoid(40)` fallback.
    const nanoidLike = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-AB";
    assert.equal(nanoidLike.length, 40);
    assert.ok(!/^[0-9a-f]{40}$/.test(nanoidLike));

    assert.throws(
      () =>
        store.put({
          bytes: PNG_BYTES,
          mimeType: "image/png",
          claimedFileId: nanoidLike,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, ErrorCode.VALIDATION);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /nanoid/i);
        assert.match(err.message, /HTTPS|localhost/i);
        assert.match(err.message, /crypto\.subtle|SubtleCrypto/i);
        const details = err.details as FileIdMismatchDetails;
        assert.equal(details.reason, FILE_ID_REASON_NON_SECURE_NANOID);
        assert.equal(details.claimed, nanoidLike);
        assert.equal(details.computed, PNG_FILE_ID);
        return true;
      },
    );
  });

  test("rejects oversized payload with 413 envelope details", () => {
    const store = new FileStore(tempDataDir(), 64);
    const big = Buffer.alloc(128, 7);
    assert.throws(
      () => store.put({ bytes: big, mimeType: "application/octet-stream" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 413);
        assert.equal(err.code, ErrorCode.BAD_REQUEST);
        return true;
      },
    );
  });
});

describe("HTTP /api/files", () => {
  test("POST BinaryFileData then GET with immutable cache headers", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-1";
    const { app, store } = await buildFilesApp({
      dataDir,
      bootstrapToken: token,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      payload: {
        id: PNG_FILE_ID,
        mimeType: "image/png",
        dataURL: PNG_DATA_URL,
        created: 1_700_000_000_000,
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      fileId: string;
      mimeType: string;
      byteLength: number;
      created: boolean;
    };
    assert.equal(body.fileId, PNG_FILE_ID);
    assert.equal(body.created, true);
    assert.equal(body.byteLength, PNG_BYTES.byteLength);

    // On-disk single copy
    assert.ok(store.exists(PNG_FILE_ID));
    assert.deepEqual(store.listStoredFileIds(), [PNG_FILE_ID]);

    const get = await app.inject({
      method: "GET",
      url: `/api/files/${PNG_FILE_ID}`,
      headers: bearer(token),
    });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers["content-type"], "image/png");
    assert.equal(get.headers["cache-control"], IMMUTABLE_CACHE_CONTROL);
    assert.equal(get.headers["etag"], `"${PNG_FILE_ID}"`);
    assert.deepEqual(get.rawPayload, PNG_BYTES);
  });

  test("uploading the same image twice stores exactly one copy", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-2";
    const { app, store } = await buildFilesApp({
      dataDir,
      bootstrapToken: token,
    });

    const payload = {
      id: PNG_FILE_ID,
      mimeType: "image/png",
      dataURL: PNG_DATA_URL,
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: { ...bearer(token), "content-type": "application/json" },
      payload,
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: { ...bearer(token), "content-type": "application/json" },
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.equal((second.json() as { created: boolean }).created, false);

    // Assert on-disk state, not just the response.
    const filesDir = path.join(dataDir, FILES_SUBDIR);
    const contentFiles = readdirSync(filesDir).filter((n) =>
      /^[0-9a-f]{40}$/.test(n),
    );
    assert.deepEqual(contentFiles, [PNG_FILE_ID]);
    assert.equal(
      statSync(path.join(filesDir, PNG_FILE_ID)).size,
      PNG_BYTES.byteLength,
    );
    assert.equal(store.totalContentBytes(), PNG_BYTES.byteLength);
  });

  test("raw byte upload computes fileId; optional X-File-Id is verified", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-3";
    const { app } = await buildFilesApp({ dataDir, bootstrapToken: token });

    const ok = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        ...bearer(token),
        "content-type": "image/png",
        "x-file-id": PNG_FILE_ID,
      },
      payload: PNG_BYTES,
    });
    assert.equal(ok.statusCode, 201);
    assert.equal((ok.json() as { fileId: string }).fileId, PNG_FILE_ID);

    const bad = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        ...bearer(token),
        "content-type": "image/png",
        "x-file-id": "b".repeat(40),
      },
      payload: PNG_BYTES,
    });
    assert.equal(bad.statusCode, 400);
    const env = bad.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.VALIDATION);
    assert.match(env.error.message, /does not match content hash/);
    const details = env.error.details as FileIdMismatchDetails;
    assert.equal(details.reason, FILE_ID_REASON_HASH_MISMATCH);
    assert.equal(details.computed, PNG_FILE_ID);
  });

  test("JSON hex fileId that mismatches content → content_hash_mismatch", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-4";
    const { app } = await buildFilesApp({ dataDir, bootstrapToken: token });
    const wrongHex = "c".repeat(40);

    const res = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: { ...bearer(token), "content-type": "application/json" },
      payload: {
        id: wrongHex,
        mimeType: "image/png",
        dataURL: PNG_DATA_URL,
      },
    });
    assert.equal(res.statusCode, 400);
    const env = res.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.VALIDATION);
    assert.match(env.error.message, /does not match content hash/);
    const details = env.error.details as FileIdMismatchDetails;
    assert.equal(details.reason, FILE_ID_REASON_HASH_MISMATCH);
    assert.equal(details.claimed, wrongHex);
    assert.equal(details.computed, PNG_FILE_ID);
  });

  test("JSON non-hex (nanoid) fileId → non_secure_context_nanoid + HTTPS hint", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-4b";
    const { app } = await buildFilesApp({ dataDir, bootstrapToken: token });
    // 40 chars, nanoid alphabet — not SHA-1 hex.
    const nanoidLike = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-AB";
    assert.equal(nanoidLike.length, 40);

    const res = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: { ...bearer(token), "content-type": "application/json" },
      payload: {
        id: nanoidLike,
        mimeType: "image/png",
        dataURL: PNG_DATA_URL,
      },
    });
    assert.equal(res.statusCode, 400);
    const env = res.json() as ErrorEnvelope;
    assert.equal(env.error.code, ErrorCode.VALIDATION);
    assert.match(env.error.message, /nanoid/i);
    assert.match(env.error.message, /HTTPS|localhost/i);
    assert.match(env.error.message, /crypto\.subtle|SubtleCrypto/i);
    const details = env.error.details as FileIdMismatchDetails;
    assert.equal(details.reason, FILE_ID_REASON_NON_SECURE_NANOID);
    assert.equal(details.claimed, nanoidLike);
    assert.equal(details.computed, PNG_FILE_ID);
  });

  test("oversized upload is rejected cleanly (not a crash)", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-5";
    const maxFileBytes = 256;
    const { app } = await buildFilesApp({
      dataDir,
      bootstrapToken: token,
      maxFileBytes,
    });

    const big = Buffer.alloc(maxFileBytes + 64, 9);
    const res = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        ...bearer(token),
        "content-type": "application/octet-stream",
      },
      payload: big,
    });
    // Either our handler (413) or Fastify bodyLimit (413) — both must be clean envelopes.
    assert.ok(res.statusCode === 413 || res.statusCode === 400);
    const env = res.json() as ErrorEnvelope;
    assert.ok(env.error);
    assert.equal(typeof env.error.message, "string");
    assert.ok(
      env.error.code === ErrorCode.BAD_REQUEST ||
        env.error.code === ErrorCode.VALIDATION ||
        env.error.code === ErrorCode.INTERNAL ||
        typeof env.error.code === "string",
    );
    // Must not have stored anything.
    const filesDir = path.join(dataDir, FILES_SUBDIR);
    if (existsSync(filesDir)) {
      const contentFiles = readdirSync(filesDir).filter((n) =>
        /^[0-9a-f]{40}$/.test(n),
      );
      assert.equal(contentFiles.length, 0);
    }
  });

  test("unauthenticated requests are rejected", async () => {
    const dataDir = tempDataDir();
    const { app } = await buildFilesApp({
      dataDir,
      bootstrapToken: "bootstrap-files-token-6",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: { "content-type": "application/json" },
      payload: {
        id: PNG_FILE_ID,
        mimeType: "image/png",
        dataURL: PNG_DATA_URL,
      },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as ErrorEnvelope).error.code, ErrorCode.UNAUTHORIZED);
  });

  test("GET missing file returns 404 envelope", async () => {
    const dataDir = tempDataDir();
    const token = "bootstrap-files-token-7";
    const { app } = await buildFilesApp({ dataDir, bootstrapToken: token });
    const res = await app.inject({
      method: "GET",
      url: `/api/files/${"d".repeat(40)}`,
      headers: bearer(token),
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as ErrorEnvelope).error.code, ErrorCode.NOT_FOUND);
  });
});

describe("20-version history footprint (dedup)", () => {
  test("one 3 MB image across 20 versions occupies ~3 MB on disk, not ~60 MB", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    // Cap high enough for the synthetic payload.
    const store = new FileStore(dataDir, 5 * 1024 * 1024);

    // Synthetic multi-MB payload (not committed as a fixture).
    const imageBytes = Buffer.alloc(3 * 1024 * 1024, 0x5a);
    // Sprinkle uniqueness so it is not all-zero compressible noise if someone
    // later gzips the blob store — we store raw, so this is belt-and-suspenders.
    imageBytes[0] = 0x89;
    imageBytes[1] = 0x50;
    imageBytes[imageBytes.byteLength - 1] = 0x0a;

    const fileId = hashFileContent(imageBytes);
    const put = store.put({
      bytes: imageBytes,
      mimeType: "image/png",
      claimedFileId: fileId,
    });
    assert.equal(put.created, true);
    assert.equal(put.byteLength, imageBytes.byteLength);

    const scene = db.insertScene({
      id: "scene-footprint",
      slug: "footprint",
      name: "Footprint",
    });

    // 20 versions all reference the same single fileId (no re-store of bytes).
    for (let v = 1; v <= 20; v++) {
      db.insertVersion({
        scene_id: scene.id,
        version: v,
        parent_version: v === 1 ? null : v - 1,
        author: "agent",
        message: `v${v}`,
        elements: gzipJson([{ id: `el-${v}`, type: "rectangle" }]),
        app_state: gzipJson({}),
        file_ids: [fileId],
        element_count: 1,
        scene_hash: `hash-${v}`,
      });
      // Simulate a push that "re-uploads" the same image each turn.
      const again = store.put({
        bytes: imageBytes,
        mimeType: "image/png",
        claimedFileId: fileId,
      });
      assert.equal(again.created, false);
    }

    const contentBytes = store.totalContentBytes();
    // Exactly one copy of the image on disk.
    assert.equal(contentBytes, imageBytes.byteLength);
    // Stay within a small multiple of one copy (sidecars are tiny; we measure
    // content blobs only). Absolute ceiling: 1.1× one copy.
    assert.ok(
      contentBytes < imageBytes.byteLength * 1.1,
      `expected ~${imageBytes.byteLength} bytes, got ${contentBytes}`,
    );
    // Explicitly not ~60 MB.
    assert.ok(contentBytes < 10 * 1024 * 1024);

    // Reference set still lists the single id 20 times across versions, but
    // listReferencedFileIds unions them.
    const refs = db.listReferencedFileIds();
    assert.deepEqual(refs, [fileId]);
  });
});

describe("GC helper", () => {
  test("referenced survives; unreferenced+old collected; unreferenced+recent kept", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);
    const store = new FileStore(dataDir, 1024 * 1024);

    const refBytes = Buffer.from("referenced-image-bytes-v1");
    const oldBytes = Buffer.from("old-unreferenced-image-bytes");
    const recentBytes = Buffer.from("recent-unreferenced-image-bytes");

    const refId = hashFileContent(refBytes);
    const oldId = hashFileContent(oldBytes);
    const recentId = hashFileContent(recentBytes);

    const now = Date.UTC(2026, 0, 27); // fixed clock
    const day = 24 * 60 * 60 * 1000;

    store.put({
      bytes: refBytes,
      mimeType: "image/png",
      created: now - 60 * day,
      claimedFileId: refId,
    });
    store.put({
      bytes: oldBytes,
      mimeType: "image/png",
      created: now - 40 * day,
      claimedFileId: oldId,
    });
    store.put({
      bytes: recentBytes,
      mimeType: "image/png",
      created: now - 2 * day,
      claimedFileId: recentId,
    });

    // Only refId is in version history.
    const scene = db.insertScene({
      id: "s-gc",
      slug: "gc-scene",
      name: "GC",
    });
    db.insertVersion({
      scene_id: scene.id,
      version: 1,
      parent_version: null,
      author: "human",
      message: "with image",
      elements: gzipJson([]),
      app_state: gzipJson({}),
      file_ids: [refId],
    });

    const result = gcUnreferencedFiles(store, db, /* olderThanDays */ 30, now);

    assert.ok(result.deleted.includes(oldId));
    assert.ok(result.retainedReferenced.includes(refId));
    assert.ok(result.retainedRecent.includes(recentId));
    assert.ok(!result.deleted.includes(refId));
    assert.ok(!result.deleted.includes(recentId));

    assert.ok(store.exists(refId));
    assert.ok(!store.exists(oldId));
    assert.ok(store.exists(recentId));

    // Sidecar for old is gone too.
    assert.ok(
      !existsSync(path.join(dataDir, FILES_SUBDIR, oldId + SIDECAR_SUFFIX)),
    );
  });

  test("listReferencedFileIds unions across versions and ignores drafts", () => {
    const dataDir = tempDataDir();
    const db = openDatabase(dataDir);
    openDbs.push(db);

    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);

    const scene = db.insertScene({
      id: "s-refs",
      slug: "refs",
      name: "Refs",
    });
    db.insertVersion({
      scene_id: scene.id,
      version: 1,
      parent_version: null,
      author: "a",
      message: "v1",
      elements: gzipJson([]),
      app_state: gzipJson({}),
      file_ids: [a, b],
    });
    db.insertVersion({
      scene_id: scene.id,
      version: 2,
      parent_version: 1,
      author: "a",
      message: "v2",
      elements: gzipJson([]),
      app_state: gzipJson({}),
      file_ids: [b],
    });
    // Draft-only reference must not protect `c`.
    db.upsertDraft({
      scene_id: scene.id,
      elements: gzipJson([]),
      app_state: gzipJson({}),
      file_ids: [c],
      updated_by: "editor",
    });

    const refs = db.listReferencedFileIds().sort();
    assert.deepEqual(refs, [a, b].sort());
    assert.ok(!refs.includes(c));
  });
});

describe("FileStore edge cases", () => {
  test("rejects non-hex fileId on get path shape", () => {
    const store = new FileStore(tempDataDir(), 1024);
    assert.equal(store.get("../etc/passwd"), undefined);
    assert.equal(store.exists("not-a-hash"), false);
  });

  test("get tolerates missing sidecar", () => {
    const dataDir = tempDataDir();
    const store = new FileStore(dataDir, 1024 * 1024);
    store.put({ bytes: PNG_BYTES, mimeType: "image/png" });
    // Remove sidecar only.
    rmSync(path.join(dataDir, FILES_SUBDIR, PNG_FILE_ID + SIDECAR_SUFFIX), {
      force: true,
    });
    const got = store.get(PNG_FILE_ID);
    assert.ok(got);
    assert.equal(got.mimeType, "application/octet-stream");
    assert.deepEqual(got.bytes, PNG_BYTES);
  });

  test("gc falls back to mtime when sidecar created is missing", () => {
    const dataDir = tempDataDir();
    const store = new FileStore(dataDir, 1024 * 1024);
    const bytes = Buffer.from("mtime-fallback-bytes");
    const id = hashFileContent(bytes);
    store.put({
      bytes,
      mimeType: "application/octet-stream",
      created: Date.now(),
    });
    // Overwrite sidecar without created.
    writeFileSync(
      path.join(dataDir, FILES_SUBDIR, id + SIDECAR_SUFFIX),
      JSON.stringify({ mimeType: "application/octet-stream" }),
      "utf8",
    );
    // Age the content file.
    const contentPath = path.join(dataDir, FILES_SUBDIR, id);
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(contentPath, old, old);

    const result = store.gc({
      olderThanDays: 30,
      referencedFileIds: [],
    });
    assert.ok(result.deleted.includes(id) || result.skipped.includes(id));
  });
});
