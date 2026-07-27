/**
 * Acceptance tests for the Playwright render worker.
 *
 * When Chromium binaries are missing these tests skip with an explicit
 * reason (never a silent pass). Run `pnpm exec playwright install chromium`
 * to enable them.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createRenderWorker } from "./index.js";
import { startStaticServer, type StaticServer } from "./static-server.js";
import { RenderError, type RenderWorker } from "./types.js";
import type { RenderWorkerHandle } from "./worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** packages/web/dist — produced by `pnpm --filter @excalidraw-collab/web build`. */
const WEB_DIST = join(__dirname, "..", "..", "web", "dist");
const FIXTURES_DIR = join(
  __dirname,
  "..",
  "..",
  "core",
  "test",
  "fixtures",
);

const FIXTURE_FILES = [
  "empty.excalidraw",
  "simple-shapes.excalidraw",
  "bound-text.excalidraw",
  "arrows-bound.excalidraw",
  "frames.excalidraw",
  "with-image.excalidraw",
];

async function chromiumAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Chromium unavailable (${msg}). Install with: pnpm exec playwright install chromium`,
    };
  }
}

async function webDistReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const index = join(WEB_DIST, "index.html");
    await readFile(index);
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `web dist missing at ${WEB_DIST}; run pnpm --filter @excalidraw-collab/web build first`,
    };
  }
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

type FixtureScene = {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

async function loadFixture(name: string): Promise<FixtureScene> {
  const raw = JSON.parse(await readFile(join(FIXTURES_DIR, name), "utf8")) as {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  };
  return {
    elements: raw.elements ?? [],
    appState: raw.appState,
    files: raw.files,
  };
}

describe("render worker (playwright)", async () => {
  const browserCheck = await chromiumAvailable();
  const distCheck = await webDistReady();

  if (!browserCheck.ok) {
    test("SKIP: chromium not available", { skip: browserCheck.reason }, () => {});
    return;
  }
  if (!distCheck.ok) {
    test("SKIP: web dist not built", { skip: distCheck.reason }, () => {});
    return;
  }

  let server: StaticServer;
  let worker: RenderWorkerHandle;

  before(async () => {
    server = await startStaticServer(WEB_DIST);
    worker = await createRenderWorker({
      baseUrl: server.baseUrl,
      concurrency: 2,
      renderTimeoutMs: 60_000,
      // Keep browser up across tests; we close explicitly.
      idleTimeoutMs: 0,
    });
  });

  after(async () => {
    await worker?.close();
    await server?.close();
  });

  test("lazy launch: isRunning is false before first render", () => {
    assert.equal(worker.isRunning, false);
  });

  for (const fixture of FIXTURE_FILES) {
    test(`fixture ${fixture} → PNG`, async () => {
      const scene = await loadFixture(fixture);
      const result = await worker.render({
        scene,
        format: "png",
        options: { scale: 1, background: true, padding: 10 },
      });
      assert.equal(result.format, "png");
      assert.equal(result.mimeType, "image/png");
      assert.ok(isPng(result.bytes), "expected PNG signature");
      assert.ok(result.bytes.length > 50, "PNG should not be empty");
      assert.equal(worker.isRunning, true);
    });

    test(`fixture ${fixture} → SVG`, async () => {
      const scene = await loadFixture(fixture);
      const result = await worker.render({
        scene,
        format: "svg",
        options: { background: true, padding: 10 },
      });
      assert.equal(result.format, "svg");
      assert.equal(result.mimeType, "image/svg+xml");
      assert.ok(isSvg(result.bytes), "expected SVG markup");
      const text = new TextDecoder().decode(result.bytes);
      // Bound-text / frames fixtures should carry text content into the SVG.
      if (fixture === "bound-text.excalidraw") {
        assert.match(text, /Auth|Cache|text|tspan/i);
      }
    });
  }

  test("options: dark mode and no background produce SVG", async () => {
    const scene = await loadFixture("simple-shapes.excalidraw");
    const result = await worker.render({
      scene,
      format: "svg",
      options: { background: false, darkMode: true, scale: 2, padding: 4 },
    });
    assert.ok(isSvg(result.bytes));
  });

  test("killing the browser mid-render surfaces a clean error and recovers", async () => {
    const scene = await loadFixture("with-image.excalidraw");

    // Ensure browser is up and we have a real OS pid.
    await worker.render({ scene, format: "png" });
    const pid = worker.getBrowserPid();
    assert.ok(pid && pid > 0, "expected a browser pid after first render");

    // Queue several concurrent heavy renders so at least one is mid-flight
    // when we SIGKILL Chromium (single renders finish in ~20ms once warm).
    const pendings = Array.from({ length: 6 }, () =>
      worker.render({
        scene,
        format: "png",
        options: { scale: 3 },
      }),
    );

    // Kill as soon as the event loop yields — process must die under load.
    await new Promise((r) => setImmediate(r));
    worker.killBrowserProcess();

    const settled = await Promise.allSettled(pendings);
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.ok(
      rejected.length >= 1,
      `expected at least one mid-render failure after kill; settled=${JSON.stringify(
        settled.map((s) =>
          s.status === "fulfilled"
            ? "ok"
            : (s.reason as Error)?.message ?? "err",
        ),
      )}`,
    );
    for (const s of rejected) {
      if (s.status !== "rejected") continue;
      const err = s.reason;
      // Accept RenderError, or a raw Playwright error that mentions browser
      // death (wrapped by the worker on the recovery path either way).
      if (err instanceof RenderError) {
        assert.ok(
          err.code === "BROWSER_CLOSED" ||
            err.code === "RENDER_FAILED" ||
            err.code === "TIMEOUT",
          `unexpected code ${err.code}: ${err.message}`,
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(
          msg,
          /Browser closed|Target closed|has been closed|Connection closed/i,
          `unexpected rejection: ${msg}`,
        );
      }
    }

    // Let disconnect handlers settle so no stray newPage races the recovery.
    await new Promise((r) => setTimeout(r, 100));

    // Next render must recover by re-launching Chromium.
    const recovered = await worker.render({ scene, format: "png" });
    assert.ok(isPng(recovered.bytes));
    assert.equal(worker.isRunning, true);
  });

  test("all fixture files are covered", async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) =>
      f.endsWith(".excalidraw"),
    );
    for (const f of FIXTURE_FILES) {
      assert.ok(files.includes(f), `missing fixture ${f}`);
    }
  });

  /** Minimal rectangle accepted by restoreElements / reconcileElements. */
  function mergeRect(
    id: string,
    opts: {
      x?: number;
      version?: number;
      versionNonce?: number;
    } = {},
  ): Record<string, unknown> {
    return {
      id,
      type: "rectangle",
      x: opts.x ?? 0,
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
      version: opts.version ?? 1,
      versionNonce: opts.versionNonce ?? 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    };
  }

  test("merge: divergent edits to different elements both survive", async () => {
    // local edited B, remote edited A — both must remain after reconcile.
    const result = await worker.merge({
      local: {
        elements: [
          mergeRect("a", { x: 0, version: 1, versionNonce: 1 }),
          mergeRect("b", { x: 200, version: 2, versionNonce: 3 }),
        ],
      },
      remote: {
        elements: [
          mergeRect("a", { x: 50, version: 2, versionNonce: 2 }),
          mergeRect("b", { x: 100, version: 1, versionNonce: 1 }),
        ],
      },
      appState: {},
    });
    assert.ok(Array.isArray(result.elements));
    const byId = Object.fromEntries(
      result.elements.map((e) => {
        const el = e as { id: string; x: number };
        return [el.id, el];
      }),
    );
    assert.ok(byId.a, "element a present");
    assert.ok(byId.b, "element b present");
    assert.equal(byId.a.x, 50, "remote edit to a survives");
    assert.equal(byId.b.x, 200, "local edit to b survives");
  });

  test("merge: same element resolves by upstream version rule, deterministically", async () => {
    const local = {
      elements: [mergeRect("a", { x: 1, version: 2, versionNonce: 1 })],
    };
    const remote = {
      elements: [mergeRect("a", { x: 99, version: 3, versionNonce: 99 })],
    };

    const first = await worker.merge({ local, remote, appState: {} });
    const second = await worker.merge({ local, remote, appState: {} });

    // Deterministic: identical inputs → identical outputs.
    assert.deepEqual(
      first.elements.map((e) => ({
        id: (e as { id: string }).id,
        x: (e as { x: number }).x,
        version: (e as { version: number }).version,
      })),
      second.elements.map((e) => ({
        id: (e as { id: string }).id,
        x: (e as { x: number }).x,
        version: (e as { version: number }).version,
      })),
    );

    // Upstream rule: remote.version (3) > local.version (2) → remote content
    // wins (x=99). restoreElements may bump version numbers, so assert on
    // content (x), not the absolute version after restore.
    const winner = first.elements[0] as { x: number };
    assert.equal(winner.x, 99, "higher remote.version must win");

    // Local wins when its version is higher.
    const localWins = await worker.merge({
      local: {
        elements: [mergeRect("a", { x: 7, version: 5, versionNonce: 1 })],
      },
      remote: {
        elements: [mergeRect("a", { x: 50, version: 2, versionNonce: 20 })],
      },
      appState: {},
    });
    assert.equal(
      (localWins.elements[0] as { x: number }).x,
      7,
      "higher local.version must win",
    );

    // Note: same-version versionNonce ties are decided by upstream after
    // restoreElements (which may rewrite nonces). We do not assert that
    // edge here — only that the version-primary rule matches reconcileElements.
  });
});

// Ensure the type export is used (compile-time).
void (null as unknown as RenderWorker);
