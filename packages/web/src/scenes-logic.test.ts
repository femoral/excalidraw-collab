import assert from "node:assert/strict";
import { test } from "node:test";
import type { SceneInfo } from "./api.ts";
import {
  buildCreatePayload,
  buildRenamePayload,
  formatUpdatedAt,
  headAuthorLabel,
  isLockActive,
  isValidSlug,
  reduceSceneList,
  sceneListOnUnauthorized,
  sortScenesByUpdatedAt,
  versionCount,
  type SceneListStatus,
} from "./scenes-logic.ts";

function scene(overrides: Partial<SceneInfo> = {}): SceneInfo {
  return {
    id: "id-1",
    slug: "arch",
    name: "Architecture",
    headVersion: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lock: null,
    elementCount: 3,
    headAuthor: "admin",
    thumbnailFileId: null,
    ...overrides,
  };
}

test("sortScenesByUpdatedAt newest first", () => {
  const a = scene({
    id: "a",
    slug: "a",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const b = scene({
    id: "b",
    slug: "b",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  const c = scene({
    id: "c",
    slug: "c",
    updatedAt: "2026-02-01T00:00:00.000Z",
  });
  assert.deepEqual(
    sortScenesByUpdatedAt([a, b, c]).map((s) => s.slug),
    ["b", "c", "a"],
  );
});

test("isLockActive respects expiry", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  assert.equal(isLockActive(null, now), false);
  assert.equal(
    isLockActive(
      { holder: "agent", expiresAt: "2026-06-01T13:00:00.000Z" },
      now,
    ),
    true,
  );
  assert.equal(
    isLockActive(
      { holder: "agent", expiresAt: "2026-06-01T11:00:00.000Z" },
      now,
    ),
    false,
  );
});

test("versionCount is headVersion", () => {
  assert.equal(versionCount(scene({ headVersion: 0 })), 0);
  assert.equal(versionCount(scene({ headVersion: 7 })), 7);
});

test("isValidSlug mirrors server rules", () => {
  assert.equal(isValidSlug("arch"), true);
  assert.equal(isValidSlug("my-cool-board"), true);
  assert.equal(isValidSlug(""), false);
  assert.equal(isValidSlug("Upper"), false);
  assert.equal(isValidSlug("-leading"), false);
  assert.equal(isValidSlug("trailing-"), false);
  assert.equal(isValidSlug("a--b"), false);
});

test("formatUpdatedAt uses relative units for recent times", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const label = formatUpdatedAt("2026-06-01T11:00:00.000Z", now);
  // RelativeTimeFormat wording varies by locale; just ensure non-empty.
  assert.ok(label.length > 0);
  assert.notEqual(label, "2026-06-01T11:00:00.000Z");
});

test("headAuthorLabel", () => {
  assert.equal(headAuthorLabel(scene({ headAuthor: "bot" })), "bot");
  assert.equal(
    headAuthorLabel(scene({ headAuthor: null, headVersion: 0 })),
    "No commits yet",
  );
});

test("buildCreatePayload / buildRenamePayload validation", () => {
  assert.deepEqual(buildCreatePayload("  Board  ", ""), {
    ok: true,
    body: { name: "Board" },
  });
  assert.deepEqual(buildCreatePayload("Board", "arch"), {
    ok: true,
    body: { name: "Board", slug: "arch" },
  });
  assert.equal(buildCreatePayload("  ", "").ok, false);
  // Uppercase is normalized to lowercase before validation.
  assert.deepEqual(buildCreatePayload("Board", "ARCH"), {
    ok: true,
    body: { name: "Board", slug: "arch" },
  });
  assert.equal(buildCreatePayload("Board", "a--b").ok, false);
  assert.equal(buildCreatePayload("Board", "-leading").ok, false);

  assert.deepEqual(buildRenamePayload("  New  "), {
    ok: true,
    name: "New",
  });
  assert.equal(buildRenamePayload("").ok, false);
});

test("reduceSceneList load cycle and upsert/remove", () => {
  let state: SceneListStatus = { kind: "idle" };
  state = reduceSceneList(state, { type: "load_start" });
  assert.equal(state.kind, "loading");

  const a = scene({ id: "1", slug: "a", updatedAt: "2026-01-01T00:00:00.000Z" });
  const b = scene({ id: "2", slug: "b", updatedAt: "2026-02-01T00:00:00.000Z" });
  state = reduceSceneList(state, { type: "load_success", scenes: [a, b] });
  assert.equal(state.kind, "ready");
  if (state.kind === "ready") {
    assert.deepEqual(
      state.scenes.map((s) => s.slug),
      ["b", "a"],
    );
  }

  const renamed = scene({
    id: "1",
    slug: "a",
    name: "Renamed",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  state = reduceSceneList(state, { type: "upsert", scene: renamed });
  if (state.kind === "ready") {
    assert.equal(state.scenes[0]!.name, "Renamed");
    assert.equal(state.scenes.length, 2);
  }

  state = reduceSceneList(state, { type: "remove", slug: "b" });
  if (state.kind === "ready") {
    assert.deepEqual(
      state.scenes.map((s) => s.slug),
      ["a"],
    );
  }
});

test("401 path: unauthorized resets to idle (no half-list, no error banner)", () => {
  const ready: SceneListStatus = {
    kind: "ready",
    scenes: [scene()],
  };
  const after = reduceSceneList(ready, { type: "unauthorized" });
  assert.deepEqual(after, { kind: "idle" });
  assert.deepEqual(sceneListOnUnauthorized(), { kind: "idle" });

  // Error path also does not preserve previous scenes.
  const fromReadyError = reduceSceneList(ready, {
    type: "load_error",
    message: "network down",
  });
  assert.deepEqual(fromReadyError, {
    kind: "error",
    message: "network down",
  });
});
