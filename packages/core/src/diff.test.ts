/**
 * Diff engine tests.
 *
 * Acceptance criteria (issue #12):
 *  - Every before/after pair fixture produces the expected classified change set
 *  - diffScenes(x, x) is empty for all corpus scenes
 *  - normalizeScene round-trip diffs empty against original
 *  - formatDiff is deterministic (byte-identical)
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  APP_STATE_DEFAULTS,
  diffScenes,
  formatDiff,
  isEmptyDiff,
  normalizeScene,
} from "./index.js";
import type {
  ElementChange,
  ExcalidrawElement,
  SceneDocument,
  SceneDiff,
} from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");
const PAIRS_DIR = join(FIXTURES_DIR, "pairs");

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

function loadFixture(path: string): SceneDocument {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    elements: ExcalidrawElement[];
    appState?: SceneDocument["appState"];
    files?: SceneDocument["files"];
  };
  return {
    elements: raw.elements,
    appState: raw.appState ?? {},
    files: raw.files ?? {},
  };
}

function listCorpusFixtures(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(FIXTURES_DIR)) {
    const full = join(FIXTURES_DIR, name);
    if (statSync(full).isDirectory()) continue;
    if (name.endsWith(".excalidraw")) out.push(full);
  }
  return out.sort();
}

function loadPair(name: string): { before: SceneDocument; after: SceneDocument } {
  return {
    before: loadFixture(join(PAIRS_DIR, `${name}.before.excalidraw`)),
    after: loadFixture(join(PAIRS_DIR, `${name}.after.excalidraw`)),
  };
}

function updates(diff: SceneDiff): Extract<ElementChange, { op: "update" }>[] {
  return diff.elements.filter(
    (c): c is Extract<ElementChange, { op: "update" }> => c.op === "update",
  );
}

function deletes(diff: SceneDiff): Extract<ElementChange, { op: "delete" }>[] {
  return diff.elements.filter(
    (c): c is Extract<ElementChange, { op: "delete" }> => c.op === "delete",
  );
}

function reorders(
  diff: SceneDiff,
): Extract<ElementChange, { op: "reorder" }>[] {
  return diff.elements.filter(
    (c): c is Extract<ElementChange, { op: "reorder" }> => c.op === "reorder",
  );
}

function propKeys(change: Extract<ElementChange, { op: "update" }>): string[] {
  return change.props.map((p) => p.key);
}

// ---------------------------------------------------------------------------
// Idle / no-edit acceptance (the test that matters most)
// ---------------------------------------------------------------------------

describe("diffScenes idle / no-edit", () => {
  const corpus = listCorpusFixtures();

  test("corpus has the 6 expected scenes", () => {
    const names = corpus.map((p) => relative(FIXTURES_DIR, p));
    for (const expected of [
      "empty.excalidraw",
      "simple-shapes.excalidraw",
      "bound-text.excalidraw",
      "arrows-bound.excalidraw",
      "frames.excalidraw",
      "with-image.excalidraw",
    ]) {
      assert.ok(names.includes(expected), `missing corpus fixture ${expected}`);
    }
  });

  for (const path of corpus) {
    const label = relative(FIXTURES_DIR, path);

    test(`diffScenes(x, x) is empty for ${label}`, () => {
      const doc = loadFixture(path);
      const diff = diffScenes(doc, doc);
      assert.ok(
        isEmptyDiff(diff),
        `${label}: self-diff not empty:\n${formatDiff(diff)}`,
      );
      assert.equal(diff.elements.length, 0);
      assert.equal(diff.appState.length, 0);
      assert.deepEqual(diff.summary, {
        added: 0,
        deleted: 0,
        updated: 0,
        reordered: 0,
      });
    });

    test(`normalizeScene round-trip diffs empty for ${label}`, () => {
      const original = loadFixture(path);
      const normalized = normalizeScene(original);
      const diff = diffScenes(original, normalized);
      assert.ok(
        isEmptyDiff(diff),
        `${label}: original vs normalizeScene not empty:\n${formatDiff(diff)}`,
      );
    });
  }

  test("churn-only element fields (version/versionNonce/updated/seed) produce empty diff", () => {
    const base = loadFixture(join(FIXTURES_DIR, "simple-shapes.excalidraw"));
    const noisier: SceneDocument = {
      ...base,
      elements: base.elements.map((el) => ({
        ...el,
        version: el.version + 99,
        versionNonce: el.versionNonce ^ 0xdeadbeef,
        updated: el.updated + 1_000_000,
        seed: el.seed + 1,
      })),
    };
    const diff = diffScenes(base, noisier);
    assert.ok(
      isEmptyDiff(diff),
      `churn props leaked into diff:\n${formatDiff(diff)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Pair fixtures — classified verbs + resolved labels
// ---------------------------------------------------------------------------

describe("diffScenes pair fixtures", () => {
  test("pairs/move: box-a moved with label Service A", () => {
    const { before, after } = loadPair("move");
    const diff = diffScenes(before, after, { from: 1, to: 2 });

    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
    assert.ok(diff.summary.updated >= 1);

    const boxA = updates(diff).find((c) => c.id === "box-a");
    assert.ok(boxA, "expected update for box-a");
    assert.equal(boxA.type, "rectangle");
    assert.equal(boxA.label, "Service A");
    assert.ok(propKeys(boxA).includes("x") || propKeys(boxA).includes("y"));
    assert.match(boxA.describe, /moved/);
    assert.match(boxA.describe, /Service A/);

    // Bound text for Service A also moves with the container.
    const boundText = updates(diff).find(
      (c) => c.type === "text" && c.label === "Service A",
    );
    assert.ok(boundText, "expected bound text of Service A to move");
    assert.match(boundText.describe, /moved/);

    // No deletes / adds / reorders for a pure move of one node.
    assert.equal(diff.summary.deleted, 0);
    assert.equal(diff.summary.added, 0);
  });

  test("pairs/resize: box-b resized with label Service B", () => {
    const { before, after } = loadPair("resize");
    const diff = diffScenes(before, after);

    const boxB = updates(diff).find((c) => c.id === "box-b");
    assert.ok(boxB, "expected update for box-b");
    assert.equal(boxB.label, "Service B");
    assert.ok(propKeys(boxB).includes("width") || propKeys(boxB).includes("height"));
    assert.match(boxB.describe, /resized/);
    assert.match(boxB.describe, /Service B/);

    // Position of box-b should not change (no "moved" for the box itself).
    assert.ok(!propKeys(boxB).includes("x"));
    assert.ok(!propKeys(boxB).includes("y"));
    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
  });

  test("pairs/restyle: box-a restyled with label Service A", () => {
    const { before, after } = loadPair("restyle");
    const diff = diffScenes(before, after);

    const boxA = updates(diff).find((c) => c.id === "box-a");
    assert.ok(boxA, "expected update for box-a");
    assert.equal(boxA.label, "Service A");
    assert.ok(propKeys(boxA).includes("backgroundColor"));
    assert.ok(propKeys(boxA).includes("strokeColor"));
    assert.match(boxA.describe, /restyled/);
    assert.match(boxA.describe, /#ff8787|#c92a2a/);

    // Pure restyle: only box-a should update (no move/resize of others).
    assert.equal(diff.summary.updated, 1);
    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
    assert.equal(diff.summary.reordered, 0);
  });

  test("pairs/text-edit: free text and bound label edited", () => {
    const { before, after } = loadPair("text-edit");
    const diff = diffScenes(before, after);

    const note = updates(diff).find((c) => c.id === "note-1");
    assert.ok(note, "expected update for note-1");
    assert.equal(note.type, "text");
    assert.equal(note.label, "Edited note");
    assert.ok(propKeys(note).includes("text"));
    assert.match(note.describe, /text edited/);
    assert.match(note.describe, /Draft note/);
    assert.match(note.describe, /Edited note/);

    const renamed = updates(diff).find(
      (c) => c.type === "text" && c.label === "Service C (renamed)",
    );
    assert.ok(renamed, "expected bound text of box-c to be renamed");
    assert.match(renamed.describe, /text edited/);
    assert.match(renamed.describe, /Service C \(renamed\)/);

    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
  });

  test('pairs/rebind: arrow rebound "Service A" → "Service C" (was B)', () => {
    const { before, after } = loadPair("rebind");
    const diff = diffScenes(before, after);

    const arrow = updates(diff).find((c) => c.id === "link-ab");
    assert.ok(arrow, "expected update for link-ab");
    assert.equal(arrow.type, "arrow");
    assert.ok(propKeys(arrow).includes("endBinding"));
    assert.match(arrow.describe, /rebound/);
    // Edge label on the after side.
    assert.ok(
      arrow.label != null && arrow.label.includes("Service A") && arrow.label.includes("Service C"),
      `arrow label should be Service A → Service C, got ${arrow.label}`,
    );
    // "was" clause mentions Service B.
    assert.match(arrow.describe, /Service B/);
    assert.match(arrow.describe, /Service C/);

    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
  });

  test("pairs/delete: box-c and its bound text deleted with labels", () => {
    const { before, after } = loadPair("delete");
    const diff = diffScenes(before, after);

    assert.ok(diff.summary.deleted >= 2, `expected ≥2 deletes, got ${diff.summary.deleted}`);
    assert.equal(diff.summary.added, 0);

    const boxC = deletes(diff).find((c) => c.id === "box-c");
    assert.ok(boxC, "expected delete for box-c");
    assert.equal(boxC.type, "rectangle");
    assert.equal(boxC.label, "Service C");
    assert.match(boxC.describe, /Service C/);

    const boundText = deletes(diff).find(
      (c) => c.type === "text" && c.label === "Service C",
    );
    assert.ok(boundText, "expected delete for bound text of Service C");

    // Shared relative order preserved → no reorders from hard-delete index shifts.
    assert.equal(
      diff.summary.reordered,
      0,
      `delete should not invent reorders:\n${formatDiff(diff)}`,
    );
  });

  test("pairs/reorder: only reorder ops, no property updates", () => {
    const { before, after } = loadPair("reorder");
    const diff = diffScenes(before, after);

    assert.equal(
      diff.summary.updated,
      0,
      `reorder leaked updates:\n${formatDiff(diff)}`,
    );
    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
    assert.ok(
      diff.summary.reordered > 0,
      `expected reorders, got none:\n${formatDiff(diff)}`,
    );

    const rs = reorders(diff);
    // Every reordered element has from !== to.
    for (const r of rs) {
      assert.notEqual(r.from, r.to, `${r.id}: from === to`);
      assert.equal(typeof r.type, "string");
    }

    // Labels resolve for the known boxes.
    const boxA = rs.find((c) => c.id === "box-a");
    assert.ok(boxA, "box-a should be reordered");
    assert.equal(boxA.label, "Service A");
  });

  test("pairs/group: box-a and box-b grouped with labels", () => {
    const { before, after } = loadPair("group");
    const diff = diffScenes(before, after);

    const boxA = updates(diff).find((c) => c.id === "box-a");
    const boxB = updates(diff).find((c) => c.id === "box-b");
    assert.ok(boxA, "expected update for box-a");
    assert.ok(boxB, "expected update for box-b");
    assert.equal(boxA.label, "Service A");
    assert.equal(boxB.label, "Service B");
    assert.ok(propKeys(boxA).includes("groupIds"));
    assert.ok(propKeys(boxB).includes("groupIds"));
    assert.match(boxA.describe, /grouped/);
    assert.match(boxB.describe, /grouped/);

    // Bound texts of A/B also join the group.
    const groupedTexts = updates(diff).filter(
      (c) =>
        c.type === "text" &&
        (c.label === "Service A" || c.label === "Service B") &&
        propKeys(c).includes("groupIds"),
    );
    assert.ok(groupedTexts.length >= 2, "bound texts should also be grouped");

    assert.equal(diff.summary.added, 0);
    assert.equal(diff.summary.deleted, 0);
  });
});

// ---------------------------------------------------------------------------
// Soft-delete (isDeleted) path — fixtures use hard-delete; unit-test the other
// ---------------------------------------------------------------------------

describe("diffScenes soft-delete (isDeleted)", () => {
  test("isDeleted flipped true is reported as delete", () => {
    // Clone a real fixture element — never author element internals by hand.
    const corpus = loadFixture(join(FIXTURES_DIR, "simple-shapes.excalidraw"));
    const live = corpus.elements.find((el) => el.type === "rectangle" && !el.isDeleted);
    assert.ok(live, "simple-shapes should contain a rectangle");

    const before: SceneDocument = {
      elements: [live],
      appState: {},
      files: {},
    };
    const after: SceneDocument = {
      elements: [{ ...live, isDeleted: true }],
      appState: {},
      files: {},
    };

    const diff = diffScenes(before, after);
    assert.equal(diff.summary.deleted, 1);
    assert.equal(diff.summary.updated, 0);
    assert.equal(deletes(diff)[0]!.id, live.id);
  });
});

// ---------------------------------------------------------------------------
// appState whitelist
// ---------------------------------------------------------------------------

describe("diffScenes appState", () => {
  test("only whitelisted appState keys appear", () => {
    const a: SceneDocument = {
      elements: [],
      appState: {
        viewBackgroundColor: "#ffffff",
        gridSize: 10,
      },
      files: {},
    };
    const b: SceneDocument = {
      elements: [],
      appState: {
        viewBackgroundColor: "#000000",
        gridSize: 20,
      },
      files: {},
    };

    // Non-persistable noise must never leak into the diff (runtime-only keys).
    (b.appState as Record<string, unknown>).collaborators = { noisy: true };
    (b.appState as Record<string, unknown>).selectedElementIds = { x: true };

    const diff = diffScenes(a, b);
    assert.equal(diff.elements.length, 0);
    const keys = diff.appState.map((p) => p.key).sort();
    assert.deepEqual(keys, ["gridSize", "viewBackgroundColor"]);
    assert.ok(!keys.includes("collaborators"));
    assert.ok(!keys.includes("selectedElementIds"));
  });
});

// ---------------------------------------------------------------------------
// formatDiff — deterministic renderer
// ---------------------------------------------------------------------------

describe("formatDiff", () => {
  const fixedElements: SceneDiff["elements"] = [
    {
      op: "add",
      id: "rq",
      type: "rectangle",
      label: "Retry Queue",
      bbox: { x: 640, y: 220, width: 180, height: 80 },
      describe: '+ rectangle "Retry Queue"  (640,220 180x80)',
    },
    {
      op: "add",
      id: "ar",
      type: "arrow",
      label: '"Worker" → "Retry Queue"',
      bbox: { x: 0, y: 0, width: 100, height: 0 },
      describe: '+ arrow "Worker" → "Retry Queue"  (0,0 100x0)',
    },
    {
      op: "update",
      id: "auth",
      type: "rectangle",
      label: "Auth Service",
      props: [
        { key: "y", from: 120, to: 200 },
        { key: "backgroundColor", from: "#fff", to: "#e9ecef" },
      ],
      describe:
        '~ rectangle "Auth Service"  moved (320,120) → (320,200); restyled fill #e9ecef',
    },
    {
      op: "update",
      id: "a1",
      type: "arrow",
      label: '"API" → "Cache"',
      props: [
        {
          key: "endBinding",
          from: { elementId: "db" },
          to: { elementId: "cache" },
        },
      ],
      describe: '~ arrow "API" → "Cache"  rebound: was "API" → "DB"',
    },
    {
      op: "delete",
      id: "legacy",
      type: "ellipse",
      label: "Legacy cache",
      describe: '- ellipse "Legacy cache"',
    },
  ];

  test("byte-identical with versions supplied", () => {
    const fixed: SceneDiff = {
      from: 7,
      to: 9,
      summary: { added: 2, deleted: 1, updated: 2, reordered: 0 },
      elements: fixedElements,
      appState: [],
    };

    const once = formatDiff(fixed);
    const twice = formatDiff(fixed);
    assert.equal(once, twice, "formatDiff must be deterministic");

    const expected = [
      "v7 → v9   +2 -1 ~2",
      '+ rectangle "Retry Queue"  (640,220 180x80)',
      '+ arrow "Worker" → "Retry Queue"  (0,0 100x0)',
      '~ rectangle "Auth Service"  moved (320,120) → (320,200); restyled fill #e9ecef',
      '~ arrow "API" → "Cache"  rebound: was "API" → "DB"',
      '- ellipse "Legacy cache"',
      "",
    ].join("\n");
    assert.equal(once, expected);
  });

  test("byte-identical without versions — no invented v0", () => {
    const fixed: SceneDiff = {
      summary: { added: 2, deleted: 1, updated: 2, reordered: 0 },
      elements: fixedElements,
      appState: [],
    };

    const once = formatDiff(fixed);
    const twice = formatDiff(fixed);
    assert.equal(once, twice, "formatDiff must be deterministic");

    // Counts only — no `vN → vM` prefix when versions are absent.
    const expected = [
      "+2 -1 ~2",
      '+ rectangle "Retry Queue"  (640,220 180x80)',
      '+ arrow "Worker" → "Retry Queue"  (0,0 100x0)',
      '~ rectangle "Auth Service"  moved (320,120) → (320,200); restyled fill #e9ecef',
      '~ arrow "API" → "Cache"  rebound: was "API" → "DB"',
      '- ellipse "Legacy cache"',
      "",
    ].join("\n");
    assert.equal(once, expected);
    assert.ok(!once.includes("v0"), "must not invent version 0");
    assert.ok(!once.startsWith("v"), "must not emit a version header");
  });

  test("empty diff without versions renders a stable empty header", () => {
    const empty: SceneDiff = {
      summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
      elements: [],
      appState: [],
    };
    assert.equal(formatDiff(empty), "(empty)\n");
  });

  test("empty diff with versions still shows the version transition", () => {
    const empty: SceneDiff = {
      from: 3,
      to: 3,
      summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
      elements: [],
      appState: [],
    };
    assert.equal(formatDiff(empty), "v3 → v3   (empty)\n");
  });

  test("partial versions omit the version header entirely", () => {
    const onlyFrom: SceneDiff = {
      from: 2,
      summary: { added: 1, deleted: 0, updated: 0, reordered: 0 },
      elements: [],
      appState: [],
    };
    assert.equal(formatDiff(onlyFrom), "+1\n");
    assert.ok(!formatDiff(onlyFrom).includes("v2"));
  });

  test("diffScenes without options leaves from/to undefined", () => {
    const { before, after } = loadPair("restyle");
    const diff = diffScenes(before, after);
    assert.equal(diff.from, undefined);
    assert.equal(diff.to, undefined);
    const text = formatDiff(diff);
    assert.ok(!text.includes("v0"));
    assert.match(text, /^~/); // counts first, no version prefix
  });

  test("formatDiff of a real pair is stable across calls", () => {
    const { before, after } = loadPair("restyle");
    const diff = diffScenes(before, after, { from: 3, to: 4 });
    const a = formatDiff(diff);
    const b = formatDiff(diff);
    assert.equal(a, b);
    assert.match(a, /restyled/);
    assert.match(a, /Service A/);
    assert.match(a, /^v3 → v4/);
  });

  test("formatDiff of reorder uses ↕ lines from structured fields", () => {
    const { before, after } = loadPair("reorder");
    const diff = diffScenes(before, after);
    const text = formatDiff(diff);
    assert.match(text, /↕/);
    assert.ok(!text.includes("undefined"));
    assert.ok(!text.includes("v0"));
  });

  test("formatDiff renders absent appState keys as (unset), not undefined", () => {
    const text = formatDiff({
      from: 1,
      to: 2,
      summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
      elements: [],
      appState: [
        { key: "gridModeEnabled", from: false, to: undefined },
        { key: "gridSize", from: null, to: undefined },
        { key: "viewBackgroundColor", from: undefined, to: "#000" },
      ],
    });
    assert.match(text, /gridModeEnabled: false → \(unset\)/);
    assert.match(text, /gridSize: null → \(unset\)/);
    assert.match(text, /viewBackgroundColor: \(unset\) → "#000"/);
    assert.ok(!text.includes("undefined"));
  });
});

// ---------------------------------------------------------------------------
// formatDiff example (printed for the report — also asserts readability)
// ---------------------------------------------------------------------------

describe("formatDiff example rendering (for human judgment)", () => {
  test("restyle pair produces a readable one-liner change set", () => {
    const { before, after } = loadPair("restyle");
    const text = formatDiff(diffScenes(before, after, { from: 1, to: 2 }));
    // Keep the assertion tight so the example stays intentional.
    assert.match(text, /^v1 → v2   ~1\n/);
    assert.match(text, /~ rectangle "Service A"/);
    assert.match(text, /restyled/);
    // Expose for operators reading the test output:
    // eslint-disable-next-line no-console
    console.log("\n--- formatDiff(restyle) example ---\n" + text + "--- end ---\n");
  });

  test("rebind pair shows edge was/now form", () => {
    const { before, after } = loadPair("rebind");
    const text = formatDiff(diffScenes(before, after, { from: 5, to: 6 }));
    assert.match(text, /rebound/);
    assert.match(text, /Service A/);
    assert.match(text, /Service C/);
    // eslint-disable-next-line no-console
    console.log("\n--- formatDiff(rebind) example ---\n" + text + "--- end ---\n");
  });
});

// ---------------------------------------------------------------------------
// appState default noise
//
// The CLI omits persisted appState keys it was never given; the web editor
// always writes the full set. Without this suppression the first UI commit
// after any CLI push reports eleven appState "changes" nobody made, which
// buries the real element diff an agent is trying to read.
// ---------------------------------------------------------------------------

describe("diffScenes appState defaults", () => {
  const withAppState = (appState: Record<string, unknown>): SceneDocument => ({
    elements: [],
    appState,
    files: {},
  });

  test("absent → upstream default is not a change", () => {
    const diff = diffScenes(
      withAppState({}),
      withAppState({ ...APP_STATE_DEFAULTS }),
    );
    assert.deepEqual(diff.appState, []);
    assert.ok(isEmptyDiff(diff));
  });

  test("suppression is symmetric (default → absent)", () => {
    const diff = diffScenes(
      withAppState({ ...APP_STATE_DEFAULTS }),
      withAppState({}),
    );
    assert.deepEqual(diff.appState, []);
  });

  test("absent → non-default is still reported", () => {
    const diff = diffScenes(
      withAppState({}),
      withAppState({ viewBackgroundColor: "#000000", gridSize: 40 }),
    );
    assert.deepEqual(
      diff.appState.map((d) => d.key).sort(),
      ["gridSize", "viewBackgroundColor"],
    );
  });

  test("scene name is never suppressed (upstream default is null)", () => {
    // Regression: `name` must not join APP_STATE_DEFAULTS — a rename is real.
    assert.ok(!Object.prototype.hasOwnProperty.call(APP_STATE_DEFAULTS, "name"));
    const diff = diffScenes(
      withAppState({}),
      withAppState({ name: "Ingest Pipeline" }),
    );
    assert.deepEqual(diff.appState, [
      { key: "name", from: undefined, to: "Ingest Pipeline" },
    ]);
  });

  test("an explicit change away from a default is still reported", () => {
    const diff = diffScenes(
      withAppState({ theme: "light" }),
      withAppState({ theme: "dark" }),
    );
    assert.deepEqual(diff.appState, [
      { key: "theme", from: "light", to: "dark" },
    ]);
  });

  test("table agrees with upstream restoreAppState", async () => {
    // Same approach as the sceneHash agreement test: load the real browser
    // bundle through the fixture-generation shim rather than trusting a
    // hand-copied table to stay correct across upgrades.
    const { spawnSync } = await import("node:child_process");
    const register = join(HERE, "..", "scripts", "register.mjs");
    const script = `
      import { restoreAppState } from "@excalidraw/excalidraw";
      const keys = ${JSON.stringify(Object.keys(APP_STATE_DEFAULTS))};
      const restored = restoreAppState({}, null);
      const out = {};
      for (const k of keys) out[k] = restored[k];
      process.stdout.write(JSON.stringify(out));
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", register, "--input-type=module", "-e", script],
      { encoding: "utf8", cwd: join(HERE, ".."), maxBuffer: 10 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      assert.fail(
        `could not load upstream restoreAppState for agreement check:\n` +
          `status=${result.status}\nstderr=${result.stderr}`,
      );
    }
    assert.deepEqual(JSON.parse(result.stdout), { ...APP_STATE_DEFAULTS });
  });
});
