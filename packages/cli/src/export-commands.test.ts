/**
 * export command against a real in-process server with a stubbed render worker.
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
  type SceneRenderWorker,
} from "@excalidraw-collab/server";
import { run } from "./dispatch.js";
import { ExitCode } from "./errors.js";
import { defaultExportPath } from "./export.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const tempDirs: string[] = [];
const openDbs: Database[] = [];
const openApps: App[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Capture that supports binary stdout chunks. */
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

/** Real PNG magic + non-trivial payload so agents can trust the bytes. */
function fakePng(label: string): Uint8Array {
  const payload = Buffer.from(`PNG-PAYLOAD:${label}:pad=${"x".repeat(64)}`, "utf8");
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, payload]);
}

function fakeSvg(label: string): Uint8Array {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>\n`,
    "utf8",
  );
}

function createMockWorker(): SceneRenderWorker & {
  callCount: number;
  last?: { format: string; scale?: number; darkMode?: boolean };
} {
  let callCount = 0;
  let last: { format: string; scale?: number; darkMode?: boolean } | undefined;
  return {
    get callCount() {
      return callCount;
    },
    get last() {
      return last;
    },
    async render(request) {
      callCount += 1;
      last = {
        format: request.format,
        scale: request.options?.scale,
        darkMode: request.options?.darkMode,
      };
      const label = `${request.format}:s${request.options?.scale ?? 1}:d${request.options?.darkMode ? 1 : 0}`;
      const bytes =
        request.format === "png" ? fakePng(label) : fakeSvg(label);
      return {
        bytes,
        mimeType:
          request.format === "png"
            ? ("image/png" as const)
            : ("image/svg+xml" as const),
        format: request.format,
      };
    },
    async close() {
      // no-op
    },
  };
}

type Harness = {
  app: App;
  db: Database;
  baseUrl: string;
  token: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  worker: ReturnType<typeof createMockWorker> | null;
};

async function startServer(opts: {
  renderWorker?: SceneRenderWorker | null;
  renderWorkerMode?: "on" | "off";
} = {}): Promise<Harness> {
  const dataDir = tempDir("excalicli-export-data-");
  const cwd = tempDir("excalicli-export-cwd-");
  const configHome = tempDir("excalicli-export-xdg-");
  const token = "test-bootstrap-token-export-cli";

  const db = openDatabase(dataDir);
  openDbs.push(db);

  const mode = opts.renderWorkerMode ?? (opts.renderWorker === null ? "off" : "on");
  let worker: ReturnType<typeof createMockWorker> | null = null;
  let renderWorker: SceneRenderWorker | null;
  if (opts.renderWorker !== undefined) {
    renderWorker = opts.renderWorker;
    if (renderWorker && "callCount" in renderWorker) {
      worker = renderWorker as ReturnType<typeof createMockWorker>;
    }
  } else if (mode === "off") {
    renderWorker = null;
  } else {
    worker = createMockWorker();
    renderWorker = worker;
  }

  const app = await buildApp({
    config: {
      port: 0,
      dataDir,
      bootstrapToken: token,
      renderWorker: mode,
      logLevel: "silent",
      serveStatic: false,
      staticRoot: "",
      maxFileBytes: 10 * 1024 * 1024,
    },
    db,
    renderWorker,
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

  return { app, db, baseUrl, token, cwd, env, worker };
}

async function createSceneWithContent(
  h: Harness,
  slug: string,
  name = "Architecture",
): Promise<void> {
  const newC = capture();
  const newCode = await run({
    argv: ["new", name, "--slug", slug],
    env: h.env,
    io: newC.io,
    cwd: h.cwd,
  });
  assert.equal(newCode, ExitCode.OK, newC.stderr);

  // Push a version so head is 1 with real elements (new may create empty head 0 or 0 versions).
  const scenePath = path.join(h.cwd, `${slug}.excalidraw`);
  const doc = {
    type: "excalidraw",
    version: 2,
    source: "excalicli-test",
    elements: [
      {
        id: "box1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  fs.writeFileSync(scenePath, `${JSON.stringify(doc)}\n`);

  // Pull first is not required if new left no local state — push needs parent.
  // After `new`, local state may already record version 0 or none; push without pull.
  const pullC = capture();
  await run({
    argv: ["pull", slug, "-o", scenePath],
    env: h.env,
    io: pullC.io,
    cwd: h.cwd,
  });
  // Overwrite with our content and push.
  fs.writeFileSync(scenePath, `${JSON.stringify(doc)}\n`);
  const pushC = capture();
  const pushCode = await run({
    argv: ["push", slug, "-f", scenePath, "-m", "initial"],
    env: h.env,
    io: pushC.io,
    cwd: h.cwd,
  });
  assert.equal(pushCode, ExitCode.OK, pushC.stderr + pushC.stdout);
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

// ─── usage ──────────────────────────────────────────────────────────────────

test("export without --format exits usage with parseable --json", async () => {
  const h = await startServer({ renderWorkerMode: "off" });
  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, "USAGE");
  assert.match(c.stderr, /--format/);
});

test("defaultExportPath derives slug and version", () => {
  assert.equal(defaultExportPath("arch", 3, "png"), "arch-v3.png");
  assert.equal(defaultExportPath("arch", 1, "svg"), "arch-v1.svg");
  assert.equal(defaultExportPath("arch", 2, "json"), "arch-v2.json");
});

// ─── PNG export (mock worker) ───────────────────────────────────────────────

test("export png to file produces real PNG bytes", async () => {
  const h = await startServer();
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "png", "-o", "arch.png"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr + c.stdout);
  assert.match(c.stdout, /Exported arch v\d+ → arch\.png/);
  assert.equal(c.stderr, "");

  const out = path.join(h.cwd, "arch.png");
  assert.ok(fs.existsSync(out));
  const bytes = fs.readFileSync(out);
  // PNG magic number
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.ok(bytes.byteLength > 32, `expected non-trivial PNG, got ${bytes.byteLength}`);
  assert.ok(h.worker && h.worker.callCount >= 1);
});

test("export png -o - streams binary cleanly to stdout", async () => {
  const h = await startServer();
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "png", "-o", "-"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  assert.equal(c.stderr, "");
  const bytes = c.stdoutBytes;
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.ok(bytes.byteLength > 32);
  // No JSON / text trailer mixed into the stream.
  assert.equal(bytes.toString("utf8").includes("Exported"), false);
  assert.equal(bytes.toString("utf8").includes("{"), false);
});

test("export png to file with --json emits metadata only on stdout", async () => {
  const h = await startServer();
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: [
      "export",
      "arch",
      "--format",
      "png",
      "-o",
      "out.png",
      "--scale",
      "2",
      "--dark",
      "--json",
    ],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const meta = JSON.parse(c.stdout) as {
    slug: string;
    format: string;
    path: string;
    bytes: number;
    scale: number;
    dark: boolean;
    version: number;
  };
  assert.equal(meta.slug, "arch");
  assert.equal(meta.format, "png");
  assert.equal(meta.path, "out.png");
  assert.equal(meta.scale, 2);
  assert.equal(meta.dark, true);
  assert.ok(meta.bytes > 32);
  assert.ok(meta.version >= 1);

  const fileBytes = fs.readFileSync(path.join(h.cwd, "out.png"));
  assert.equal(fileBytes.byteLength, meta.bytes);
  assert.deepEqual(
    [...fileBytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  // stdout is pure JSON — not mixed with PNG.
  assert.equal(c.stdoutBytes[0], 0x7b); // '{'
});

test("export png -o - with --json is a usage error (no stream corruption)", async () => {
  const h = await startServer();
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "png", "-o", "-", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string };
  };
  assert.equal(parsed.error.code, "USAGE");
  assert.match(parsed.error.message, /cannot combine --json with binary stdout/);
  // No PNG magic leaked onto stdout before the error envelope.
  assert.notEqual(c.stdoutBytes[0], 0x89);
});

test("export svg to default path derived from slug and version", async () => {
  const h = await startServer();
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "svg", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const meta = JSON.parse(c.stdout) as {
    path: string;
    version: number;
    format: string;
  };
  assert.equal(meta.format, "svg");
  assert.equal(meta.path, `arch-v${meta.version}.svg`);
  const body = fs.readFileSync(path.join(h.cwd, meta.path), "utf8");
  assert.match(body, /<svg/);
});

// ─── JSON export works without render worker ────────────────────────────────

test("export --format json succeeds when render worker is off", async () => {
  const h = await startServer({ renderWorker: null, renderWorkerMode: "off" });
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "json", "-o", "arch.json", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr);
  const meta = JSON.parse(c.stdout) as {
    format: string;
    path: string;
    bytes: number;
  };
  assert.equal(meta.format, "json");
  assert.equal(meta.path, "arch.json");
  const scene = JSON.parse(
    fs.readFileSync(path.join(h.cwd, "arch.json"), "utf8"),
  ) as { elements: unknown[] };
  assert.ok(Array.isArray(scene.elements));
  assert.ok(scene.elements.length >= 1);
});

// ─── 501 disabled / not_installed ───────────────────────────────────────────

test("export png when RENDER_WORKER=off: actionable disabled message", async () => {
  const h = await startServer({ renderWorker: null, renderWorkerMode: "off" });
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "png", "-o", "x.png", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.ERROR);
  const parsed = JSON.parse(c.stdout) as {
    error: {
      code: string;
      message: string;
      details?: { reason?: string };
    };
  };
  assert.equal(parsed.error.code, "NOT_IMPLEMENTED");
  assert.equal(parsed.error.details?.reason, "disabled");
  assert.match(parsed.error.message, /RENDER_WORKER=off/);
  assert.match(parsed.error.message, /--format json still works/);
  assert.match(c.stderr, /RENDER_WORKER=off/);
  assert.match(c.stderr, /--format json still works/);
  assert.equal(fs.existsSync(path.join(h.cwd, "x.png")), false);
});

test("export png when Playwright missing: actionable not_installed message", async () => {
  const missing: SceneRenderWorker = {
    async render() {
      const err = Object.assign(new Error("Cannot find module 'playwright'"), {
        name: "RenderError",
        code: "NOT_INSTALLED",
      });
      throw err;
    },
    async close() {
      // no-op
    },
  };
  const h = await startServer({
    renderWorker: missing,
    renderWorkerMode: "on",
  });
  await createSceneWithContent(h, "arch");

  const c = capture();
  const code = await run({
    argv: ["export", "arch", "--format", "png", "-o", "x.png", "--json"],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.ERROR);
  const parsed = JSON.parse(c.stdout) as {
    error: {
      code: string;
      message: string;
      details?: { reason?: string };
    };
  };
  assert.equal(parsed.error.code, "NOT_IMPLEMENTED");
  assert.equal(parsed.error.details?.reason, "not_installed");
  assert.match(parsed.error.message, /Playwright is not installed/);
  assert.match(parsed.error.message, /--format json still works/);
  assert.match(c.stderr, /Playwright is not installed/);
});

test("export --help lists the command", async () => {
  const c = capture();
  const code = await run({
    argv: ["export", "--help"],
    io: c.io,
  });
  assert.equal(code, ExitCode.OK);
  assert.match(c.stdout, /--format/);
  assert.match(c.stdout, /png\|svg\|json/);
});
