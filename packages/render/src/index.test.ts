import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import {
  isPlaywrightModuleNotFound,
  isRenderWorkerEnabled,
  loadPlaywright,
  openRenderWorker,
  PLAYWRIGHT_NOT_INSTALLED_MESSAGE,
  RenderError,
  setPlaywrightImporterForTests,
} from "./index.js";
import { createRenderWorker } from "./worker.js";

afterEach(() => {
  setPlaywrightImporterForTests(null);
});

test("isRenderWorkerEnabled defaults to off", () => {
  assert.equal(isRenderWorkerEnabled({}), false);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "" }), false);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "off" }), false);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "false" }), false);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "0" }), false);
});

test("isRenderWorkerEnabled accepts on/true/1", () => {
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "on" }), true);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "true" }), true);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "1" }), true);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "ON" }), true);
});

test("isRenderWorkerEnabled mode override wins over env", () => {
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "on" }, "off"), false);
  assert.equal(isRenderWorkerEnabled({ RENDER_WORKER: "off" }, "on"), true);
});

test("openRenderWorker returns null without importing playwright when off", async () => {
  let playwrightImportAttempts = 0;
  setPlaywrightImporterForTests(async () => {
    playwrightImportAttempts += 1;
    throw new Error("playwright import must not run when off");
  });

  const worker = await openRenderWorker(
    { baseUrl: "http://127.0.0.1:9" },
    { RENDER_WORKER: "off" },
  );
  assert.equal(worker, null);
  assert.equal(
    playwrightImportAttempts,
    0,
    "Playwright must not be imported when RENDER_WORKER=off",
  );

  // Playwright may still be installed (optional deps default on); the point
  // is that the off path never touches it.
  const require = createRequire(import.meta.url);
  assert.ok(require.resolve("playwright"));
});

test("RenderError carries a stable code", () => {
  const err = new RenderError("DISABLED", "worker off");
  assert.equal(err.code, "DISABLED");
  assert.equal(err.name, "RenderError");
  assert.equal(err.message, "worker off");
});

test("isPlaywrightModuleNotFound detects ERR_MODULE_NOT_FOUND for playwright", () => {
  const err = Object.assign(new Error("Cannot find package 'playwright'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  assert.equal(isPlaywrightModuleNotFound(err), true);
  assert.equal(
    isPlaywrightModuleNotFound(new Error("something else")),
    false,
  );
});

test("loadPlaywright maps missing module to RenderError NOT_INSTALLED", async () => {
  setPlaywrightImporterForTests(async () => {
    throw Object.assign(
      new Error("Cannot find package 'playwright' imported from worker.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  });

  await assert.rejects(
    () => loadPlaywright(),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal(err.code, "NOT_INSTALLED");
      assert.equal(err.message, PLAYWRIGHT_NOT_INSTALLED_MESSAGE);
      assert.match(err.message, /not installed/i);
      assert.match(err.message, /optional|no-optional|without render/i);
      return true;
    },
  );
});

test("worker.render surfaces NOT_INSTALLED when Playwright is unavailable", async () => {
  setPlaywrightImporterForTests(async () => {
    throw Object.assign(new Error("Cannot find package 'playwright'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  });

  const worker = createRenderWorker({
    baseUrl: "http://127.0.0.1:9",
    // No idle shutdown; we never launch.
    idleTimeoutMs: 0,
  });
  try {
    await assert.rejects(
      () =>
        worker.render({
          scene: { elements: [] },
          format: "png",
        }),
      (err: unknown) => {
        assert.ok(err instanceof RenderError);
        assert.equal(err.code, "NOT_INSTALLED");
        assert.match(err.message, /Playwright is not installed/i);
        // Must not leak raw Node resolution errors as the top-level message.
        assert.doesNotMatch(err.message, /ERR_MODULE_NOT_FOUND/);
        return true;
      },
    );
  } finally {
    await worker.close();
  }
});
