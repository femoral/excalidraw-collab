/**
 * Skeleton validation + POST /api/skeleton/convert (mock converter / disabled).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildApp } from "./app.js";
import { openDatabase, type Database } from "./db.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import {
  SKELETON_WORKER_DISABLED_MESSAGE,
  validateSkeletonElements,
  validateSkeletonEntry,
  type SkeletonConverter,
} from "./skeleton.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openApps.length > 0) {
    try {
      await openApps.pop()!.close();
    } catch {
      // ignore
    }
  }
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

async function harness(
  opts: {
    converter?: SkeletonConverter | null;
  } = {},
) {
  const dataDir = tempDir("skeleton-test-");
  const token = "skeleton-bootstrap-token";
  const db = openDatabase(dataDir);
  openDbs.push(db);
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
    skeletonConverter: opts.converter === undefined ? null : opts.converter,
    readinessCheck: () => db.isHealthy(),
    fastifyOpts: { logger: false },
  });
  openApps.push(app);
  return { app, token };
}

// ─── pure validation ────────────────────────────────────────────────────────

test("validateSkeletonEntry: reports index and reason for non-object", () => {
  assert.throws(
    () => validateSkeletonEntry("nope", 3),
    (err: Error & { details?: { index: number; reason: string } }) => {
      assert.match(err.message, /skeleton\[3\]/);
      assert.equal(err.details?.index, 3);
      assert.match(err.details?.reason ?? "", /plain object/);
      return true;
    },
  );
});

test("validateSkeletonEntry: unknown type names index", () => {
  assert.throws(
    () => validateSkeletonEntry({ type: "blob", x: 0, y: 0 }, 1),
    (err: Error & { details?: { index: number; reason: string } }) => {
      assert.equal(err.details?.index, 1);
      assert.match(err.details?.reason ?? "", /unknown type/);
      return true;
    },
  );
});

test("validateSkeletonEntry: rectangle requires finite x/y", () => {
  assert.throws(
    () => validateSkeletonEntry({ type: "rectangle", x: "left", y: 0, width: 10, height: 10 }, 0),
    (err: Error & { details?: { reason: string } }) => {
      assert.match(err.details?.reason ?? "", /"x" must be a finite number/);
      return true;
    },
  );
});

test("validateSkeletonElements: arrow end.id must resolve", () => {
  assert.throws(
    () =>
      validateSkeletonElements([
        {
          type: "rectangle",
          id: "a",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        { type: "arrow", id: "arr", start: { id: "a" }, end: { id: "missing" } },
      ]),
    (err: Error & { details?: { index: number; reason: string } }) => {
      assert.equal(err.details?.index, 1);
      assert.match(err.details?.reason ?? "", /missing/);
      return true;
    },
  );
});

test("validateSkeletonElements: accepts three-box two-arrow skeleton", () => {
  assert.doesNotThrow(() =>
    validateSkeletonElements([
      {
        type: "rectangle",
        id: "api",
        x: 0,
        y: 40,
        width: 160,
        height: 80,
        label: { text: "API" },
      },
      {
        type: "rectangle",
        id: "db",
        x: 280,
        y: 0,
        width: 160,
        height: 80,
        label: { text: "DB" },
      },
      {
        type: "rectangle",
        id: "cache",
        x: 280,
        y: 120,
        width: 160,
        height: 80,
        label: { text: "Cache" },
      },
      {
        type: "arrow",
        id: "a1",
        start: { id: "api" },
        end: { id: "db" },
      },
      {
        type: "arrow",
        id: "a2",
        start: { id: "api" },
        end: { id: "cache" },
      },
    ]),
  );
});

// ─── HTTP endpoint ──────────────────────────────────────────────────────────

test("POST /api/skeleton/convert without worker returns 501 with actionable message", async () => {
  const { app, token } = await harness({ converter: null });
  const res = await app.inject({
    method: "POST",
    url: "/api/skeleton/convert",
    headers: { authorization: `Bearer ${token}` },
    payload: { elements: [] },
  });
  assert.equal(res.statusCode, 501);
  const body = res.json() as ErrorEnvelope;
  assert.equal(body.error.code, ErrorCode.NOT_IMPLEMENTED);
  assert.equal(body.error.message, SKELETON_WORKER_DISABLED_MESSAGE);
  assert.match(body.error.message, /RENDER_WORKER=on/);
});

test("POST /api/skeleton/convert validates malformed entry with index", async () => {
  const converter: SkeletonConverter = {
    convert: async () => {
      throw new Error("should not be called");
    },
  };
  const { app, token } = await harness({ converter });
  const res = await app.inject({
    method: "POST",
    url: "/api/skeleton/convert",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      elements: [
        { type: "rectangle", id: "ok", x: 0, y: 0, width: 10, height: 10 },
        { type: "not-a-shape", x: 0, y: 0 },
      ],
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as ErrorEnvelope;
  assert.equal(body.error.code, ErrorCode.VALIDATION);
  assert.match(body.error.message, /skeleton\[1\]/);
  const details = body.error.details as { index: number; reason: string };
  assert.equal(details.index, 1);
  assert.match(details.reason, /unknown type/);
});

test("POST /api/skeleton/convert returns converted elements from converter", async () => {
  const converter: SkeletonConverter = {
    convert: async ({ elements, regenerateIds }) => {
      assert.equal(regenerateIds, false);
      assert.equal(elements.length, 1);
      return {
        elements: [
          {
            id: "api",
            type: "rectangle",
            x: 0,
            y: 0,
            width: 160,
            height: 80,
            boundElements: [],
          },
        ],
      };
    },
  };
  const { app, token } = await harness({ converter });
  const res = await app.inject({
    method: "POST",
    url: "/api/skeleton/convert",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      elements: [
        {
          type: "rectangle",
          id: "api",
          x: 0,
          y: 0,
          width: 160,
          height: 80,
          label: { text: "API" },
        },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { elements: Array<{ id: string }> };
  assert.equal(body.elements.length, 1);
  assert.equal(body.elements[0]!.id, "api");
});

test("POST /api/skeleton/convert requires auth", async () => {
  const { app } = await harness({ converter: null });
  const res = await app.inject({
    method: "POST",
    url: "/api/skeleton/convert",
    payload: { elements: [] },
  });
  assert.equal(res.statusCode, 401);
});
