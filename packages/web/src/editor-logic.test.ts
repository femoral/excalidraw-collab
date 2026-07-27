import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  arrayBufferToDataURL,
  buildCommitPayload,
  buildDraftPayload,
  coalescerBeginFlush,
  coalescerEndFlush,
  coalescerSchedule,
  collectFileIds,
  createDebouncedCoalescer,
  filesNeedingUpload,
  formatFileUploadError,
  formatLockBadge,
  formatRemoteUpdateToast,
  getEditorUnsavedFlag,
  hasUnsavedChanges,
  initialCoalescerState,
  isDraftNewerThanHead,
  isEditorLockActive,
  postCommitState,
  saveIndicatorLabel,
  selectInitialSource,
  setEditorUnsavedFlag,
  shouldShowLockControls,
  shouldShowRemoteUpdateToast,
  turnMenuLabel,
  turnMenuShouldClaim,
  validateCommitMessage,
  FILE_ID_REASON_HASH_MISMATCH,
  FILE_ID_REASON_NON_SECURE_NANOID,
  type EditorSnapshot,
} from "./editor-logic.ts";

// ---------------------------------------------------------------------------
// Draft vs head
// ---------------------------------------------------------------------------

describe("selectInitialSource", () => {
  test("no draft → head", () => {
    assert.deepEqual(
      selectInitialSource(null, {
        headVersion: 3,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      { source: "head" },
    );
  });

  test("draft based on current head → draft, not stale", () => {
    const result = selectInitialSource(
      {
        updatedAt: "2026-01-02T01:00:00.000Z",
        basedOnVersion: 3,
        headVersion: 3,
        stale: false,
      },
      { headVersion: 3, updatedAt: "2026-01-02T00:00:00.000Z" },
    );
    assert.deepEqual(result, { source: "draft", stale: false });
  });

  test("stale draft still preferred so unsaved work is not discarded", () => {
    const result = selectInitialSource(
      {
        updatedAt: "2026-01-01T12:00:00.000Z",
        basedOnVersion: 2,
        headVersion: 2,
        stale: true,
      },
      { headVersion: 4, updatedAt: "2026-01-02T00:00:00.000Z" },
    );
    assert.equal(result.source, "draft");
    if (result.source === "draft") {
      assert.equal(result.stale, true);
    }
  });

  test("isDraftNewerThanHead: based on current head", () => {
    assert.equal(
      isDraftNewerThanHead(
        {
          updatedAt: "2026-01-01T00:00:00.000Z",
          basedOnVersion: 5,
          headVersion: 5,
          stale: false,
        },
        { headVersion: 5, updatedAt: "2026-01-02T00:00:00.000Z" },
      ),
      true,
    );
  });

  test("isDraftNewerThanHead: clock-newer stale draft", () => {
    assert.equal(
      isDraftNewerThanHead(
        {
          updatedAt: "2026-01-03T00:00:00.000Z",
          basedOnVersion: 1,
          headVersion: 1,
          stale: true,
        },
        { headVersion: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Dirty-state rule
// ---------------------------------------------------------------------------

describe("hasUnsavedChanges", () => {
  test("only dirty/saving/error trip the guard", () => {
    assert.equal(hasUnsavedChanges("idle"), false);
    assert.equal(hasUnsavedChanges("saved"), false);
    assert.equal(hasUnsavedChanges("dirty"), true);
    assert.equal(hasUnsavedChanges("saving"), true);
    assert.equal(hasUnsavedChanges("error"), true);
  });

  test("labels are non-empty for active states", () => {
    assert.equal(saveIndicatorLabel("idle"), "");
    assert.match(saveIndicatorLabel("saving"), /saving/i);
    assert.match(saveIndicatorLabel("saved"), /saved/i);
    assert.match(saveIndicatorLabel("error"), /fail/i);
  });

  test("global unsaved flag mirrors editor writes", () => {
    setEditorUnsavedFlag(false);
    assert.equal(getEditorUnsavedFlag(), false);
    setEditorUnsavedFlag(true);
    assert.equal(getEditorUnsavedFlag(), true);
    setEditorUnsavedFlag(false);
  });
});

// ---------------------------------------------------------------------------
// Debounce / coalescing
// ---------------------------------------------------------------------------

describe("coalescer state machine", () => {
  test("burst of edits keeps only the latest pending", () => {
    let s = initialCoalescerState<number>();
    s = coalescerSchedule(s, 1);
    s = coalescerSchedule(s, 2);
    s = coalescerSchedule(s, 3);
    assert.equal(s.pending, 3);
    assert.equal(s.inflight, false);
  });

  test("beginFlush takes pending and marks inflight", () => {
    let s = coalescerSchedule(initialCoalescerState<string>(), "a");
    const began = coalescerBeginFlush(s);
    assert.equal(began.value, "a");
    assert.equal(began.state.inflight, true);
    assert.equal(began.state.pending, null);
  });

  test("edits during inflight set retrigger + pending; endFlush re-flushes", () => {
    let s = coalescerSchedule(initialCoalescerState<string>(), "a");
    const began = coalescerBeginFlush(s);
    s = began.state;
    s = coalescerSchedule(s, "b");
    s = coalescerSchedule(s, "c");
    assert.equal(s.pending, "c");
    assert.equal(s.retrigger, true);
    assert.equal(s.inflight, true);

    const ended = coalescerEndFlush(s, { ok: true });
    assert.equal(ended.shouldFlushAgain, true);
    assert.equal(ended.state.pending, "c");
    assert.equal(ended.state.inflight, false);
  });

  test("beginFlush is a no-op while inflight (no race)", () => {
    let s = coalescerSchedule(initialCoalescerState<number>(), 1);
    const first = coalescerBeginFlush(s);
    s = first.state;
    s = coalescerSchedule(s, 2);
    const second = coalescerBeginFlush(s);
    assert.equal(second.value, null);
    assert.equal(second.state.pending, 2);
  });

  test("createDebouncedCoalescer collapses a burst into one save", async () => {
    const saved: number[] = [];
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const coalescer = createDebouncedCoalescer<number>({
      delayMs: 50,
      save: async (v) => {
        saved.push(v);
      },
      setTimeoutFn: ((cb: () => void, ms: number) => {
        timers.push({ cb: cb as () => void, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    });

    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);
    // Only the last scheduled timer matters; fire it.
    assert.ok(timers.length >= 1);
    const last = timers[timers.length - 1]!;
    await Promise.resolve(last.cb());
    // allow microtasks from async save
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(saved, [3]);
    coalescer.dispose();
  });
});

// ---------------------------------------------------------------------------
// appState whitelist + payloads
// ---------------------------------------------------------------------------

describe("buildDraftPayload / buildCommitPayload", () => {
  const snapshot: EditorSnapshot = {
    elements: [{ id: "e1", type: "rectangle" }],
    appState: {
      viewBackgroundColor: "#fff",
      gridSize: 20,
      // noise that must never be persisted
      collaborators: new Map(),
      selectedElementIds: { e1: true },
      scrollX: 100,
      scrollY: 200,
      zoom: { value: 1.5 },
      openDialog: { name: "imageExport" },
    },
    files: {
      abc: {
        id: "abc",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aaa",
      },
    },
  };

  test("draft payload whitelists appState and lists file ids (no binaries)", () => {
    const body = buildDraftPayload(snapshot, 4);
    assert.equal(body.basedOnVersion, 4);
    assert.deepEqual(body.elements, snapshot.elements);
    assert.equal(body.appState.viewBackgroundColor, "#fff");
    assert.equal(body.appState.gridSize, 20);
    assert.equal("collaborators" in body.appState, false);
    assert.equal("selectedElementIds" in body.appState, false);
    assert.equal("scrollX" in body.appState, false);
    assert.equal("zoom" in body.appState, false);
    assert.deepEqual(body.fileIds, ["abc"]);
    assert.equal("files" in body, false);
  });

  test("commit payload whitelists appState and includes files for store", () => {
    const body = buildCommitPayload(snapshot, 4, "  reworked layout  ");
    assert.equal(body.parentVersion, 4);
    assert.equal(body.message, "reworked layout");
    assert.equal(body.appState.viewBackgroundColor, "#fff");
    assert.equal("collaborators" in body.appState, false);
    assert.equal("selectedElementIds" in body.appState, false);
    assert.ok(body.files.abc);
    assert.equal(body.files.abc!.dataURL.startsWith("data:"), true);
  });

  test("commit can strip files map when binaries already uploaded", () => {
    const body = buildCommitPayload(snapshot, 0, "init", {
      includeFiles: false,
    });
    assert.deepEqual(body.files, {});
  });
});

describe("file extraction / upload sequencing", () => {
  test("collectFileIds is sorted and unique", () => {
    assert.deepEqual(
      collectFileIds({
        b: { id: "b", mimeType: "image/png", dataURL: "data:," },
        a: { id: "a", mimeType: "image/png", dataURL: "data:," },
      }),
      ["a", "b"],
    );
  });

  test("filesNeedingUpload skips already-uploaded ids", () => {
    const files = {
      keep: {
        id: "keep",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,x",
      },
      done: {
        id: "done",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,y",
      },
    };
    const need = filesNeedingUpload(files, new Set(["done"]));
    assert.equal(need.length, 1);
    assert.equal(need[0]!.id, "keep");
  });

  test("filesNeedingUpload skips entries without dataURL", () => {
    const need = filesNeedingUpload(
      {
        ghost: { id: "ghost", mimeType: "image/png", dataURL: "" },
      },
      new Set(),
    );
    assert.equal(need.length, 0);
  });
});

// ---------------------------------------------------------------------------
// File upload errors
// ---------------------------------------------------------------------------

describe("formatFileUploadError", () => {
  test("surfaces non-secure-context nanoid clearly", () => {
    const msg = formatFileUploadError({
      message: "claimed fileId is not a content hash",
      details: { reason: FILE_ID_REASON_NON_SECURE_NANOID },
    });
    assert.match(msg, /secure context|HTTPS|localhost/i);
    assert.match(msg, /crypto\.subtle/i);
  });

  test("surfaces hash mismatch", () => {
    const msg = formatFileUploadError({
      message: "fileId does not match content hash",
      details: { reason: FILE_ID_REASON_HASH_MISMATCH },
    });
    assert.match(msg, /content hash/i);
  });

  test("falls back to server message", () => {
    assert.equal(
      formatFileUploadError({ message: "payload too large" }),
      "payload too large",
    );
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe("validateCommitMessage", () => {
  test("rejects empty", () => {
    assert.equal(validateCommitMessage("   ").ok, false);
  });
  test("accepts trimmed", () => {
    const r = validateCommitMessage("  hello  ");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.message, "hello");
  });
});

describe("arrayBufferToDataURL / postCommitState", () => {
  test("round-trips bytes to dataURL payload", () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const payload = arrayBufferToDataURL(bytes, "image/png", "abc");
    assert.equal(payload.id, "abc");
    assert.equal(payload.mimeType, "image/png");
    assert.match(payload.dataURL, /^data:image\/png;base64,/);
  });

  test("postCommit clears dirty indicator", () => {
    const s = postCommitState(7);
    assert.equal(s.headVersion, 7);
    assert.equal(s.saveIndicator, "idle");
    assert.equal(hasUnsavedChanges(s.saveIndicator), false);
  });
});

// ---------------------------------------------------------------------------
// Advisory turn lock display
// ---------------------------------------------------------------------------

describe("isEditorLockActive / formatLockBadge / turnMenu", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");

  test("null and expired locks are inactive", () => {
    assert.equal(isEditorLockActive(null, now), false);
    assert.equal(
      isEditorLockActive(
        { holder: "bot", expiresAt: "2026-06-01T11:00:00.000Z" },
        now,
      ),
      false,
    );
    assert.equal(
      isEditorLockActive(
        { holder: "bot", expiresAt: "2026-06-01T13:00:00.000Z" },
        now,
      ),
      true,
    );
  });

  test("badge copy", () => {
    assert.equal(
      formatLockBadge({ holder: "claude-code", expiresAt: "x" }),
      "🤖 claude-code holds the turn",
    );
  });

  test("menu claim vs release", () => {
    assert.equal(turnMenuShouldClaim(null, now), true);
    assert.equal(turnMenuLabel(null, "admin", now), "Claim turn");
    assert.equal(
      turnMenuLabel(
        { holder: "admin", expiresAt: "2026-06-01T13:00:00.000Z" },
        "admin",
        now,
      ),
      "Release turn",
    );
    // Someone else holds it — recovery action is still Release.
    assert.equal(
      turnMenuLabel(
        { holder: "claude-code", expiresAt: "2026-06-01T13:00:00.000Z" },
        "admin",
        now,
      ),
      "Release turn",
    );
    assert.equal(
      turnMenuShouldClaim(
        { holder: "claude-code", expiresAt: "2026-06-01T13:00:00.000Z" },
        now,
      ),
      false,
    );
  });

  test("read-only past-version view hides lock controls (does not claim a turn)", () => {
    // Hide (not disable): viewing history is not editing, so claim/release
    // must not appear at all.
    assert.equal(shouldShowLockControls(true), false);
    assert.equal(shouldShowLockControls(false), true);
  });
});

describe("remote update toast", () => {
  test("formatRemoteUpdateToast includes author version and message", () => {
    assert.equal(
      formatRemoteUpdateToast({
        version: 12,
        author: "agent",
        message: "added queue",
      }),
      'agent pushed v12: “added queue”',
    );
  });

  test("shouldShowRemoteUpdateToast ignores self and stale heads", () => {
    assert.equal(
      shouldShowRemoteUpdateToast(
        { headVersion: 5, author: "agent" },
        { localHead: 5, selfName: "admin" },
      ),
      false,
    );
    assert.equal(
      shouldShowRemoteUpdateToast(
        { headVersion: 6, author: "admin" },
        { localHead: 5, selfName: "admin" },
      ),
      false,
    );
    assert.equal(
      shouldShowRemoteUpdateToast(
        { headVersion: 6, author: "agent" },
        { localHead: 5, selfName: "admin" },
      ),
      true,
    );
  });
});
