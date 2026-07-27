import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  normalizeScene,
  pickAppState,
  SceneValidationError,
  PERSISTED_APP_STATE_KEYS,
  splitFiles,
  mergeFiles,
  sceneHash,
} from "./index.js";
import type { SceneDocument, ExcalidrawElement } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");

function listExcalidrawFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listExcalidrawFiles(full));
    } else if (name.endsWith(".excalidraw")) {
      out.push(full);
    }
  }
  return out.sort();
}

function loadRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

// ---------------------------------------------------------------------------
// pickAppState
// ---------------------------------------------------------------------------

describe("pickAppState", () => {
  test("keeps only the persistable allowlist keys", () => {
    const fullEditorAppState = {
      // persistable
      viewBackgroundColor: "#f8f9fa",
      gridSize: 20,
      gridModeEnabled: true,
      gridStep: 5,
      exportBackground: true,
      exportWithDarkMode: false,
      exportScale: 2,
      exportEmbedScene: true,
      frameRendering: {
        enabled: true,
        name: true,
        outline: true,
        clip: true,
      },
      theme: "dark",
      name: "Architecture",
      // per-viewer noise — must never be stored
      collaborators: new Map([["u1", { username: "alice" }]]),
      selectedElementIds: { "rect-1": true, "arrow-2": true },
      previousSelectedElementIds: { "rect-1": true },
      scrollX: 120.5,
      scrollY: -40,
      zoom: { value: 1.25 },
      cursorButton: "up",
      openDialog: { name: "imageExport" },
      openMenu: "canvas",
      openSidebar: { name: "default" },
      openPopup: "canvasBackground",
      editingTextElement: { id: "t1" },
      activeTool: { type: "selection", locked: false },
      penMode: false,
      width: 1920,
      height: 1080,
      offsetTop: 0,
      offsetLeft: 0,
      isLoading: false,
      errorMessage: null,
      toast: null,
      showWelcomeScreen: false,
      currentItemStrokeColor: "#1e1e1e",
      currentItemBackgroundColor: "#a5d8ff",
      selectedGroupIds: {},
      editingGroupId: null,
      multiElement: null,
      newElement: null,
      resizingElement: null,
      selectedLinearElement: null,
      contextMenu: null,
      showStats: false,
    };

    const picked = pickAppState(fullEditorAppState);

    // Exactly the allowlist keys that were present
    const expectedKeys = new Set(PERSISTED_APP_STATE_KEYS);
    for (const key of Object.keys(picked)) {
      assert.ok(
        expectedKeys.has(key as (typeof PERSISTED_APP_STATE_KEYS)[number]),
        `unexpected key survived pickAppState: ${key}`,
      );
    }

    assert.equal(picked.viewBackgroundColor, "#f8f9fa");
    assert.equal(picked.gridSize, 20);
    assert.equal(picked.gridModeEnabled, true);
    assert.equal(picked.gridStep, 5);
    assert.equal(picked.exportBackground, true);
    assert.equal(picked.exportWithDarkMode, false);
    assert.equal(picked.exportScale, 2);
    assert.equal(picked.exportEmbedScene, true);
    assert.deepEqual(picked.frameRendering, {
      enabled: true,
      name: true,
      outline: true,
      clip: true,
    });
    // theme is viewer-only: accepted on the wire, never persisted (issue #38)
    assert.equal(picked.theme, undefined);
    assert.equal(picked.name, "Architecture");

    // Noise must be gone
    const asRec = picked as Record<string, unknown>;
    for (const noise of [
      "collaborators",
      "selectedElementIds",
      "previousSelectedElementIds",
      "scrollX",
      "scrollY",
      "zoom",
      "cursorButton",
      "openDialog",
      "openMenu",
      "openSidebar",
      "openPopup",
      "editingTextElement",
      "activeTool",
      "penMode",
      "width",
      "height",
      "offsetTop",
      "offsetLeft",
      "isLoading",
      "errorMessage",
      "toast",
      "showWelcomeScreen",
      "currentItemStrokeColor",
      "currentItemBackgroundColor",
      "selectedGroupIds",
      "editingGroupId",
      "multiElement",
      "newElement",
      "resizingElement",
      "selectedLinearElement",
      "contextMenu",
      "showStats",
    ]) {
      assert.equal(asRec[noise], undefined, `${noise} must not be persisted`);
    }
  });

  test("nullish / non-object input yields empty object", () => {
    assert.deepEqual(pickAppState(null), {});
    assert.deepEqual(pickAppState(undefined), {});
    assert.deepEqual(pickAppState("nope"), {});
    assert.deepEqual(pickAppState(42), {});
    assert.deepEqual(pickAppState([]), {});
  });

  test("is a pure allowlist — only declared keys", () => {
    assert.deepEqual(
      [...PERSISTED_APP_STATE_KEYS].sort(),
      [
        "exportBackground",
        "exportEmbedScene",
        "exportScale",
        "exportWithDarkMode",
        "frameRendering",
        "gridModeEnabled",
        "gridSize",
        "gridStep",
        "name",
        "theme",
        "viewBackgroundColor",
      ],
    );
  });

  test("theme is never written to the scene document (issue #38)", () => {
    assert.deepEqual(pickAppState({ theme: "dark" }), {});
    assert.deepEqual(pickAppState({ theme: "light", name: "x" }), {
      name: "x",
    });
    // Diffing two docs that only differ in theme must be empty once normalized.
    const a = normalizeScene({
      elements: [],
      appState: { theme: "light", viewBackgroundColor: "#fff" },
    });
    const b = normalizeScene({
      elements: [],
      appState: { theme: "dark", viewBackgroundColor: "#fff" },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(a.appState, "theme"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b.appState, "theme"), false);
    assert.deepEqual(a.appState, b.appState);
  });
});

// ---------------------------------------------------------------------------
// normalizeScene — fixtures + idempotence
// ---------------------------------------------------------------------------

describe("normalizeScene", () => {
  const allFixtures = listExcalidrawFiles(FIXTURES_DIR);

  test("fixture corpus is non-empty (6 scenes + 16 pair files)", () => {
    // 6 top-level + 8 pairs × 2 = 22
    assert.ok(allFixtures.length >= 22, `got ${allFixtures.length}`);
  });

  for (const path of allFixtures) {
    const label = relative(FIXTURES_DIR, path);

    test(`idempotent on fixture ${label}`, () => {
      const raw = loadRaw(path);
      const once = normalizeScene(raw);
      const twice = normalizeScene(once);
      assert.deepEqual(twice, once, `${label}: normalize(normalize(x)) !== normalize(x)`);

      // Elements pass through untouched (same object identity from once → twice
      // is not required after re-normalize of a plain object, but the first
      // normalize must keep input element references).
      const rawObj = raw as { elements: ExcalidrawElement[] };
      for (let i = 0; i < rawObj.elements.length; i++) {
        assert.equal(
          once.elements[i],
          rawObj.elements[i],
          `${label}: element[${i}] must be the same object reference`,
        );
      }
    });
  }

  test("accepts a bare element array", () => {
    const raw = loadRaw(join(FIXTURES_DIR, "simple-shapes.excalidraw")) as {
      elements: ExcalidrawElement[];
    };
    const doc = normalizeScene(raw.elements);
    assert.equal(doc.elements.length, raw.elements.length);
    assert.deepEqual(doc.appState, {});
    assert.deepEqual(doc.files, {});
    assert.equal(doc.elements[0], raw.elements[0]);
  });

  test("accepts a partial document without files/appState", () => {
    const els = [
      { id: "a", type: "rectangle", versionNonce: 1 },
      { id: "b", type: "ellipse", versionNonce: 2 },
    ];
    const doc = normalizeScene({ elements: els });
    assert.equal(doc.elements.length, 2);
    assert.deepEqual(doc.appState, {});
    assert.deepEqual(doc.files, {});
  });

  test("accepts an empty object as an empty scene", () => {
    const doc = normalizeScene({});
    assert.deepEqual(doc, { elements: [], appState: {}, files: {} });
  });

  test("drops envelope metadata and non-persistable appState", () => {
    const raw = {
      type: "excalidraw",
      version: 2,
      source: "https://example.test",
      elements: [{ id: "x", type: "rectangle", versionNonce: 9 }],
      appState: {
        viewBackgroundColor: "#fff",
        selectedElementIds: { x: true },
        collaborators: { c1: {} },
        scrollX: 10,
        zoom: { value: 1 },
      },
      files: {},
    };
    const doc = normalizeScene(raw);
    const rec = doc as unknown as Record<string, unknown>;
    assert.equal(rec.type, undefined);
    assert.equal(rec.version, undefined);
    assert.equal(rec.source, undefined);
    assert.deepEqual(doc.appState, { viewBackgroundColor: "#fff" });
    assert.equal(doc.elements[0], raw.elements[0]);
  });

  test("does not fabricate fractional index fields", () => {
    const el = { id: "no-index", type: "rectangle", versionNonce: 1 };
    const doc = normalizeScene({ elements: [el] });
    assert.equal(
      Object.prototype.hasOwnProperty.call(doc.elements[0], "index"),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeScene — malformed inputs collect every problem
// ---------------------------------------------------------------------------

describe("normalizeScene validation", () => {
  function assertRejects(
    input: unknown,
    expectedSubstrings: string[],
  ): SceneValidationError {
    assert.throws(
      () => normalizeScene(input),
      (err: unknown) => {
        assert.ok(err instanceof SceneValidationError, `got ${err}`);
        for (const sub of expectedSubstrings) {
          assert.ok(
            err.problems.some((p) => p.includes(sub)),
            `expected a problem containing ${JSON.stringify(sub)}, got: ${JSON.stringify(err.problems)}`,
          );
        }
        return true;
      },
    );
    try {
      normalizeScene(input);
    } catch (err) {
      return err as SceneValidationError;
    }
    throw new Error("unreachable");
  }

  test("rejects non-object, non-array input", () => {
    assertRejects(null, ["expected an object"]);
    assertRejects(undefined, ["expected an object"]);
    assertRejects(42, ["expected an object"]);
    assertRejects("scene", ["expected an object"]);
  });

  test("rejects elements that are not an array", () => {
    assertRejects({ elements: "nope" }, ["elements must be an array"]);
    assertRejects({ elements: {} }, ["elements must be an array"]);
  });

  test("rejects element missing id or type", () => {
    const err = assertRejects(
      {
        elements: [
          { type: "rectangle" },
          { id: "only-id" },
          { id: "ok", type: "ellipse" },
        ],
      },
      ['elements[0] is missing required field "id"', 'elements[1] is missing required field "type"'],
    );
    // The valid third element must not prevent reporting the others.
    assert.ok(err.problems.length >= 2);
  });

  test("rejects wrong-typed id / type and empty strings", () => {
    assertRejects(
      {
        elements: [
          { id: 123, type: "rectangle" },
          { id: "", type: "ellipse" },
          { id: "x", type: 5 },
          { id: "y", type: "" },
        ],
      },
      [
        "elements[0].id must be a string",
        "elements[1].id must be a non-empty string",
        "elements[2].type must be a string",
        "elements[3].type must be a non-empty string",
      ],
    );
  });

  test("rejects duplicate element ids (names both sites)", () => {
    const err = assertRejects(
      {
        elements: [
          { id: "dup", type: "rectangle" },
          { id: "other", type: "ellipse" },
          { id: "dup", type: "diamond" },
        ],
      },
      ['duplicate element id "dup"', "elements[2]", "elements[0]"],
    );
    assert.equal(err.problems.filter((p) => p.includes("duplicate")).length, 1);
  });

  test("rejects files map with missing fileId for image elements", () => {
    assertRejects(
      {
        elements: [
          {
            id: "img-1",
            type: "image",
            fileId: "missing-file-abc",
            isDeleted: false,
            versionNonce: 1,
          },
        ],
        files: {},
      },
      ['fileId "missing-file-abc"', "missing from the files map"],
    );
  });

  test("rejects malformed files entries and collects with other problems", () => {
    const err = assertRejects(
      {
        elements: [
          { type: "rectangle" }, // missing id
          {
            id: "img-1",
            type: "image",
            fileId: "f1",
            isDeleted: false,
          },
        ],
        files: {
          f1: "not-an-object",
          f2: { mimeType: "image/png" }, // missing dataURL
        },
      },
      [
        'elements[0] is missing required field "id"',
        'files["f1"] must be a BinaryFileData object',
        'files["f2"].dataURL must be a string',
      ],
    );
    assert.ok(err.problems.length >= 3);
  });

  test("rejects bad appState / files container types", () => {
    assertRejects({ elements: [], appState: "nope" }, ["appState must be an object"]);
    assertRejects({ elements: [], files: [] }, ["files must be an object map"]);
  });

  test("never silently repairs — invalid stays invalid on re-call", () => {
    const bad = { elements: [{ id: "a" }] };
    assert.throws(() => normalizeScene(bad), SceneValidationError);
    assert.throws(() => normalizeScene(bad), SceneValidationError);
  });

  test("error message lists every problem for multi-issue input", () => {
    try {
      normalizeScene({
        elements: [{ foo: 1 }, { id: "d", type: "rectangle" }, { id: "d", type: "ellipse" }],
        appState: 1,
        files: "x",
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof SceneValidationError);
      assert.ok(err.problems.length >= 4, `got ${err.problems.length}: ${err.problems}`);
      assert.match(err.message, /problems/);
    }
  });
});

// ---------------------------------------------------------------------------
// splitFiles / mergeFiles
// ---------------------------------------------------------------------------

describe("splitFiles / mergeFiles", () => {
  test("round-trips the with-image fixture exactly", () => {
    const raw = loadRaw(join(FIXTURES_DIR, "with-image.excalidraw"));
    const doc = normalizeScene(raw);
    assert.ok(Object.keys(doc.files).length > 0, "fixture should embed a file");

    const { doc: stripped, files } = splitFiles(doc);
    assert.deepEqual(stripped.files, {});
    assert.ok(Object.keys(files).length > 0);
    // elements / appState identity preserved
    assert.equal(stripped.elements, doc.elements);
    assert.equal(stripped.appState, doc.appState);
    // files map is the original
    assert.deepEqual(files, doc.files);

    const restored = mergeFiles(stripped, files);
    assert.deepEqual(restored, doc);
    assert.equal(restored.elements, doc.elements);
    assert.equal(restored.appState, doc.appState);
    assert.deepEqual(restored.files, doc.files);
  });

  test("round-trips every fixture (including empty files)", () => {
    for (const path of listExcalidrawFiles(FIXTURES_DIR)) {
      const doc = normalizeScene(loadRaw(path));
      const { doc: stripped, files } = splitFiles(doc);
      const restored = mergeFiles(stripped, files);
      assert.deepEqual(
        restored,
        doc,
        `round-trip failed for ${relative(FIXTURES_DIR, path)}`,
      );
    }
  });

  test("split of empty files is still round-trippable", () => {
    const doc: SceneDocument = {
      elements: [],
      appState: { viewBackgroundColor: "#fff" },
      files: {},
    };
    const { doc: stripped, files } = splitFiles(doc);
    assert.deepEqual(mergeFiles(stripped, files), doc);
    assert.deepEqual(files, {});
  });
});

// ---------------------------------------------------------------------------
// sceneHash
// ---------------------------------------------------------------------------

describe("sceneHash", () => {
  test("is deterministic and order-sensitive (djb2 over versionNonce)", () => {
    const a = { versionNonce: 1 } as ExcalidrawElement;
    const b = { versionNonce: 2 } as ExcalidrawElement;
    const c = { versionNonce: 3 } as ExcalidrawElement;

    assert.equal(sceneHash([a, b, c]), sceneHash([a, b, c]));
    assert.notEqual(sceneHash([a, b, c]), sceneHash([c, b, a]));
    assert.notEqual(sceneHash([a, b]), sceneHash([a, b, c]));
  });

  test("matches the known djb2 reference implementation", () => {
    // Independent copy of the upstream algorithm for agreement.
    function ref(elements: { versionNonce: number }[]): number {
      let hash = 5381;
      for (let i = 0; i < elements.length; i++) {
        hash = (hash << 5) + hash + elements[i]!.versionNonce;
      }
      return hash >>> 0;
    }

    const samples: { versionNonce: number }[][] = [
      [],
      [{ versionNonce: 0 }],
      [{ versionNonce: 1 }, { versionNonce: 2 }, { versionNonce: 3 }],
      [{ versionNonce: 428152832 }, { versionNonce: 2130208768 }],
    ];
    for (const s of samples) {
      assert.equal(sceneHash(s), ref(s));
    }

    // Hand-checked: empty → 5381
    assert.equal(sceneHash([]), 5381);
  });

  test("stable across fixture corpus", () => {
    for (const path of listExcalidrawFiles(FIXTURES_DIR)) {
      const doc = normalizeScene(loadRaw(path));
      const h1 = sceneHash(doc.elements);
      const h2 = sceneHash(doc.elements);
      assert.equal(h1, h2);
      assert.equal(typeof h1, "number");
      assert.ok(Number.isInteger(h1));
      assert.ok(h1 >= 0 && h1 <= 0xffffffff);
    }
  });

  test("agrees with upstream hashElementsVersion on fixtures", async () => {
    // Upstream is a browser bundle; load it the same way the fixture generator
    // does (custom ESM loader + browser shims). If that fails in this
    // environment we still have the pure-algorithm agreement test above —
    // but we try hard to hit the real export.
    const { spawnSync } = await import("node:child_process");
    const register = join(HERE, "..", "scripts", "register.mjs");
    const fixturePaths = listExcalidrawFiles(FIXTURES_DIR);

    // Build a tiny script that prints JSON of { path, upstream, local } per fixture.
    const script = `
      import { readFileSync } from "node:fs";
      import { hashElementsVersion } from "@excalidraw/excalidraw";
      const paths = ${JSON.stringify(fixturePaths)};
      // Local mirror (same as packages/core/src/hash.ts)
      function sceneHash(elements) {
        let hash = 5381;
        for (let i = 0; i < elements.length; i++) {
          hash = (hash << 5) + hash + (elements[i]?.versionNonce ?? 0);
        }
        return hash >>> 0;
      }
      const out = [];
      for (const p of paths) {
        const doc = JSON.parse(readFileSync(p, "utf8"));
        const els = doc.elements ?? [];
        out.push({ path: p, upstream: hashElementsVersion(els), local: sceneHash(els) });
      }
      process.stdout.write(JSON.stringify(out));
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", register, "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        cwd: join(HERE, ".."),
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (result.status !== 0) {
      // Environment cannot load the browser bundle — skip soft-fail is not
      // available in node:test without `test.skip`; rethrow with context so
      // CI surfaces it, but the pure-algorithm test still covers the logic.
      assert.fail(
        `could not load upstream hashElementsVersion for agreement check:\n` +
          `status=${result.status}\nstderr=${result.stderr}\nstdout=${result.stdout}`,
      );
    }

    const rows = JSON.parse(result.stdout) as Array<{
      path: string;
      upstream: number;
      local: number;
    }>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(
        row.local,
        row.upstream,
        `sceneHash !== hashElementsVersion for ${row.path}: local=${row.local} upstream=${row.upstream}`,
      );
      // Also agree with the in-process implementation under test.
      const doc = normalizeScene(loadRaw(row.path));
      assert.equal(sceneHash(doc.elements), row.upstream);
    }
  });
});
