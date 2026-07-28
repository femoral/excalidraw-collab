/**
 * `turn claim|release` and push lock-respect behaviour against an in-process server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildApp, openDatabase, type Database } from "@excalidraw-collab/server";
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
  configHome: string;
};

async function startServer(): Promise<Harness> {
  const dataDir = tempDir("excali-turn-data-");
  const cwd = tempDir("excali-turn-cwd-");
  const configHome = tempDir("excali-turn-xdg-");
  const token = "test-bootstrap-token-turn-cli";

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

  return { app, db, baseUrl, token, dataDir, cwd, env, configHome };
}

async function mintAgent(
  h: Harness,
  name: string,
): Promise<{ token: string; env: NodeJS.ProcessEnv }> {
  const c = capture();
  const code = await run({
    argv: ["token", "create", name, "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const parsed = JSON.parse(c.stdout) as { token: string; name: string };
  assert.equal(parsed.name, name);
  const env: NodeJS.ProcessEnv = {
    ...h.env,
    EXCALI_TOKEN: parsed.token,
  };
  return { token: parsed.token, env };
}

function writeScene(cwd: string, slug: string, color = "#ffffff"): string {
  const file = path.join(cwd, `${slug}.excalidraw`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "excalidraw",
      elements: [],
      appState: { viewBackgroundColor: color },
    })}\n`,
  );
  return file;
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

test("turn claim / release round-trip with --json", async () => {
  const h = await startServer();
  {
    const c = capture();
    const code = await run({
      argv: ["new", "Arch", "--slug", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  {
    const c = capture();
    const code = await run({
      argv: ["turn", "claim", "arch", "--ttl", "600", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const data = JSON.parse(c.stdout) as {
      slug: string;
      action: string;
      holder: string;
      expiresAt: string;
    };
    assert.equal(data.slug, "arch");
    assert.equal(data.action, "claim");
    assert.equal(data.holder, "admin");
    assert.ok(data.expiresAt);
  }

  {
    const c = capture();
    const code = await run({
      argv: ["ls", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const data = JSON.parse(c.stdout) as {
      scenes: Array<{ slug: string; lock: { holder: string } | null }>;
    };
    assert.equal(data.scenes[0]?.lock?.holder, "admin");
  }

  {
    const c = capture();
    const code = await run({
      argv: ["turn", "release", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const data = JSON.parse(c.stdout) as { action: string; slug: string };
    assert.equal(data.action, "release");
    assert.equal(data.slug, "arch");
  }
});

test("turn claim exits 5 when another identity holds the lock", async () => {
  const h = await startServer();
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const agent = await mintAgent(h, "claude-code");
  {
    const c = capture();
    const code = await run({
      argv: ["turn", "claim", "arch", "--json"],
      env: agent.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  {
    const c = capture();
    const code = await run({
      argv: ["turn", "claim", "arch", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.LOCK_HELD);
    const parsed = JSON.parse(c.stdout) as {
      error: { code: string; message: string };
    };
    assert.equal(parsed.error.code, "LOCK_HELD");
    assert.match(parsed.error.message, /claude-code/);
  }
});

test("push warns when lock held by other, still succeeds; --respect-lock exits 5", async () => {
  const h = await startServer();
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const agent = await mintAgent(h, "claude-code");
  {
    const c = capture();
    const code = await run({
      argv: ["turn", "claim", "arch"],
      env: agent.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  writeScene(h.cwd, "arch", "#abcdef");

  // Without --respect-lock: warn on stderr, exit 0, push lands.
  {
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-m", "human override", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr + c.stdout);
    assert.match(c.stderr, /claude-code/i);
    assert.match(c.stderr, /warning/i);
    const data = JSON.parse(c.stdout) as {
      version: number;
      lockHeldBy: string | null;
    };
    assert.equal(data.version, 1);
    assert.equal(data.lockHeldBy, "claude-code");
  }

  // Lock still held by agent (push was by admin, not the holder).
  {
    const c = capture();
    const code = await run({
      argv: ["ls", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const data = JSON.parse(c.stdout) as {
      scenes: Array<{ lock: { holder: string } | null }>;
    };
    assert.equal(data.scenes[0]?.lock?.holder, "claude-code");
  }

  writeScene(h.cwd, "arch", "#fedcba");

  // With --respect-lock: exit 5, no new version.
  {
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-m", "blocked", "--respect-lock", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.LOCK_HELD);
    const parsed = JSON.parse(c.stdout) as {
      error: { code: string; message: string };
    };
    assert.equal(parsed.error.code, "LOCK_HELD");
    assert.match(parsed.error.message, /claude-code|respect-lock/i);
  }
});

test("push by lock holder succeeds and releases the lock", async () => {
  const h = await startServer();
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  {
    const c = capture();
    const code = await run({
      argv: ["turn", "claim", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  writeScene(h.cwd, "arch");
  {
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-m", "my turn", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr + c.stdout);
    // No warning when we hold the lock ourselves.
    assert.equal(c.stderr, "");
  }

  {
    const c = capture();
    const code = await run({
      argv: ["ls", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const data = JSON.parse(c.stdout) as {
      scenes: Array<{ lock: unknown }>;
    };
    assert.equal(data.scenes[0]?.lock, null);
  }
});

test("turn claim without slug is usage", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["turn", "claim", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
});
