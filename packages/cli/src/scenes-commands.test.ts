/**
 * Scene commands (ls / new / pull / push) against a real in-process server.
 * Uses buildApp from @excalidraw-collab/server (devDependency only).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildApp, openDatabase, type Database } from "@excalidraw-collab/server";
import { run } from "./dispatch.js";
import { ExitCode } from "./errors.js";
import { getPulledVersion, statePath } from "./state.js";

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
  const dataDir = tempDir("excali-e2e-data-");
  const cwd = tempDir("excali-e2e-cwd-");
  const configHome = tempDir("excali-e2e-xdg-");
  const token = "test-bootstrap-token-scenes-cli";

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

// ─── usage / --json shape ───────────────────────────────────────────────────

test("new without name exits usage with parseable --json", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["new", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
});

test("push without -m exits usage with parseable --json", async () => {
  const h = await startServer();
  const c = capture();
  const code = await run({
    argv: ["push", "arch", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
});

test("push without local state on head>0 without --force exits usage suggesting pull", async () => {
  const h = await startServer();

  // Create scene and advance head to 1 so the missing-state case is ambiguous.
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });
  // First push is allowed with no state (head 0).
  const file = path.join(h.cwd, "arch.excalidraw");
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "excalidraw",
      elements: [],
      appState: { viewBackgroundColor: "#111111" },
    })}\n`,
  );
  {
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-m", "seed", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), 1);
  }

  // Wipe local state so the next push has no recorded parent.
  fs.rmSync(path.join(h.cwd, ".excalidraw-collab"), {
    recursive: true,
    force: true,
  });
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), undefined);

  const c = capture();
  const code = await run({
    argv: ["push", "arch", "-m", "nope", "--json"],
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
  // Still no local state recorded on refusal.
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), undefined);
});

test("new → push without prior pull succeeds on fresh head-0 scene", async () => {
  const h = await startServer();

  {
    const c = capture();
    const code = await run({
      argv: ["--json", "new", "Round Trip", "--slug", "round-trip"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const created = JSON.parse(c.stdout) as { headVersion: number };
    assert.equal(created.headVersion, 0);
  }

  // No local state, no pull.
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "round-trip"), undefined);

  const file = path.join(h.cwd, "scene.excalidraw");
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "excalidraw",
      elements: [],
      appState: { viewBackgroundColor: "#ff00aa" },
    })}\n`,
  );

  const c = capture();
  const code = await run({
    argv: ["--json", "push", "round-trip", "-f", "scene.excalidraw", "-m", "initial"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const pushed = JSON.parse(c.stdout) as {
    version: number;
    parentVersion: number | null;
    message: string;
  };
  assert.equal(pushed.version, 1);
  assert.equal(pushed.parentVersion, 0);
  assert.equal(pushed.message, "initial");
  // Successful push records local state so the next push has a parent.
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "round-trip"), 1);
});

test("push --force with no local state on head>0 succeeds and records state", async () => {
  const h = await startServer();

  await run({
    argv: ["new", "Force Me", "--slug", "force-me"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  // Seed head=1 via a head-0 push (no prior pull).
  const file = path.join(h.cwd, "force-me.excalidraw");
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "excalidraw",
      elements: [],
      appState: { viewBackgroundColor: "#aaaaaa" },
    })}\n`,
  );
  {
    const c = capture();
    const code = await run({
      argv: ["push", "force-me", "-m", "seed"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "force-me"), 1);

  // Wipe local state; head remains 1.
  fs.rmSync(path.join(h.cwd, ".excalidraw-collab"), {
    recursive: true,
    force: true,
  });
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "force-me"), undefined);

  // Without --force this would exit 2; with --force it must succeed.
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "excalidraw",
      elements: [],
      appState: { viewBackgroundColor: "#bbbbbb" },
    })}\n`,
  );
  const c = capture();
  const code = await run({
    argv: ["--json", "push", "force-me", "-m", "forced", "--force"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const pushed = JSON.parse(c.stdout) as {
    version: number;
    force: boolean;
  };
  assert.equal(pushed.version, 2);
  assert.equal(pushed.force, true);
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "force-me"), 2);
});

// ─── round trip ─────────────────────────────────────────────────────────────

test("new → pull → edit → push → pull returns the edit", async () => {
  const h = await startServer();

  // new
  {
    const c = capture();
    const code = await run({
      argv: ["--json", "new", "Architecture", "--slug", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const created = JSON.parse(c.stdout) as {
      slug: string;
      headVersion: number;
    };
    assert.equal(created.slug, "arch");
    assert.equal(created.headVersion, 0);
  }

  // ls
  {
    const c = capture();
    const code = await run({
      argv: ["ls", "--json"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const body = JSON.parse(c.stdout) as {
      scenes: Array<{ slug: string }>;
    };
    assert.equal(body.scenes.length, 1);
    assert.equal(body.scenes[0]!.slug, "arch");
  }

  // pull
  {
    const c = capture();
    const code = await run({
      argv: ["--json", "pull", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const pulled = JSON.parse(c.stdout) as {
      slug: string;
      version: number;
      path: string;
    };
    assert.equal(pulled.slug, "arch");
    assert.equal(pulled.version, 0);
    assert.equal(pulled.path, "arch.excalidraw");
    assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), 0);

    const file = path.join(h.cwd, "arch.excalidraw");
    assert.ok(fs.existsSync(file));
    const scene = JSON.parse(fs.readFileSync(file, "utf8")) as {
      elements: unknown[];
      appState: Record<string, unknown>;
    };
    assert.ok(Array.isArray(scene.elements));

    // Edit: change a whitelisted appState field (no hand-authored elements).
    scene.appState = {
      ...(scene.appState ?? {}),
      viewBackgroundColor: "#ff00aa",
    };
    fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
  }

  // push
  {
    const c = capture();
    const code = await run({
      argv: ["--json", "push", "arch", "-m", "pink background"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const pushed = JSON.parse(c.stdout) as {
      version: number;
      message: string;
    };
    assert.equal(pushed.version, 1);
    assert.equal(pushed.message, "pink background");
    assert.equal(getPulledVersion(h.cwd, h.baseUrl, "arch"), 1);
  }

  // pull again — edit must round-trip
  {
    // Wipe file so we know pull rewrote it.
    fs.unlinkSync(path.join(h.cwd, "arch.excalidraw"));
    const c = capture();
    const code = await run({
      argv: ["--json", "pull", "arch"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
    const pulled = JSON.parse(c.stdout) as { version: number };
    assert.equal(pulled.version, 1);

    const scene = JSON.parse(fs.readFileSync(path.join(h.cwd, "arch.excalidraw"), "utf8")) as {
      appState: { viewBackgroundColor?: string };
    };
    assert.equal(scene.appState.viewBackgroundColor, "#ff00aa");
  }
});

// ─── stale push / 409 ───────────────────────────────────────────────────────

test("stale push exits 4, renders server diff, leaves head unchanged", async () => {
  const h = await startServer();

  // Create + pull empty + first push → head=1, local state=1
  await run({
    argv: ["new", "Race", "--slug", "race"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });
  await run({
    argv: ["pull", "race"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const file = path.join(h.cwd, "race.excalidraw");
  const scene1 = JSON.parse(fs.readFileSync(file, "utf8")) as {
    elements: unknown[];
    appState: Record<string, unknown>;
    files?: unknown;
  };
  scene1.appState = { ...scene1.appState, viewBackgroundColor: "#111111" };
  fs.writeFileSync(file, `${JSON.stringify(scene1, null, 2)}\n`);

  {
    const c = capture();
    const code = await run({
      argv: ["push", "race", "-m", "first"],
      env: h.env,
      io: c.io,
      cwd: h.cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "race"), 1);

  // Advance head on the server without updating local state (simulate peer).
  const peerPush = await fetch(`${h.baseUrl}/api/scenes/race/scene`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${h.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      parentVersion: 1,
      elements: [],
      appState: { viewBackgroundColor: "#222222" },
      message: "peer turn",
    }),
  });
  assert.equal(peerPush.status, 201, await peerPush.text());
  // Local state still thinks parent is 1
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "race"), 1);

  // Stale local edit + push
  const sceneStale = JSON.parse(fs.readFileSync(file, "utf8")) as {
    elements: unknown[];
    appState: Record<string, unknown>;
  };
  sceneStale.appState = {
    ...sceneStale.appState,
    viewBackgroundColor: "#abcdef",
  };
  fs.writeFileSync(file, `${JSON.stringify(sceneStale, null, 2)}\n`);

  const conflict = capture();
  const conflictCode = await run({
    argv: ["push", "race", "-m", "stale attempt"],
    env: h.env,
    io: conflict.io,
    cwd: h.cwd,
  });
  assert.equal(conflictCode, ExitCode.CONFLICT);
  // Diff from server rendered on stderr (not a second GET /diff)
  assert.match(conflict.stderr, /parentVersion|does not match head|Conflict/i);
  assert.match(conflict.stderr, /v1\s*→\s*v2|v1 → v2/);
  // Exact resolution commands
  assert.match(conflict.stderr, /excali pull race/);
  assert.match(conflict.stderr, /excali push race -m "stale attempt"/);
  assert.match(conflict.stderr, /--force/);
  // Local state unchanged
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "race"), 1);

  // Server head still 2
  const metaRes = await fetch(`${h.baseUrl}/api/scenes/race`, {
    headers: { Authorization: `Bearer ${h.token}` },
  });
  assert.equal(metaRes.status, 200);
  const meta = (await metaRes.json()) as { headVersion: number };
  assert.equal(meta.headVersion, 2);

  // --json failure is one parseable object with resolution + diff details
  const jsonConflict = capture();
  const jsonCode = await run({
    argv: ["--json", "push", "race", "-m", "stale again"],
    env: h.env,
    io: jsonConflict.io,
    cwd: h.cwd,
  });
  assert.equal(jsonCode, ExitCode.CONFLICT);
  const envelope = JSON.parse(jsonConflict.stdout) as {
    error: {
      code: string;
      message: string;
      details: {
        head: number;
        parentVersion: number;
        diff: { from: number; to: number };
        resolution: string[];
      };
    };
  };
  assert.equal(envelope.error.code, "CONFLICT");
  assert.equal(envelope.error.details.head, 2);
  assert.equal(envelope.error.details.parentVersion, 1);
  assert.equal(envelope.error.details.diff.from, 1);
  assert.equal(envelope.error.details.diff.to, 2);
  assert.ok(envelope.error.details.resolution.some((c) => c.includes("excali pull race")));
  assert.ok(envelope.error.details.resolution.some((c) => c.includes("--force")));

  // Head still 2 after second failed push
  const meta2 = (await (
    await fetch(`${h.baseUrl}/api/scenes/race`, {
      headers: { Authorization: `Bearer ${h.token}` },
    })
  ).json()) as { headVersion: number };
  assert.equal(meta2.headVersion, 2);
});

// ─── local state per-server ─────────────────────────────────────────────────

test("pull records version per server; same slug on two servers is isolated", async () => {
  // Two independent servers.
  const a = await startServer();
  const b = await startServer();
  // Shared cwd so state.json holds both.
  const cwd = tempDir("excali-e2e-shared-cwd-");

  for (const h of [a, b]) {
    const c = capture();
    const code = await run({
      argv: ["new", "Shared", "--slug", "arch"],
      env: h.env,
      io: c.io,
      cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  // Push a version on A so heads differ.
  {
    await run({
      argv: ["pull", "arch", "-o", "a.excalidraw"],
      env: a.env,
      io: capture().io,
      cwd,
    });
    const file = path.join(cwd, "a.excalidraw");
    const scene = JSON.parse(fs.readFileSync(file, "utf8")) as {
      appState: Record<string, unknown>;
      elements: unknown[];
    };
    scene.appState = { ...scene.appState, viewBackgroundColor: "#aaaaaa" };
    fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-f", "a.excalidraw", "-m", "on A"],
      env: a.env,
      io: c.io,
      cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  // Pull B (still head 0) — must not overwrite A's recorded version.
  {
    const c = capture();
    const code = await run({
      argv: ["pull", "arch", "-o", "b.excalidraw"],
      env: b.env,
      io: c.io,
      cwd,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  assert.equal(getPulledVersion(cwd, a.baseUrl, "arch"), 1);
  assert.equal(getPulledVersion(cwd, b.baseUrl, "arch"), 0);

  // state.json has both server keys
  const state = JSON.parse(fs.readFileSync(statePath(cwd), "utf8")) as {
    servers: Record<string, { scenes: Record<string, { version: number }> }>;
  };
  const keys = Object.keys(state.servers);
  assert.ok(keys.includes(a.baseUrl));
  assert.ok(keys.includes(b.baseUrl));
  assert.notEqual(a.baseUrl, b.baseUrl);
});

// ─── pull -o - ──────────────────────────────────────────────────────────────

test("pull -o - writes scene to stdout in human mode; --json is one object", async () => {
  const h = await startServer();
  await run({
    argv: ["new", "Out", "--slug", "out"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const human = capture();
  const humanCode = await run({
    argv: ["pull", "out", "-o", "-"],
    env: h.env,
    io: human.io,
    cwd: h.cwd,
  });
  assert.equal(humanCode, ExitCode.OK, human.stderr);
  const scene = JSON.parse(human.stdout) as { type: string; elements: unknown[] };
  assert.equal(scene.type, "excalidraw");
  assert.ok(Array.isArray(scene.elements));
  assert.equal(getPulledVersion(h.cwd, h.baseUrl, "out"), 0);

  const json = capture();
  const jsonCode = await run({
    argv: ["--json", "pull", "out", "-o", "-"],
    env: h.env,
    io: json.io,
    cwd: h.cwd,
  });
  assert.equal(jsonCode, ExitCode.OK, json.stderr);
  const parsed = JSON.parse(json.stdout) as {
    path: string;
    version: number;
    scene: { type: string };
  };
  assert.equal(parsed.path, "-");
  assert.equal(parsed.version, 0);
  assert.equal(parsed.scene.type, "excalidraw");
});
