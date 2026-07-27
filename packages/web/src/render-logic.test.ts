import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExportAppState,
  filterExportElements,
  isRenderRequest,
  isSkeletonRequest,
  normalizeRenderOptions,
  RENDER_MSG,
} from "./render-logic.ts";

test("normalizeRenderOptions: defaults", () => {
  assert.deepEqual(normalizeRenderOptions(undefined), {
    scale: 1,
    background: true,
    darkMode: false,
    padding: 10,
  });
});

test("normalizeRenderOptions: accepts explicit values", () => {
  assert.deepEqual(
    normalizeRenderOptions({
      scale: 2,
      background: false,
      darkMode: true,
      padding: 0,
    }),
    { scale: 2, background: false, darkMode: true, padding: 0 },
  );
});

test("normalizeRenderOptions: rejects non-positive scale and negative padding", () => {
  assert.equal(normalizeRenderOptions({ scale: 0 }).scale, 1);
  assert.equal(normalizeRenderOptions({ scale: -3 }).scale, 1);
  assert.equal(normalizeRenderOptions({ padding: -1 }).padding, 10);
});

test("buildExportAppState maps options onto export keys", () => {
  const appState = buildExportAppState(
    { viewBackgroundColor: "#fff", name: "x" },
    { scale: 2, background: false, darkMode: true, padding: 5 },
  );
  assert.equal(appState.exportScale, 2);
  assert.equal(appState.exportBackground, false);
  assert.equal(appState.exportWithDarkMode, true);
  assert.equal(appState.theme, "dark");
  assert.equal(appState.viewBackgroundColor, "#fff");
  assert.equal(appState.name, "x");
});

test("buildExportAppState does not force dark theme when darkMode is off", () => {
  const appState = buildExportAppState(
    { theme: "light" },
    { scale: 1, background: true, darkMode: false, padding: 10 },
  );
  assert.equal(appState.theme, "light");
  assert.equal(appState.exportWithDarkMode, false);
});

test("filterExportElements drops deleted and non-objects", () => {
  const els = [
    { id: "a", isDeleted: false },
    { id: "b", isDeleted: true },
    { id: "c" },
    null,
    "nope",
  ];
  const kept = filterExportElements(els);
  assert.deepEqual(
    kept.map((e) => (e as { id: string }).id),
    ["a", "c"],
  );
});

test("isRenderRequest validates shape", () => {
  assert.equal(isRenderRequest(null), false);
  assert.equal(isRenderRequest({ type: RENDER_MSG.REQUEST }), false);
  assert.equal(
    isRenderRequest({
      type: RENDER_MSG.REQUEST,
      id: "1",
      format: "gif",
      scene: { elements: [] },
    }),
    false,
  );
  assert.equal(
    isRenderRequest({
      type: RENDER_MSG.REQUEST,
      id: "1",
      format: "png",
      scene: { elements: [] },
    }),
    true,
  );
});

test("isSkeletonRequest validates shape", () => {
  assert.equal(isSkeletonRequest(null), false);
  assert.equal(isSkeletonRequest({ type: RENDER_MSG.SKELETON_REQUEST }), false);
  assert.equal(
    isSkeletonRequest({
      type: RENDER_MSG.SKELETON_REQUEST,
      id: "1",
      elements: "nope",
    }),
    false,
  );
  assert.equal(
    isSkeletonRequest({
      type: RENDER_MSG.SKELETON_REQUEST,
      id: "1",
      elements: [],
    }),
    true,
  );
  assert.equal(
    isSkeletonRequest({
      type: RENDER_MSG.SKELETON_REQUEST,
      id: "1",
      elements: [{ type: "rectangle" }],
      regenerateIds: false,
    }),
    true,
  );
  assert.equal(
    isSkeletonRequest({
      type: RENDER_MSG.SKELETON_REQUEST,
      id: "1",
      elements: [],
      regenerateIds: "yes",
    }),
    false,
  );
});
