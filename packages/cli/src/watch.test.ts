/**
 * `excalicli watch` against a real in-process server (issue #24).
 *
 * Asserts the notify path: a concurrent push wakes watch within 1 s
 * (no sleep-and-hope), and `--json` emits JSONL (one object per line).
 */
import assert from "node:assert/strict";
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
  baseUrl: string;
  token: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

async function startServer(opts?: {
  eventsTimeoutMs?: number;
}): Promise<Harness> {
  const dataDir = tempDir("excalicli-watch-data-");
  const cwd = tempDir("excalicli-watch-cwd-");
  const configHome = tempDir("excalicli-watch-xdg-");
  const token = "test-bootstrap-token-watch-cli";

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
    eventsTimeoutMs: opts?.eventsTimeoutMs ?? 5_000,
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

  return { app, baseUrl, token, cwd, env };
}

function rect(id: string, versionNonce = 1): Record<string, unknown> {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function writeScene(
  cwd: string,
  slug: string,
  elements: Record<string, unknown>[],
): string {
  const file = path.join(cwd, `${slug}.excalidraw`);
  const doc = {
    type: "excalidraw",
    version: 2,
    elements,
    appState: {},
    files: {},
  };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
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
      // ignore
    }
  }
});

test("watch --json emits one JSONL object when a push lands", async () => {
  const h = await startServer({ eventsTimeoutMs: 5_000 });

  // Create scene + v1 via CLI.
  {
    const c = capture();
    const code = await run({
      argv: ["new", "Architecture", "--slug", "arch"],
      env: h.env,
      cwd: h.cwd,
      io: c.io,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }
  writeScene(h.cwd, "arch", [rect("a")]);
  {
    const c = capture();
    const code = await run({
      argv: ["push", "arch", "-m", "initial"],
      env: h.env,
      cwd: h.cwd,
      io: c.io,
    });
    assert.equal(code, ExitCode.OK, c.stderr);
  }

  const c = capture();
  // Cap the watch loop after the first event; also abort as a safety net.
  const ac = new AbortController();
  const watchEnv = {
    ...h.env,
    EXCALICLI_WATCH_MAX_EVENTS: "1",
  };

  const watchPromise = run({
    argv: ["--json", "watch", "arch", "--since", "1"],
    env: watchEnv,
    cwd: h.cwd,
    io: c.io,
    signal: ac.signal,
  });

  // Yield so watch parks on the long-poll before we push.
  await new Promise<void>((r) => setTimeout(r, 50));

  writeScene(h.cwd, "arch", [rect("a"), rect("b")]);
  const t0 = Date.now();
  {
    const pushCap = capture();
    // push from a separate cwd so we don't advance watch's local state mid-flight
    const otherCwd = tempDir("excalicli-watch-pusher-");
    writeScene(otherCwd, "arch", [rect("a"), rect("b")]);
    // Record parentVersion via state for the pusher
    fs.mkdirSync(path.join(otherCwd, ".excalidraw-collab"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(otherCwd, ".excalidraw-collab", "state.json"),
      JSON.stringify({
        version: 1,
        servers: {
          [h.baseUrl.replace(/\/$/, "")]: {
            scenes: { arch: { version: 1 } },
          },
        },
      }) + "\n",
    );
    const code = await run({
      argv: ["push", "arch", "-m", "added b"],
      env: h.env,
      cwd: otherCwd,
      io: pushCap.io,
    });
    assert.equal(code, ExitCode.OK, pushCap.stderr);
  }

  const code = await watchPromise;
  const elapsed = Date.now() - t0;
  assert.equal(code, ExitCode.OK, c.stderr);
  assert.ok(
    elapsed < 1000,
    `watch should react within 1s of push, took ${elapsed}ms`,
  );

  // JSONL: exactly one non-empty line, parseable as a single object.
  const lines = c.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  assert.equal(
    lines.length,
    1,
    `expected one JSONL line, got ${lines.length}: ${c.stdout}`,
  );
  // Must not be pretty-printed multi-line JSON.
  assert.ok(!c.stdout.includes("\n  "), "JSONL must be compact, not pretty");
  const event = JSON.parse(lines[0]!) as {
    slug: string;
    from: number;
    to: number;
    message: string;
    diff: { summary?: { added?: number } };
  };
  assert.equal(event.slug, "arch");
  assert.equal(event.from, 1);
  assert.equal(event.to, 2);
  assert.equal(event.message, "added b");
  assert.ok(event.diff);
  assert.ok(
    (event.diff.summary?.added ?? 0) >= 1,
    "diff should show the added element",
  );
});

test("watch human mode prints a diff after push", async () => {
  const h = await startServer({ eventsTimeoutMs: 5_000 });

  {
    const c = capture();
    assert.equal(
      await run({
        argv: ["new", "Board", "--slug", "board"],
        env: h.env,
        cwd: h.cwd,
        io: c.io,
      }),
      ExitCode.OK,
      c.stderr,
    );
  }
  writeScene(h.cwd, "board", [rect("x")]);
  {
    const c = capture();
    assert.equal(
      await run({
        argv: ["push", "board", "-m", "v1"],
        env: h.env,
        cwd: h.cwd,
        io: c.io,
      }),
      ExitCode.OK,
      c.stderr,
    );
  }

  const c = capture();
  const watchPromise = run({
    argv: ["watch", "board", "--since", "1"],
    env: { ...h.env, EXCALICLI_WATCH_MAX_EVENTS: "1" },
    cwd: h.cwd,
    io: c.io,
  });

  await new Promise<void>((r) => setTimeout(r, 50));

  const otherCwd = tempDir("excalicli-watch-pusher2-");
  writeScene(otherCwd, "board", [rect("x"), rect("y")]);
  fs.mkdirSync(path.join(otherCwd, ".excalidraw-collab"), { recursive: true });
  fs.writeFileSync(
    path.join(otherCwd, ".excalidraw-collab", "state.json"),
    JSON.stringify({
      version: 1,
      servers: {
        [h.baseUrl.replace(/\/$/, "")]: {
          scenes: { board: { version: 1 } },
        },
      },
    }) + "\n",
  );
  {
    const pushCap = capture();
    assert.equal(
      await run({
        argv: ["push", "board", "-m", "added y"],
        env: h.env,
        cwd: otherCwd,
        io: pushCap.io,
      }),
      ExitCode.OK,
      pushCap.stderr,
    );
  }

  const code = await watchPromise;
  assert.equal(code, ExitCode.OK, c.stderr);
  assert.match(c.stdout, /watching board since v1/);
  assert.match(c.stdout, /v1 → v2/);
  assert.match(c.stdout, /added y/);
});

test("watch without SLUG exits usage", async () => {
  const c = capture();
  const code = await run({
    argv: ["watch"],
    env: {
      ...process.env,
      EXCALICLI_SERVER: "http://127.0.0.1:9",
      EXCALICLI_TOKEN: "t",
    },
    io: c.io,
  });
  assert.equal(code, ExitCode.USAGE);
  assert.match(c.stderr, /watch requires SLUG/);
});
