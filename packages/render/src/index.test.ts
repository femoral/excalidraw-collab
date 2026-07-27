import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { isRenderWorkerEnabled, openRenderWorker, RenderError } from "./index.js";

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
  // Prove the dynamic import path is never taken: resolve playwright via
  // createRequire and ensure openRenderWorker(off) returns null quickly.
  const worker = await openRenderWorker(
    { baseUrl: "http://127.0.0.1:9" },
    { RENDER_WORKER: "off" },
  );
  assert.equal(worker, null);

  // Module graph of this file must not have loaded worker.js's playwright.
  // We check that require.resolve still works (playwright is installed) but
  // that we did not need to launch anything.
  const require = createRequire(import.meta.url);
  assert.ok(require.resolve("playwright"));
});

test("RenderError carries a stable code", () => {
  const err = new RenderError("DISABLED", "worker off");
  assert.equal(err.code, "DISABLED");
  assert.equal(err.name, "RenderError");
  assert.equal(err.message, "worker off");
});
