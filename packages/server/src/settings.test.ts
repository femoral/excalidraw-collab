/**
 * Instance theme settings (issue #38): public read, admin-only write.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { META_INSTANCE_THEME, openDatabase, type Database } from "./db.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";
import type { ThemeSettings } from "./settings.js";
import type { TokenCreated } from "./tokens.js";

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: FastifyInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-settings-"));
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

async function buildSettingsApp(opts: {
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
      // best-effort
    }
  }
});

describe("GET /api/settings/theme", () => {
  test("is readable without authentication", async () => {
    const { app, db } = await buildSettingsApp({
      dataDir: tempDataDir(),
      bootstrapToken: "bootstrap-secret",
    });
    assert.equal(db.getMeta(META_INSTANCE_THEME), undefined);

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/theme",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as ThemeSettings;
    assert.equal(body.theme, null);
  });

  test("returns the stored instance default", async () => {
    const { app, db } = await buildSettingsApp({
      dataDir: tempDataDir(),
      bootstrapToken: "bootstrap-secret",
    });
    db.setMeta(META_INSTANCE_THEME, "dark");

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/theme",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { theme: "dark" });
  });

  test("ignores garbage meta values", async () => {
    const { app, db } = await buildSettingsApp({
      dataDir: tempDataDir(),
      bootstrapToken: "bootstrap-secret",
    });
    db.setMeta(META_INSTANCE_THEME, "sepia");

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/theme",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { theme: null });
  });
});

describe("PUT /api/settings/theme", () => {
  test("admin can set and clear the instance default", async () => {
    const bootstrap = "admin-bootstrap-token";
    const { app, db } = await buildSettingsApp({
      dataDir: tempDataDir(),
      bootstrapToken: bootstrap,
    });

    const setRes = await app.inject({
      method: "PUT",
      url: "/api/settings/theme",
      headers: {
        ...bearer(bootstrap),
        "content-type": "application/json",
      },
      payload: { theme: "dark" },
    });
    assert.equal(setRes.statusCode, 200, setRes.body);
    assert.deepEqual(setRes.json(), { theme: "dark" });
    assert.equal(db.getMeta(META_INSTANCE_THEME), "dark");

    const clearRes = await app.inject({
      method: "PUT",
      url: "/api/settings/theme",
      headers: {
        ...bearer(bootstrap),
        "content-type": "application/json",
      },
      payload: { theme: null },
    });
    assert.equal(clearRes.statusCode, 200, clearRes.body);
    assert.deepEqual(clearRes.json(), { theme: null });
    assert.equal(db.getMeta(META_INSTANCE_THEME), undefined);
  });

  test("non-admin token cannot change the instance default", async () => {
    const bootstrap = "admin-bootstrap-token";
    const { app, db } = await buildSettingsApp({
      dataDir: tempDataDir(),
      bootstrapToken: bootstrap,
    });

    // Mint a non-admin agent token.
    const mint = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        ...bearer(bootstrap),
        "content-type": "application/json",
      },
      payload: { name: "agent-bot" },
    });
    assert.ok(mint.statusCode === 200 || mint.statusCode === 201, mint.body);
    const agent = mint.json() as TokenCreated;
    assert.equal(agent.isAdmin, false);

    const denied = await app.inject({
      method: "PUT",
      url: "/api/settings/theme",
      headers: {
        ...bearer(agent.token),
        "content-type": "application/json",
      },
      payload: { theme: "dark" },
    });
    assert.equal(denied.statusCode, 403);
    const body = denied.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.FORBIDDEN);
    assert.equal(db.getMeta(META_INSTANCE_THEME), undefined);

    // Public GET still null.
    const get = await app.inject({
      method: "GET",
      url: "/api/settings/theme",
    });
    assert.deepEqual(get.json(), { theme: null });
  });

  test("unauthenticated write is rejected", async () => {
    const { app } = await buildSettingsApp({
      dataDir: tempDataDir(),
      bootstrapToken: "admin-bootstrap-token",
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/theme",
      headers: { "content-type": "application/json" },
      payload: { theme: "light" },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.UNAUTHORIZED);
  });
});
