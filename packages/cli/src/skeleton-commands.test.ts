/**
 * push --skeleton against an in-process server with a mock converter
 * (and a disabled path when no converter is wired).
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
  type SkeletonConverter,
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
  db: Database;
  baseUrl: string;
  token: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

async function startServer(opts: {
  converter?: SkeletonConverter | null;
} = {}): Promise<Harness> {
  const dataDir = tempDir("excalicli-skel-data-");
  const cwd = tempDir("excalicli-skel-cwd-");
  const configHome = tempDir("excalicli-skel-xdg-");
  const token = "test-bootstrap-token-skeleton-cli";

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

  return { app, db, baseUrl, token, cwd, env };
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

/** Under-20-line architecture skeleton (done-when). */
const ARCH_SKELETON = [
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
    id: "a-api-db",
    start: { id: "api" },
    end: { id: "db" },
  },
  {
    type: "arrow",
    id: "a-api-cache",
    start: { id: "api" },
    end: { id: "cache" },
  },
];

test("push --skeleton with worker disabled fails with actionable message", async () => {
  const h = await startServer({ converter: null });
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const file = path.join(h.cwd, "arch.skeleton.json");
  fs.writeFileSync(file, `${JSON.stringify(ARCH_SKELETON)}\n`);

  const c = capture();
  const code = await run({
    argv: [
      "push",
      "arch",
      "--skeleton",
      "-f",
      "arch.skeleton.json",
      "-m",
      "arch from skeleton",
      "--json",
    ],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.ERROR);
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string };
  };
  assert.equal(parsed.error.code, "NOT_IMPLEMENTED");
  assert.match(parsed.error.message, /RENDER_WORKER=on/);
});

test("push --skeleton with mock converter pushes bound full elements", async () => {
  const converter: SkeletonConverter = {
    convert: async ({ elements }) => {
      // Expand to "full" elements with real binding fields so we can prove
      // the push path stores what convert returned (bindings not invented by CLI).
      const boxes = (elements as Array<{ id: string; type: string }>).filter(
        (e) => e.type === "rectangle",
      );
      const arrows = (elements as Array<{
        id: string;
        type: string;
        start?: { id: string };
        end?: { id: string };
      }>).filter((e) => e.type === "arrow");

      const full: unknown[] = [];
      for (const b of boxes) {
        const bound = arrows
          .filter(
            (a) => a.start?.id === b.id || a.end?.id === b.id,
          )
          .map((a) => ({ id: a.id, type: "arrow" as const }));
        full.push({
          id: b.id,
          type: "rectangle",
          x: 0,
          y: 0,
          width: 160,
          height: 80,
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
          boundElements: bound,
          updated: 1,
          link: null,
          locked: false,
        });
      }
      for (const a of arrows) {
        full.push({
          id: a.id,
          type: "arrow",
          x: 0,
          y: 0,
          width: 100,
          height: 0,
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
          points: [
            [0, 0],
            [100, 0],
          ],
          lastCommittedPoint: null,
          startBinding: a.start?.id
            ? { elementId: a.start.id, focus: 0, gap: 1 }
            : null,
          endBinding: a.end?.id
            ? { elementId: a.end.id, focus: 0, gap: 1 }
            : null,
          startArrowhead: null,
          endArrowhead: "arrow",
        });
      }
      return { elements: full };
    },
  };

  const h = await startServer({ converter });
  await run({
    argv: ["new", "Arch", "--slug", "arch"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const file = path.join(h.cwd, "arch.skeleton.json");
  // One element per line — under 20 lines.
  const lines = [
    "[",
    ...ARCH_SKELETON.map(
      (el, i) =>
        `  ${JSON.stringify(el)}${i < ARCH_SKELETON.length - 1 ? "," : ""}`,
    ),
    "]",
    "",
  ];
  assert.ok(lines.length < 20, `got ${lines.length} lines`);
  fs.writeFileSync(file, lines.join("\n"));

  const c = capture();
  const code = await run({
    argv: [
      "push",
      "arch",
      "--skeleton",
      "-f",
      "arch.skeleton.json",
      "-m",
      "three-box architecture",
      "--json",
    ],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.OK, c.stderr + c.stdout);
  const pushed = JSON.parse(c.stdout) as {
    version: number;
    skeleton: boolean;
    elementCount: number;
    skeletonElementCount: number;
  };
  assert.equal(pushed.version, 1);
  assert.equal(pushed.skeleton, true);
  assert.equal(pushed.skeletonElementCount, 5);
  // 3 boxes + 2 arrows (mock does not add bound-text elements)
  assert.equal(pushed.elementCount, 5);

  // Pull and assert real bindings were stored.
  const pull = capture();
  const pullCode = await run({
    argv: ["pull", "arch", "--json"],
    env: h.env,
    io: pull.io,
    cwd: h.cwd,
  });
  assert.equal(pullCode, ExitCode.OK, pull.stderr);
  const scene = JSON.parse(
    fs.readFileSync(path.join(h.cwd, "arch.excalidraw"), "utf8"),
  ) as {
    elements: Array<{
      id: string;
      type: string;
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
      boundElements?: Array<{ id: string; type: string }> | null;
    }>;
  };
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const a1 = byId.get("a-api-db");
  const a2 = byId.get("a-api-cache");
  const api = byId.get("api");
  assert.ok(a1 && a2 && api);
  assert.equal(a1.startBinding?.elementId, "api");
  assert.equal(a1.endBinding?.elementId, "db");
  assert.equal(a2.startBinding?.elementId, "api");
  assert.equal(a2.endBinding?.elementId, "cache");
  assert.ok(
    (api.boundElements ?? []).some((b) => b.id === "a-api-db"),
  );
  assert.ok(
    (api.boundElements ?? []).some((b) => b.id === "a-api-cache"),
  );
});

test("push --skeleton reports validation index and reason", async () => {
  const converter: SkeletonConverter = {
    convert: async () => ({ elements: [] }),
  };
  const h = await startServer({ converter });
  await run({
    argv: ["new", "Bad", "--slug", "bad"],
    env: h.env,
    io: capture().io,
    cwd: h.cwd,
  });

  const file = path.join(h.cwd, "bad.skeleton.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 },
      { type: "mystery", x: 0, y: 0 },
    ])}\n`,
  );

  const c = capture();
  const code = await run({
    argv: [
      "push",
      "bad",
      "--skeleton",
      "-f",
      "bad.skeleton.json",
      "-m",
      "nope",
      "--json",
    ],
    env: h.env,
    io: c.io,
    cwd: h.cwd,
  });
  assert.equal(code, ExitCode.USAGE);
  const parsed = JSON.parse(c.stdout) as {
    error: { code: string; message: string; details?: { index: number; reason: string } };
  };
  assert.equal(parsed.error.code, "VALIDATION");
  assert.match(parsed.error.message, /skeleton\[1\]/);
  assert.equal(parsed.error.details?.index, 1);
  assert.match(parsed.error.details?.reason ?? "", /unknown type/);
});
