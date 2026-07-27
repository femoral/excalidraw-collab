import assert from "node:assert/strict";
import { test } from "node:test";
import type { GlobalSceneEvent, SceneInfo } from "./api.ts";
import {
  applyGlobalEventsToList,
  applyGlobalEventToScene,
  buildCreatePayload,
  buildRenamePayload,
  formatUpdatedAt,
  headAuthorLabel,
  isLockActive,
  isValidSlug,
  lockExpiryDelayMs,
  reduceSceneList,
  sceneListOnUnauthorized,
  shouldApplyGlobalEvent,
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

// ---------------------------------------------------------------------------
// Live refresh / self-authored suppression (issue #37)
// ---------------------------------------------------------------------------

function versionEvent(
  overrides: Partial<GlobalSceneEvent> = {},
): GlobalSceneEvent {
  return {
    seq: 1,
    sceneId: "id-1",
    slug: "arch",
    kind: "version",
    headVersion: 3,
    version: 3,
    parentVersion: 2,
    author: "agent",
    message: "pushed",
    createdAt: "2026-06-01T12:00:00.000Z",
    elementCount: 9,
    sceneHash: "h3",
    thumbnailFileId: null,
    lock: null,
    ...overrides,
  };
}

function lockEvent(
  overrides: Partial<GlobalSceneEvent> = {},
): GlobalSceneEvent {
  return {
    seq: 2,
    sceneId: "id-1",
    slug: "arch",
    kind: "lock",
    headVersion: 2,
    lock: { holder: "agent", expiresAt: "2026-06-01T13:00:00.000Z" },
    actor: "agent",
    ...overrides,
  };
}

test("shouldApplyGlobalEvent suppresses self-authored version and lock", () => {
  assert.equal(
    shouldApplyGlobalEvent(versionEvent({ author: "me" }), "me"),
    false,
  );
  assert.equal(
    shouldApplyGlobalEvent(versionEvent({ author: "agent" }), "me"),
    true,
  );
  assert.equal(
    shouldApplyGlobalEvent(lockEvent({ actor: "me" }), "me"),
    false,
  );
  assert.equal(
    shouldApplyGlobalEvent(lockEvent({ actor: "agent" }), "me"),
    true,
  );
  // No self identity → never suppress.
  assert.equal(shouldApplyGlobalEvent(versionEvent({ author: "x" }), null), true);
});

test("applyGlobalEventToScene patches head metadata and lock", () => {
  const base = scene({ headVersion: 2, elementCount: 3, headAuthor: "admin" });
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const patched = applyGlobalEventToScene(
    base,
    versionEvent({
      headVersion: 4,
      elementCount: 12,
      author: "agent",
      createdAt: "2026-06-01T12:30:00.000Z",
      lock: { holder: "agent", expiresAt: "2026-06-01T13:00:00.000Z" },
    }),
    now,
  );
  assert.equal(patched.headVersion, 4);
  assert.equal(patched.elementCount, 12);
  assert.equal(patched.headAuthor, "agent");
  assert.equal(patched.updatedAt, "2026-06-01T12:30:00.000Z");
  assert.equal(patched.lock?.holder, "agent");

  const unlocked = applyGlobalEventToScene(
    patched,
    lockEvent({ lock: null, actor: "agent" }),
    now,
  );
  assert.equal(unlocked.lock, null);
  assert.equal(unlocked.headVersion, 4, "lock event must not clobber head");
});

test("applyGlobalEventsToList skips self and updates others", () => {
  const scenes = [
    scene({ id: "id-1", slug: "arch", headVersion: 1 }),
    scene({
      id: "id-2",
      slug: "flow",
      headVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  ];
  const { scenes: next, changed } = applyGlobalEventsToList(
    scenes,
    [
      versionEvent({
        slug: "arch",
        sceneId: "id-1",
        author: "me",
        headVersion: 9,
      }),
      versionEvent({
        seq: 3,
        slug: "flow",
        sceneId: "id-2",
        author: "agent",
        headVersion: 5,
        elementCount: 20,
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    ],
    "me",
  );
  assert.equal(changed, true);
  const arch = next.find((s) => s.slug === "arch")!;
  const flow = next.find((s) => s.slug === "flow")!;
  assert.equal(arch.headVersion, 1, "self-authored arch must stay");
  assert.equal(flow.headVersion, 5);
  assert.equal(flow.elementCount, 20);
});

test("lockExpiryDelayMs reports remaining TTL", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  assert.equal(lockExpiryDelayMs(null, now), null);
  assert.equal(
    lockExpiryDelayMs(
      { holder: "a", expiresAt: "2026-06-01T12:00:30.000Z" },
      now,
    ),
    30_000,
  );
  assert.equal(
    lockExpiryDelayMs(
      { holder: "a", expiresAt: "2026-06-01T11:00:00.000Z" },
      now,
    ),
    0,
  );
});
