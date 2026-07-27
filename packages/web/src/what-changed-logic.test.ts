import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiffElementChange, SceneDiffResponse } from "./api.ts";
import {
  buildRemoteSceneUpdate,
  buildWhatChangedModel,
  canReopenPanel,
  findScrollTarget,
  formatRemoteToastMessage,
  formatWhatChangedTitle,
  getLastSeenVersion,
  initialPollState,
  isChangeNavigable,
  isDiffItemNavigable,
  isPanelVisible,
  lastSeenStorageKey,
  markSceneSeen,
  panelAfterRemoteLoad,
  panelBeginLoad,
  panelDismiss,
  panelLoadSucceeded,
  panelReopen,
  pollAdvanceSince,
  pollBeginWait,
  pollNextDelayMs,
  pollOnError,
  pollOnEvent,
  pollOnTimeout,
  pollStop,
  POLL_BACKOFF_INITIAL_MS,
  POLL_BACKOFF_MAX_MS,
  REMOTE_CAPTURE_UPDATE,
  remoteUpdateSkipsUndoHistory,
  setLastSeenVersion,
  shouldShowWhatChangedOnOpen,
  toastApplyFailed,
  toastApplySucceeded,
  toastBeginApply,
  toastDismiss,
  toastFromSceneEvent,
  toastShow,
  type VersionStorage,
} from "./what-changed-logic.ts";

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------

function memoryStorage(): VersionStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function add(
  id: string,
  label: string | null = "Box",
): DiffElementChange {
  return {
    op: "add",
    id,
    type: "rectangle",
    label,
    bbox: { x: 0, y: 0, width: 100, height: 40 },
    describe: `+ rectangle "${label}"`,
  };
}

function del(id: string, label: string | null = "Gone"): DiffElementChange {
  return {
    op: "delete",
    id,
    type: "rectangle",
    label,
    describe: `- rectangle "${label}"`,
  };
}

function upd(id: string, label: string | null = "Moved"): DiffElementChange {
  return {
    op: "update",
    id,
    type: "rectangle",
    label,
    props: [{ key: "x", from: 0, to: 10 }],
    describe: `~ rectangle "${label}"  moved`,
  };
}

function sampleDiff(
  elements: DiffElementChange[],
): SceneDiffResponse {
  const summary = {
    added: elements.filter((e) => e.op === "add").length,
    deleted: elements.filter((e) => e.op === "delete").length,
    updated: elements.filter((e) => e.op === "update").length,
    reordered: elements.filter((e) => e.op === "reorder").length,
  };
  return { from: 1, to: 3, summary, elements, appState: [] };
}

// ---------------------------------------------------------------------------
// Last-seen
// ---------------------------------------------------------------------------

describe("last-seen version tracking", () => {
  test("key is namespaced per slug", () => {
    assert.equal(
      lastSeenStorageKey("arch"),
      "excalidraw-collab.lastSeen.arch",
    );
  });

  test("get returns null when unset", () => {
    const s = memoryStorage();
    assert.equal(getLastSeenVersion(s, "arch"), null);
  });

  test("round-trip set/get", () => {
    const s = memoryStorage();
    setLastSeenVersion(s, "arch", 7);
    assert.equal(getLastSeenVersion(s, "arch"), 7);
  });

  test("rejects non-integer / negative stored values", () => {
    const s = memoryStorage();
    s.setItem(lastSeenStorageKey("arch"), "nope");
    assert.equal(getLastSeenVersion(s, "arch"), null);
    s.setItem(lastSeenStorageKey("arch"), "-1");
    assert.equal(getLastSeenVersion(s, "arch"), null);
  });

  test("markSceneSeen never moves backwards", () => {
    const s = memoryStorage();
    markSceneSeen(s, "arch", 5);
    markSceneSeen(s, "arch", 3);
    assert.equal(getLastSeenVersion(s, "arch"), 5);
    markSceneSeen(s, "arch", 8);
    assert.equal(getLastSeenVersion(s, "arch"), 8);
  });

  test("shouldShowWhatChangedOnOpen: first visit → no panel", () => {
    assert.equal(shouldShowWhatChangedOnOpen(null, 5), false);
  });

  test("shouldShowWhatChangedOnOpen: head advanced → show", () => {
    assert.equal(shouldShowWhatChangedOnOpen(2, 5), true);
    assert.equal(shouldShowWhatChangedOnOpen(5, 5), false);
    assert.equal(shouldShowWhatChangedOnOpen(6, 5), false);
    assert.equal(shouldShowWhatChangedOnOpen(0, 0), false);
  });
});

// ---------------------------------------------------------------------------
// Navigability
// ---------------------------------------------------------------------------

describe("navigability rules", () => {
  test("adds, updates, reorders are navigable; deletes are not", () => {
    assert.equal(isChangeNavigable(add("a")), true);
    assert.equal(isChangeNavigable(upd("u")), true);
    assert.equal(
      isChangeNavigable({
        op: "reorder",
        id: "r",
        type: "rectangle",
        label: null,
        from: 0,
        to: 2,
      }),
      true,
    );
    assert.equal(isChangeNavigable(del("d")), false);
    assert.equal(isChangeNavigable({ op: "appState" }), false);
  });

  test("isDiffItemNavigable requires element kind", () => {
    assert.equal(
      isDiffItemNavigable({ kind: "element", change: add("a") }),
      true,
    );
    assert.equal(
      isDiffItemNavigable({ kind: "element", change: del("d") }),
      false,
    );
    assert.equal(isDiffItemNavigable({ kind: "appState" }), false);
  });

  test("findScrollTarget skips missing and tombstoned elements", () => {
    const els = [
      { id: "a", isDeleted: false },
      { id: "b", isDeleted: true },
    ];
    assert.equal(findScrollTarget(els, "a")?.id, "a");
    assert.equal(findScrollTarget(els, "b"), null);
    assert.equal(findScrollTarget(els, "missing"), null);
  });
});

// ---------------------------------------------------------------------------
// Review model grouping
// ---------------------------------------------------------------------------

describe("buildWhatChangedModel", () => {
  test("labels over ids; deletes marked non-navigable", () => {
    const model = buildWhatChangedModel(
      sampleDiff([add("id-1", "Auth Service"), del("id-2", "Legacy"), upd("id-3", "API")]),
      { from: 1, to: 3 },
    );
    assert.equal(model.range.from, 1);
    assert.equal(model.range.to, 3);
    assert.ok(model.summaryLabel.includes("+1"));
    assert.ok(model.summaryLabel.includes("−1") || model.summaryLabel.includes("-1"));

    const added = model.reviewItems.find((i) => i.change.id === "id-1");
    assert.ok(added);
    assert.equal(added!.navigable, true);
    assert.match(added!.headline, /Auth Service/);
    assert.doesNotMatch(added!.headline, /id-1/);

    const deleted = model.reviewItems.find((i) => i.change.id === "id-2");
    assert.ok(deleted);
    assert.equal(deleted!.navigable, false);
    assert.match(deleted!.headline, /Legacy/);

    // Structural / content first — added and deleted before style noise.
    const firstOps = model.reviewItems.slice(0, 2).map((i) => i.change.op);
    assert.ok(firstOps.includes("add"));
    assert.ok(firstOps.includes("delete"));
  });

  test("title formats version range", () => {
    assert.equal(
      formatWhatChangedTitle({ from: 4, to: 7 }),
      "What changed · v4 → v7",
    );
  });
});

// ---------------------------------------------------------------------------
// Toast state
// ---------------------------------------------------------------------------

describe("remote toast state", () => {
  test("toastFromSceneEvent uses headVersion when present", () => {
    const toast = toastFromSceneEvent(3, {
      version: 5,
      headVersion: 5,
      author: "agent",
      message: "retry queue",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(toast.fromVersion, 3);
    assert.equal(toast.toVersion, 5);
    assert.match(formatRemoteToastMessage(toast), /agent pushed v5/);
    assert.match(formatRemoteToastMessage(toast), /retry queue/);
  });

  test("show → apply → succeed / fail / dismiss", () => {
    const toast = toastFromSceneEvent(1, {
      version: 2,
      author: "bot",
      message: "hi",
      createdAt: "t",
    });
    let state = toastShow({ kind: "hidden" }, toast);
    assert.equal(state.kind, "visible");

    state = toastBeginApply(state, "load");
    assert.equal(state.kind, "applying");
    if (state.kind === "applying") assert.equal(state.action, "load");

    state = toastApplyFailed(state, "network down");
    assert.equal(state.kind, "error");

    state = toastBeginApply(state, "merge");
    assert.equal(state.kind, "applying");

    state = toastApplySucceeded(state);
    assert.equal(state.kind, "hidden");

    state = toastShow(state, toast);
    state = toastDismiss(state);
    assert.equal(state.kind, "hidden");
  });
});

// ---------------------------------------------------------------------------
// Poll / backoff
// ---------------------------------------------------------------------------

describe("poll/backoff state machine", () => {
  test("timeout resets failures and re-enters idle", () => {
    let s = initialPollState(2);
    s = pollBeginWait(s);
    assert.equal(s.phase, "waiting");
    s = pollOnTimeout(s);
    assert.equal(s.phase, "idle");
    assert.equal(s.since, 2);
    assert.equal(s.failures, 0);
    assert.equal(pollNextDelayMs(s), 0);
  });

  test("event advances since", () => {
    let s = initialPollState(2);
    s = pollBeginWait(s);
    s = pollOnEvent(s, 5);
    assert.equal(s.since, 5);
    assert.equal(s.phase, "idle");
    assert.equal(s.failures, 0);
  });

  test("errors back off exponentially up to cap", () => {
    let s = initialPollState(0);
    s = pollOnError(s);
    assert.equal(s.phase, "backoff");
    assert.equal(s.backoffMs, POLL_BACKOFF_INITIAL_MS);
    assert.equal(pollNextDelayMs(s), POLL_BACKOFF_INITIAL_MS);

    s = pollOnError(s);
    assert.equal(s.backoffMs, POLL_BACKOFF_INITIAL_MS * 2);

    for (let i = 0; i < 20; i++) s = pollOnError(s);
    assert.equal(s.backoffMs, POLL_BACKOFF_MAX_MS);
  });

  test("success after error resets backoff", () => {
    let s = initialPollState(1);
    s = pollOnError(s);
    s = pollOnError(s);
    s = pollOnEvent(s, 3);
    assert.equal(s.failures, 0);
    assert.equal(s.backoffMs, POLL_BACKOFF_INITIAL_MS);
  });

  test("pollAdvanceSince and stop", () => {
    let s = initialPollState(1);
    s = pollAdvanceSince(s, 4);
    assert.equal(s.since, 4);
    s = pollAdvanceSince(s, 2); // no go backwards
    assert.equal(s.since, 4);
    s = pollStop(s);
    assert.equal(s.phase, "stopped");
    s = pollOnEvent(s, 9);
    assert.equal(s.phase, "stopped");
    assert.equal(s.since, 4);
  });
});

// ---------------------------------------------------------------------------
// Remote update / undo stack
// ---------------------------------------------------------------------------

describe("remote scene update (undo stack)", () => {
  test("buildRemoteSceneUpdate sets captureUpdate NEVER", () => {
    const payload = buildRemoteSceneUpdate({
      elements: [{ id: "a", type: "rectangle" }],
      appState: { viewBackgroundColor: "#fff" },
    });
    assert.equal(payload.captureUpdate, REMOTE_CAPTURE_UPDATE);
    assert.equal(payload.captureUpdate, "NEVER");
    assert.equal(remoteUpdateSkipsUndoHistory(payload), true);
    assert.equal(payload.elements.length, 1);
    assert.equal(payload.appState?.viewBackgroundColor, "#fff");
  });

  test("tripwire: IMMEDIATELY would fail the undo contract", () => {
    assert.equal(
      remoteUpdateSkipsUndoHistory({ captureUpdate: "IMMEDIATELY" }),
      false,
    );
    assert.equal(remoteUpdateSkipsUndoHistory({}), false);
  });
});

// ---------------------------------------------------------------------------
// Panel dismiss / reopen (information preserved)
// ---------------------------------------------------------------------------

describe("panel dismiss without destroying review data", () => {
  test("dismiss keeps model; reopen restores visibility", () => {
    const model = buildWhatChangedModel(sampleDiff([add("a")]), {
      from: 1,
      to: 2,
    });
    let state = panelLoadSucceeded(model);
    assert.equal(isPanelVisible(state), true);
    assert.equal(canReopenPanel(state), false);

    state = panelDismiss(state);
    assert.equal(isPanelVisible(state), false);
    assert.equal(canReopenPanel(state), true);
    if (state.kind === "ready") {
      assert.equal(state.model.reviewItems.length, 1);
    }

    state = panelReopen(state);
    assert.equal(isPanelVisible(state), true);
  });

  test("empty remote load hides panel", () => {
    const empty = buildWhatChangedModel(sampleDiff([]), { from: 1, to: 1 });
    const state = panelAfterRemoteLoad(empty);
    assert.equal(state.kind, "hidden");
  });

  test("panelBeginLoad sets loading range", () => {
    const s = panelBeginLoad(2, 5);
    assert.equal(s.kind, "loading");
    if (s.kind === "loading") {
      assert.deepEqual(s.range, { from: 2, to: 5 });
    }
  });
});
