/**
 * CLI backup / restore / pull --all against a real in-process server.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildApp,
  openDatabase,
  type Database,
} from "@excalidraw-collab/server";
import { run } from "./dispatch.js";
import { ExitCode } from "./errors.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: App[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function capture() {
  const stdoutChunks: (string | Uint8Array)[] = [];
  let stderr = "";
  return {
    io: {
      stdout: {
        write(s: string | Uint8Array) {
          stdoutChunks.push(s);
        },
      },
      stderr: {
        write(s: string | Uint8Array) {
          stderr += typeof s === "string" ? s : Buffer.from(s).toString("utf8");
        },
      },
    },
    get stdout() {
      return stdoutChunks
        .map((c) =>
          typeof c === "string" ? c : Buffer.from(c).toString("utf8"),
        )
        .join("");
    },
    get stdoutBytes() {
      return Buffer.concat(
        stdoutChunks.map((c) =>
          typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c),
        ),
      );
    },
    get stderr() {
      return stderr;
    },
  };
}

type Harness = {
  app: App;
  db: Database;
  baseUrl: string;
  token: string;
  dataDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

async function startServer(dataDir?: string): Promise<Harness> {
  const dir = dataDir ?? tempDir("excalicli-backup-data-");
  if (!dataDir) {
    // already in tempDirs
  } else if (!tempDirs.includes(dir)) {
    tempDirs.push(dir);
  }
  const cwd = tempDir("excalicli-backup-cwd-");
  const configHome = tempDir("excalicli-backup-xdg-");
  const token = "test-bootstrap-token-backup-cli";

  const db = openDatabase(dir);
  openDbs.push(db);

  const app = await buildApp({
    config: {
      port: 0,
      dataDir: dir,
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
  openApps.push(app);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    EXCALICLI_SERVER: baseUrl,
    EXCALICLI_TOKEN: token,
  };

  return { app, db, baseUrl, token, dataDir: dir, cwd, env };
}

async function stopAll(): Promise<void> {
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
}

afterEach(async () => {
  await stopAll();
});

function sha1Hex(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

async function seedViaCli(h: Harness): Promise<{ fileId: string; imageBytes: Buffer }> {
  // Create scenes
  let c = capture();
  let code = await run({
    argv: ["new", "Architecture", "--slug", "arch"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);

  c = capture();
  code = await run({
    argv: ["new", "Notes", "--slug", "notes"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);

  const imageBytes = Buffer.from(
    "PNG-FAKE-BACKUP-" + "y".repeat(80),
    "utf8",
  );
  const fileId = sha1Hex(imageBytes);
  const dataURL = `data:image/png;base64,${imageBytes.toString("base64")}`;

  // Push v1, v2, v3 for arch (with image on v2+)
  const push = async (
    slug: string,
    parentVersion: number,
    elements: unknown[],
    message: string,
    files?: Record<string, unknown>,
  ) => {
    const doc = {
      type: "excalidraw",
      version: 2,
      elements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: files ?? {},
    };
    const filePath = path.join(h.cwd, `${slug}-push.excalidraw`);
    fs.writeFileSync(filePath, JSON.stringify(doc), "utf8");
    const cap = capture();
    const exit = await run({
      argv: ["push", slug, "-f", filePath, "-m", message, "--force"],
      env: h.env,
      io: cap.io,
      cwd: h.cwd,
    });
    assert.equal(exit, ExitCode.OK, cap.stderr + cap.stdout);
    void parentVersion;
  };

  await push(
    "arch",
    0,
    [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, seed: 1, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false }],
    "initial",
  );
  await push(
    "arch",
    1,
    [
      { id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, seed: 1, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false },
      { id: "img1", type: "image", x: 20, y: 20, width: 40, height: 40, version: 1, versionNonce: 2, isDeleted: false, fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, seed: 2, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false, fileId, status: "saved", scale: [1, 1] },
    ],
    "added screenshot",
    {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: 1_700_000_000_000,
      },
    },
  );
  await push(
    "arch",
    2,
    [
      { id: "r1", type: "rectangle", x: 10, y: 10, width: 10, height: 10, version: 2, versionNonce: 3, isDeleted: false, fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, seed: 1, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 2, link: null, locked: false },
      { id: "img1", type: "image", x: 20, y: 20, width: 40, height: 40, version: 1, versionNonce: 2, isDeleted: false, fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, seed: 2, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false, fileId, status: "saved", scale: [1, 1] },
    ],
    "tweaked layout",
    {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: 1_700_000_000_000,
      },
    },
  );

  await push("notes", 0, [], "blank notes");

  return { fileId, imageBytes };
}

test("backup -o writes tar.gz; help documents layout", async () => {
  const h = await startServer();
  await seedViaCli(h);

  const help = capture();
  const helpCode = await run({
    argv: ["backup", "--help"],
    env: h.env,
    io: help.io,
    cwd: h.cwd,
  });
  assert.equal(helpCode, ExitCode.OK);
  assert.match(help.stdout, /scenes\/<slug>\/meta\.json/);
  assert.match(help.stdout, /MANIFEST\.json/);
  assert.match(help.stdout, /sqlite\.backup/);

  const out = path.join(h.cwd, "backup.tar.gz");
  const c = capture();
  const code = await run({
    argv: ["backup", "-o", "backup.tar.gz", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  assert.ok(fs.existsSync(out));
  const raw = fs.readFileSync(out);
  assert.equal(raw[0], 0x1f);
  assert.equal(raw[1], 0x8b);
  const meta = JSON.parse(c.stdout) as {
    path: string;
    bytes: number;
    sceneCount?: number;
  };
  assert.equal(meta.path, "backup.tar.gz");
  assert.ok(meta.bytes > 100);
  assert.equal(meta.sceneCount, 2);
});

test("backup, wipe DATA_DIR, restore: history and images survive", async () => {
  const dataDir = tempDir("excalicli-e2e-wipe-data-");
  let h = await startServer(dataDir);
  const { fileId, imageBytes } = await seedViaCli(h);

  const bakPath = path.join(h.cwd, "full.tar.gz");
  let c = capture();
  let code = await run({
    argv: ["backup", "-o", bakPath],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  assert.ok(fs.existsSync(bakPath));

  // Capture log before wipe for comparison expectations.
  c = capture();
  code = await run({
    argv: ["log", "arch", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const beforeLog = JSON.parse(c.stdout) as {
    versions: Array<{
      version: number;
      author: string;
      message: string;
      parentVersion: number | null;
    }>;
  };
  assert.equal(beforeLog.versions.length, 3);

  // Stop server, wipe DATA_DIR, restart with same bootstrap token.
  await h.app.close();
  openApps.pop();
  h.db.close();
  openDbs.pop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  h = await startServer(dataDir);
  // Copy archive into new cwd so restore finds it... use absolute bakPath.
  c = capture();
  code = await run({
    argv: ["restore", bakPath, "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr + c.stdout);
  const report = JSON.parse(c.stdout) as {
    restored: string[];
    skipped: string[];
    filesRestored: number;
    messages: string[];
  };
  assert.ok(report.restored.includes("arch"));
  assert.ok(report.restored.includes("notes"));
  assert.equal(report.filesRestored, 1);
  assert.ok(report.messages.length > 0);

  c = capture();
  code = await run({
    argv: ["log", "arch", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const afterLog = JSON.parse(c.stdout) as typeof beforeLog;
  assert.equal(afterLog.versions.length, 3);

  // Authors, messages, parent links must match (order may be desc).
  const byV = (list: typeof beforeLog.versions) =>
    Object.fromEntries(list.map((v) => [v.version, v]));
  const b = byV(beforeLog.versions);
  const a = byV(afterLog.versions);
  for (const v of [1, 2, 3] as const) {
    assert.equal(a[v]!.author, b[v]!.author, `author v${v}`);
    assert.equal(a[v]!.message, b[v]!.message, `message v${v}`);
    assert.equal(a[v]!.parentVersion, b[v]!.parentVersion, `parent v${v}`);
  }

  // Image bytes survive.
  const fileRes = await fetch(`${h.baseUrl}/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${h.token}` },
  });
  assert.equal(fileRes.status, 200);
  const got = Buffer.from(await fileRes.arrayBuffer());
  assert.deepEqual(got, imageBytes);

  // Head version
  c = capture();
  code = await run({
    argv: ["ls", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK);
  const ls = JSON.parse(c.stdout) as {
    scenes: Array<{ slug: string; headVersion: number }>;
  };
  const arch = ls.scenes.find((s) => s.slug === "arch");
  assert.ok(arch);
  assert.equal(arch.headVersion, 3);
});

test("restore into server with colliding slug: skip reports; overwrite replaces", async () => {
  const h = await startServer();
  await seedViaCli(h);

  const bakPath = path.join(h.cwd, "coll.tar.gz");
  let c = capture();
  let code = await run({
    argv: ["backup", "-o", bakPath],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);

  // Existing server already has arch — restore with default skip.
  c = capture();
  code = await run({
    argv: ["restore", bakPath, "--on-collision", "skip", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const skipped = JSON.parse(c.stdout) as {
    skipped: string[];
    restored: string[];
    messages: string[];
  };
  assert.ok(skipped.skipped.includes("arch"));
  assert.ok(skipped.messages.some((m) => /Skipped arch/.test(m)));

  // Human mode also names the policy outcome.
  c = capture();
  code = await run({
    argv: ["restore", bakPath, "--on-collision", "overwrite"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  assert.match(c.stdout, /overwritten/i);
  assert.match(c.stdout, /arch/);
});

test("pull --all -o dir writes plain .excalidraw files", async () => {
  const h = await startServer();
  await seedViaCli(h);

  const outDir = "export-all";
  const c = capture();
  const code = await run({
    argv: ["pull", "--all", "-o", outDir, "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const data = JSON.parse(c.stdout) as {
    all: boolean;
    count: number;
    scenes: Array<{ slug: string; path: string; version: number }>;
  };
  assert.equal(data.all, true);
  assert.equal(data.count, 2);

  const archPath = path.join(h.cwd, outDir, "arch.excalidraw");
  const notesPath = path.join(h.cwd, outDir, "notes.excalidraw");
  assert.ok(fs.existsSync(archPath));
  assert.ok(fs.existsSync(notesPath));

  const arch = JSON.parse(fs.readFileSync(archPath, "utf8")) as {
    elements: unknown[];
    files?: Record<string, unknown>;
  };
  assert.ok(Array.isArray(arch.elements));
  assert.ok(arch.elements.length >= 1);
  // Image should be embedded in head.
  assert.ok(arch.files && Object.keys(arch.files).length >= 1);
});

test("backup without -o is usage error", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["backup", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
});
