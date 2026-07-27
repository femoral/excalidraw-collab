import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  DiffElementChange,
  SceneDiffResponse,
  VersionInfo,
} from "./api.ts";
import {
  buildRestorePayload,
  classifyUpdatePriority,
  COLLAPSE_THRESHOLD,
  defaultRestoreMessage,
  elementHeadline,
  emptyDiffSummary,
  formatChangeCounts,
  isReadOnlyVersion,
  isVersionSelected,
  orderVersionsNewestFirst,
  parentRefForVersion,
  parseVersionQuery,
  prioritizeDiff,
  resolveDiffRange,
  restoreCreatesForwardCommit,
  selectionRole,
  toggleVersionSelection,
  totalChangeCount,
  TOP_CHANGES_CAP,
  versionEditorPath,
} from "./history-logic.ts";

function version(
  n: number,
  overrides: Partial<VersionInfo> = {},
): VersionInfo {
  return {
    version: n,
    parentVersion: n > 1 ? n - 1 : null,
    author: "alice",
    message: `msg ${n}`,
    createdAt: `2026-01-${String(n).padStart(2, "0")}T12:00:00.000Z`,
    elementCount: n * 10,
    sceneHash: `hash-${n}`,
    ...overrides,
  };
}

function add(
  id: string,
  label: string | null = null,
  type = "rectangle",
): DiffElementChange {
  return {
    op: "add",
    id,
    type,
    label,
    bbox: { x: 0, y: 0, width: 100, height: 40 },
    describe: `+ ${type}${label ? ` "${label}"` : ""}`,
  };
}

function del(
  id: string,
  label: string | null = null,
  type = "rectangle",
): DiffElementChange {
  return {
    op: "delete",
    id,
    type,
    label,
    describe: `- ${type}${label ? ` "${label}"` : ""}`,
  };
}

function upd(
  id: string,
  props: Array<{ key: string; from: unknown; to: unknown }>,
  label: string | null = null,
  type = "rectangle",
): DiffElementChange {
  return {
    op: "update",
    id,
    type,
    label,
    props,
    describe: `~ ${type}${label ? ` "${label}"` : ""}  changed`,
  };
}

function reorder(id: string, from: number, to: number): DiffElementChange {
  return {
    op: "reorder",
    id,
    type: "rectangle",
    label: null,
    from,
    to,
  };
}

// ---------------------------------------------------------------------------
// Timeline ordering
// ---------------------------------------------------------------------------

describe("orderVersionsNewestFirst", () => {
  test("sorts by version descending", () => {
    const ordered = orderVersionsNewestFirst([
      version(1),
      version(3),
      version(2),
    ]);
    assert.deepEqual(
      ordered.map((v) => v.version),
      [3, 2, 1],
    );
  });

  test("does not mutate input", () => {
    const input = [version(1), version(2)];
    orderVersionsNewestFirst(input);
    assert.equal(input[0]!.version, 1);
  });
});

describe("parentRefForVersion", () => {
  test("uses parentVersion when present", () => {
    assert.equal(parentRefForVersion(version(5)), 4);
  });

  test("first version parents to empty base (0)", () => {
    assert.equal(parentRefForVersion(version(1, { parentVersion: null })), 0);
  });
});

describe("formatChangeCounts", () => {
  test("formats non-zero buckets", () => {
    assert.equal(
      formatChangeCounts({ added: 3, deleted: 1, updated: 2, reordered: 4 }),
      "+3 −1 ~2 ↻4",
    );
  });

  test("empty summary", () => {
    assert.equal(formatChangeCounts(emptyDiffSummary()), "no changes");
  });

  test("totalChangeCount sums", () => {
    assert.equal(
      totalChangeCount({ added: 1, deleted: 2, updated: 3, reordered: 4 }),
      10,
    );
  });
});

// ---------------------------------------------------------------------------
// Version pair selection
// ---------------------------------------------------------------------------

describe("toggleVersionSelection", () => {
  test("selects first, then second", () => {
    let s = toggleVersionSelection([], 3);
    assert.deepEqual(s, [3]);
    s = toggleVersionSelection(s, 5);
    assert.deepEqual(s, [3, 5]);
  });

  test("deselects on re-click", () => {
    assert.deepEqual(toggleVersionSelection([3, 5], 3), [5]);
    assert.deepEqual(toggleVersionSelection([3], 3), []);
  });

  test("third click replaces oldest (FIFO)", () => {
    assert.deepEqual(toggleVersionSelection([3, 5], 7), [5, 7]);
  });
});

describe("resolveDiffRange", () => {
  test("null until two selected", () => {
    assert.equal(resolveDiffRange([]), null);
    assert.equal(resolveDiffRange([3]), null);
  });

  test("orders older → newer regardless of click order", () => {
    assert.deepEqual(resolveDiffRange([5, 3]), { from: 3, to: 5 });
    assert.deepEqual(resolveDiffRange([3, 5]), { from: 3, to: 5 });
  });

  test("selectionRole marks from/to", () => {
    const s = [5, 3];
    assert.equal(selectionRole(s, 3), "from");
    assert.equal(selectionRole(s, 5), "to");
    assert.equal(selectionRole(s, 9), null);
    assert.equal(selectionRole([4], 4), "only");
    assert.equal(isVersionSelected(s, 5), true);
  });
});

// ---------------------------------------------------------------------------
// Diff prioritisation
// ---------------------------------------------------------------------------

describe("classifyUpdatePriority", () => {
  test("text edit is content", () => {
    assert.equal(
      classifyUpdatePriority([{ key: "text", from: "a", to: "b" }]),
      "content",
    );
  });

  test("binding is content", () => {
    assert.equal(
      classifyUpdatePriority([
        { key: "startBinding", from: null, to: { elementId: "x" } },
      ]),
      "content",
    );
  });

  test("move is geometry", () => {
    assert.equal(
      classifyUpdatePriority([{ key: "x", from: 0, to: 10 }]),
      "geometry",
    );
  });

  test("fill is style", () => {
    assert.equal(
      classifyUpdatePriority([
        { key: "backgroundColor", from: "#fff", to: "#000" },
      ]),
      "style",
    );
  });

  test("content wins over simultaneous move", () => {
    assert.equal(
      classifyUpdatePriority([
        { key: "text", from: "a", to: "b" },
        { key: "x", from: 0, to: 5 },
      ]),
      "content",
    );
  });
});

describe("elementHeadline", () => {
  test("prefers label over id", () => {
    assert.equal(
      elementHeadline(add("abc123", "Auth Service")),
      "rectangle “Auth Service”",
    );
  });

  test("falls back to type when unlabelled", () => {
    assert.equal(elementHeadline(add("abc123", null, "ellipse")), "ellipse");
  });

  test("arrow edge labels keep arrow form", () => {
    assert.equal(
      elementHeadline({
        op: "add",
        id: "a1",
        type: "arrow",
        label: `"API" → "Cache"`,
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        describe: "",
      }),
      `arrow "API" → "Cache"`,
    );
  });
});

describe("prioritizeDiff", () => {
  test("empty diff", () => {
    const view = prioritizeDiff({
      from: 1,
      to: 1,
      summary: emptyDiffSummary(),
      elements: [],
      appState: [],
    });
    assert.equal(view.isEmpty, true);
    assert.equal(view.sections.length, 0);
    assert.equal(view.topChanges.length, 0);
  });

  test("groups ops into sections with structural first", () => {
    const diff: SceneDiffResponse = {
      from: 1,
      to: 2,
      summary: { added: 1, deleted: 1, updated: 2, reordered: 1 },
      elements: [
        reorder("r1", 0, 3),
        upd("u1", [{ key: "backgroundColor", from: "#fff", to: "#eee" }], "Box"),
        add("a1", "New Box"),
        del("d1", "Old Box"),
        upd("u2", [{ key: "text", from: "hi", to: "hello" }], null, "text"),
      ],
      appState: [{ key: "viewBackgroundColor", from: "#fff", to: "#f5f5f5" }],
    };
    const view = prioritizeDiff(diff);
    assert.equal(view.isEmpty, false);
    assert.deepEqual(
      view.sections.map((s) => s.key),
      ["added", "deleted", "content", "style", "reordered", "appState"],
    );
    // Top changes lead with structural/content.
    assert.ok(view.topChanges.length >= 3);
    assert.ok(
      view.topChanges.some(
        (i) => i.kind === "element" && i.change.op === "add",
      ),
    );
  });

  test("style-only section collapses when long", () => {
    const styleUpdates: DiffElementChange[] = [];
    for (let i = 0; i < COLLAPSE_THRESHOLD + 2; i++) {
      styleUpdates.push(
        upd(`s${i}`, [
          { key: "strokeColor", from: "#000", to: `#${i}${i}${i}` },
        ]),
      );
    }
    const view = prioritizeDiff({
      from: 1,
      to: 2,
      summary: {
        added: 0,
        deleted: 0,
        updated: styleUpdates.length,
        reordered: 0,
      },
      elements: styleUpdates,
      appState: [],
    });
    const style = view.sections.find((s) => s.key === "style");
    assert.ok(style);
    assert.equal(style!.defaultCollapsed, true);
    assert.equal(style!.items.length, styleUpdates.length);
  });

  test("adds stay expanded even when many", () => {
    const manyAdds = Array.from({ length: 30 }, (_, i) =>
      add(`a${i}`, `Shape ${i}`),
    );
    const view = prioritizeDiff({
      from: 0,
      to: 1,
      summary: { added: 30, deleted: 0, updated: 0, reordered: 0 },
      elements: manyAdds,
      appState: [],
    });
    const added = view.sections.find((s) => s.key === "added");
    assert.ok(added);
    assert.equal(added!.defaultCollapsed, false);
    assert.ok(added!.previewCount < manyAdds.length);
  });

  test("100-element-ish diff keeps top strip bounded", () => {
    const elements: DiffElementChange[] = [];
    // 10 adds, 5 deletes, 40 geometry, 40 style, 10 reorders ≈ 105
    for (let i = 0; i < 10; i++) elements.push(add(`a${i}`, `New ${i}`));
    for (let i = 0; i < 5; i++) elements.push(del(`d${i}`, `Old ${i}`));
    for (let i = 0; i < 40; i++) {
      elements.push(upd(`g${i}`, [{ key: "x", from: i, to: i + 1 }], `M${i}`));
    }
    for (let i = 0; i < 40; i++) {
      elements.push(
        upd(`s${i}`, [
          { key: "opacity", from: 100, to: 90 },
        ]),
      );
    }
    for (let i = 0; i < 10; i++) elements.push(reorder(`r${i}`, i, i + 1));

    const view = prioritizeDiff({
      from: 3,
      to: 4,
      summary: {
        added: 10,
        deleted: 5,
        updated: 80,
        reordered: 10,
      },
      elements,
      appState: [],
    });

    // Above-the-fold strip never grows with the long tail.
    assert.ok(view.topChanges.length <= TOP_CHANGES_CAP);
    // Top strip is only high-signal (adds/deletes/content/geometry).
    for (const item of view.topChanges) {
      if (item.kind === "element") {
        assert.ok(
          item.priority === "structural" ||
            item.priority === "content" ||
            item.priority === "geometry",
        );
      }
    }
    // Style + reorder are collapsible so they do not push interesting bits off-screen.
    const style = view.sections.find((s) => s.key === "style");
    const reordered = view.sections.find((s) => s.key === "reordered");
    assert.equal(style?.defaultCollapsed, true);
    assert.equal(reordered?.defaultCollapsed, true);
    // Headlines never lead with raw ids.
    for (const item of view.topChanges) {
      if (item.kind === "element") {
        assert.ok(!/^id:/.test(item.headline));
        assert.ok(item.headline.length > 0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe("buildRestorePayload", () => {
  test("forward commit against current head", () => {
    const payload = buildRestorePayload(
      {
        elements: [{ id: "e1", type: "rectangle" }],
        appState: {
          viewBackgroundColor: "#fff",
          // noise that must be stripped by pickAppState
          collaborators: new Map(),
          selectedElementIds: { e1: true },
        } as Record<string, unknown>,
        files: {
          f1: {
            id: "f1",
            mimeType: "image/png",
            dataURL: "data:image/png;base64,aaa",
          },
        },
      },
      7,
      3,
    );

    assert.equal(payload.parentVersion, 7);
    assert.equal(payload.message, defaultRestoreMessage(3));
    assert.equal(payload.elements.length, 1);
    assert.ok(payload.files);
    assert.equal(payload.files["f1"]?.id, "f1");
    // Whitelist only — collaborators must not ride along.
    assert.ok(payload.appState);
    assert.equal(payload.appState.viewBackgroundColor, "#fff");
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.appState, "collaborators"),
      false,
    );
    assert.equal(restoreCreatesForwardCommit(payload, 7, 3), true);
  });

  test("custom message override", () => {
    const payload = buildRestorePayload(
      { elements: [] },
      1,
      1,
      "Bring back the original layout",
    );
    assert.equal(payload.message, "Bring back the original layout");
  });
});

// ---------------------------------------------------------------------------
// Read-only / routing helpers
// ---------------------------------------------------------------------------

describe("parseVersionQuery + read-only", () => {
  test("parses ?v=N", () => {
    assert.equal(parseVersionQuery("?v=4"), 4);
    assert.equal(parseVersionQuery("v=4"), 4);
    assert.equal(parseVersionQuery("?v=head"), null);
    assert.equal(parseVersionQuery(""), null);
    assert.equal(parseVersionQuery("?v=0"), null);
    assert.equal(parseVersionQuery("?v=1.5"), null);
  });

  test("isReadOnlyVersion: past ≠ head", () => {
    assert.equal(isReadOnlyVersion(3, 5), true);
    assert.equal(isReadOnlyVersion(5, 5), false);
    assert.equal(isReadOnlyVersion(null, 5), false);
  });

  test("versionEditorPath", () => {
    assert.equal(versionEditorPath("arch", 3), "/s/arch?v=3");
    assert.equal(versionEditorPath("a/b", 1), "/s/a%2Fb?v=1");
  });
});
