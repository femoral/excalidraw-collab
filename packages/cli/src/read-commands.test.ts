/**
 * diff / describe / log against a real in-process server (issue #20).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildApp, openDatabase, type Database } from "@excalidraw-collab/server";
import { run } from "./dispatch.js";
import { ExitCode } from "./errors.js";
import { getPulledVersion } from "./state.js";

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
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(s: string) {
          stdout += s;
        },
      },
      stderr: {
        write(s: string) {
          stderr += s;
        },
      },
    },
    get stdout() {
      return stdout;
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

async function startServer(): Promise<Harness> {
  const dataDir = tempDir("excali-read-data-");
  const cwd = tempDir("excali-read-cwd-");
  const configHome = tempDir("excali-read-xdg-");
  const token = "test-bootstrap-token-read-cli";

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
    EXCALI_SERVER: baseUrl,
    EXCALI_TOKEN: token,
  };

  return { app, db, baseUrl, token, dataDir, cwd, env };
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
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Minimal scene with a few named shapes (ids only; no hand-mutated internals). */
function sceneWithShapes(colors: string[]): string {
  const elements = colors.map((color, i) => ({
    id: `el-${i}`,
    type: "rectangle",
    x: i * 100,
    y: 0,
    width: 80,
    height: 40,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: color,
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    roundness: null,
    seed: i + 1,
    version: 1,
    versionNonce: i + 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  }));
  return `${JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  })}\n`;
}

async function seedScene(
  h: Harness,
  slug: string,
  messages: string[],
  colorsPerVersion: string[][],
): Promise<void> {
  {
    const c = capture();
    const code = await run({
      argv: ["new", "Read Scene", "--slug", slug],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  for (let i = 0; i < messages.length; i++) {
    const file = path.join(h.cwd, `${slug}.excalidraw`);
    fs.writeFileSync(file, sceneWithShapes(colorsPerVersion[i]!));
    const c = capture();
    const code = await run({
      argv: ["push", slug, "-m", messages[i]!, ...(i === 0 ? [] : [])],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    // First push may need no local state (head 0); subsequent need state from prior push.
    assert.equal(code, ExitCode.OK, `push ${i + 1}: ${c.stderr}`);
  }
}

// ─── usage / --json shape ───────────────────────────────────────────────────

test("diff without SLUG exits usage with parseable --json", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["diff", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
});

test("describe without SLUG exits usage with parseable --json", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["describe", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
});

test("log without SLUG exits usage with parseable --json", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["log", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
});

test("diff --since-last-pull without prior pull exits usage", async () => {
  const h = await startServer();
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const c = capture();
  const code = await run({
    argv: ["diff", "arch", "--since-last-pull", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string };
  };
  assert.equal(parsed.error.code, "USAGE");
  assert.match(parsed.error.message, /excali pull arch/);
});

// ─── diff ───────────────────────────────────────────────────────────────────

test("diff --since-last-pull after pull with no changes exits 0 empty", async () => {
  const h = await startServer();
  await seedScene(h, "arch", ["v1 pink"], [["#ff00aa"]]);

  // Pull records local version = head.
  {
    const c = capture();
    const code = await run({
      argv: ["pull", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), 1);
  }

  // Immediate --since-last-pull: nothing changed → exit 0 + empty summary.
  {
    const c = capture();
    const code = await run({
      argv: ["diff", "arch", "--since-last-pull", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      slug: string;
      fromRef: string;
      toRef: string;
      diff: {
        from?: number;
        to?: number;
        summary: {
          added: number;
          deleted: number;
          updated: number;
          reordered: number;
        };
        elements: unknown[];
      };
    };
    assert.equal(body.slug, "arch");
    assert.equal(body.fromRef, "1");
    assert.equal(body.toRef, "head");
    assert.equal(body.diff.from, 1);
    assert.equal(body.diff.to, 1);
    assert.equal(body.diff.summary.added, 0);
    assert.equal(body.diff.summary.deleted, 0);
    assert.equal(body.diff.summary.updated, 0);
    assert.equal(body.diff.summary.reordered, 0);
    assert.equal(body.diff.elements.length, 0);
  }

  // Human mode also exits 0 and mentions empty.
  {
    const c = capture();
    const code = await run({
      argv: ["diff", "arch", "--since-last-pull"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.match(c.stdout, /\(empty\)/);
    assert.equal(c.stderr, "");
  }
});

test("diff --since-last-pull shows changes after another push", async () => {
  const h = await startServer();
  await seedScene(h, "arch", ["v1 one box"], [["#ff0000"]]);

  // Pull at v1.
  {
    const c = capture();
    const code = await run({
      argv: ["pull", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), 1);
  }

  // Second push (state advances to v2 via push).
  {
    const file = path.join(h.cwd, "arch.excalidraw");
    fs.writeFileSync(file, sceneWithShapes(["#ff0000", "#00ff00"]));
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-m", "v2 two boxes"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    // push records v2; reset local state to v1 to simulate "last pull was v1".
    assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), 2);
  }

  // Simulate agent that pulled at v1 and has not re-pulled after remote change:
  // write state back to 1.
  const stateFile = path.join(h.cwd, ".excalidraw-collab", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    version: 1;
    servers: Record<string, { scenes: Record<string, { version: number }> }>;
  };
  const serverKey = h.baseUrl.replace(/\/$/, "");
  state.servers[serverKey]!.scenes["arch"] = { version: 1 };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const c = capture();
  const code = await run({
    argv: ["diff", "arch", "--since-last-pull", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const body = JSON.parse(c.stdout) as {
    fromRef: string;
    toRef: string;
    diff: {
      summary: { added: number };
      elements: Array<{ op: string }>;
    };
  };
  assert.equal(body.fromRef, "1");
  assert.equal(body.toRef, "head");
  assert.ok(body.diff.summary.added >= 1, JSON.stringify(body.diff.summary));
  assert.ok(body.diff.elements.some((e) => e.op === "add"));
});

test("diff --from/--to defaults and explicit refs", async () => {
  const h = await startServer();
  await seedScene(h, "arch", ["v1", "v2"], [["#aa0000"], ["#aa0000", "#00aa00"]]);

  // Explicit from/to
  {
    const c = capture();
    const code = await run({
      argv: ["diff", "arch", "--from", "1", "--to", "2", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      fromRef: string;
      toRef: string;
      diff: { from?: number; to?: number; summary: { added: number } };
    };
    assert.equal(body.fromRef, "1");
    assert.equal(body.toRef, "2");
    assert.equal(body.diff.from, 1);
    assert.equal(body.diff.to, 2);
    assert.ok(body.diff.summary.added >= 1);
  }

  // Default head~1 → head (v1 → v2)
  {
    const c = capture();
    const code = await run({
      argv: ["diff", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      fromRef: string;
      toRef: string;
      diff: { summary: { added: number } };
    };
    assert.equal(body.fromRef, "head~1");
    assert.equal(body.toRef, "head");
    assert.ok(body.diff.summary.added >= 1);
  }

  // Human text is non-empty and compact
  {
    const c = capture();
    const code = await run({
      argv: ["diff", "arch", "--from", "1", "--to", "2"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.match(c.stdout, /v1 → v2/);
    assert.match(c.stdout, /\+/);
  }
});

// ─── describe ───────────────────────────────────────────────────────────────

test("describe head and --version with --json and --verbose", async () => {
  const h = await startServer();
  await seedScene(h, "arch", ["one", "two"], [["#ff0000"], ["#ff0000", "#00ff00"]]);

  // Head describe
  {
    const c = capture();
    const code = await run({
      argv: ["describe", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      slug: string;
      version: number;
      digest: { elementCount: number; countsByType: Record<string, number> };
      text: string;
    };
    assert.equal(body.slug, "arch");
    assert.equal(body.version, 2);
    assert.equal(body.digest.elementCount, 2);
    assert.equal(body.digest.countsByType.rectangle, 2);
    assert.match(body.text, /2 elements/);
  }

  // Specific version
  {
    const c = capture();
    const code = await run({
      argv: ["describe", "arch", "--version", "1", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      version: number;
      digest: { elementCount: number };
    };
    assert.equal(body.version, 1);
    assert.equal(body.digest.elementCount, 1);
  }

  // Human terse (no ids)
  {
    const c = capture();
    const code = await run({
      argv: ["describe", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.match(c.stdout, /2 elements/);
    assert.match(c.stdout, /rectangle/);
    assert.ok(!c.stdout.includes("id=el-"), "default should not show ids");
  }

  // Verbose adds ids
  {
    const c = capture();
    const code = await run({
      argv: ["describe", "arch", "--verbose"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.match(c.stdout, /id=el-/);
  }
});

// ─── log ────────────────────────────────────────────────────────────────────

test("log shows version author message and change counts", async () => {
  const h = await startServer();
  await seedScene(h, "arch", ["first box", "second box"], [["#111111"], ["#111111", "#222222"]]);

  // JSON
  {
    const c = capture();
    const code = await run({
      argv: ["log", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      slug: string;
      headVersion: number;
      total: number;
      versions: Array<{
        version: number;
        author: string;
        message: string;
        changes: {
          added: number;
          deleted: number;
          updated: number;
          reordered: number;
        };
      }>;
    };
    assert.equal(body.slug, "arch");
    assert.equal(body.headVersion, 2);
    assert.equal(body.total, 2);
    assert.equal(body.versions.length, 2);
    // Newest first
    assert.equal(body.versions[0]!.version, 2);
    assert.equal(body.versions[0]!.message, "second box");
    assert.equal(body.versions[1]!.version, 1);
    assert.equal(body.versions[1]!.message, "first box");
    assert.ok(body.versions[0]!.author.length > 0);
    // v2 added a rectangle relative to v1
    assert.ok(body.versions[0]!.changes.added >= 1);
    // v1 added relative to empty
    assert.ok(body.versions[1]!.changes.added >= 1);
  }

  // Human
  {
    const c = capture();
    const code = await run({
      argv: ["log", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.match(c.stdout, /scene arch\s+head v2/);
    assert.match(c.stdout, /v\s*2/);
    assert.match(c.stdout, /second box/);
    assert.match(c.stdout, /first box/);
    assert.match(c.stdout, /\+/); // change counts
  }

  // -n limits
  {
    const c = capture();
    const code = await run({
      argv: ["log", "arch", "-n", "1", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      versions: unknown[];
      total: number;
    };
    assert.equal(body.versions.length, 1);
    assert.equal(body.total, 2);
  }
});

test("log on empty head-0 scene is empty and exits 0", async () => {
  const h = await startServer();
  await run({
    argv: ["new", "Empty", "--slug", "empty"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const c = capture();
  const code = await run({
    argv: ["log", "empty", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const body = JSON.parse(c.stdout) as {
    headVersion: number;
    versions: unknown[];
  };
  assert.equal(body.headVersion, 0);
  assert.equal(body.versions.length, 0);
});

test("global help lists diff, describe, log", async () => {
  const c = capture();
  const code = await run({ argv: ["--help"], io: c.io });
  assert.equal(code, ExitCode.OK);
  assert.match(c.stdout, /\bdiff\b/);
  assert.match(c.stdout, /\bdescribe\b/);
  assert.match(c.stdout, /\blog\b/);
});
