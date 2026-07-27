/**
 * Generate authentic `.excalidraw` fixtures via the real upstream package
 * (`@excalidraw/excalidraw@0.18.1`):
 *
 *   skeletons → convertToExcalidrawElements → restoreElements → serializeAsJSON
 *
 * Run from packages/core:
 *   node --import ./scripts/register.mjs ./scripts/generate-fixtures.mjs
 *
 * Re-running is deterministic (seeded RNG + fixed Date.now).
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedRandom } from "./browser-shim.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "test", "fixtures");
const PAIRS_DIR = join(FIXTURES_DIR, "pairs");

// Seed before importing excalidraw so nanoid / seed / versionNonce are stable
seedRandom(0xeca11d42);

const {
  convertToExcalidrawElements,
  restoreElements,
  serializeAsJSON,
} = await import("@excalidraw/excalidraw");

const DEFAULT_APP_STATE = {
  viewBackgroundColor: "#ffffff",
  gridSize: null,
  gridModeEnabled: false,
};

/** 1×1 red PNG (deterministic embedded image payload). */
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const IMAGE_FILE_ID = "file_fixture_image_001";

/**
 * convertToExcalidrawElements computes arrow x/y/gap from element bounds using
 * browser geometry. Under our Node canvas shim that yields NaN, which
 * JSON.stringify turns into null. Repair arrows from their bindings + points
 * so fixtures carry real numbers (what a real editor would emit).
 */
function repairArrowGeometry(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return elements.map((el) => {
    if (el.type !== "arrow" && el.type !== "line") return el;
    const next = { ...el };

    const startEl = next.startBinding
      ? byId.get(next.startBinding.elementId)
      : null;
    const endEl = next.endBinding ? byId.get(next.endBinding.elementId) : null;

    // Prefer midpoints of bound shapes; fall back to existing numeric coords.
    let x1 =
      startEl != null
        ? startEl.x + startEl.width / 2
        : Number.isFinite(next.x)
          ? next.x
          : 0;
    let y1 =
      startEl != null
        ? startEl.y + startEl.height / 2
        : Number.isFinite(next.y)
          ? next.y
          : 0;
    let x2 =
      endEl != null
        ? endEl.x + endEl.width / 2
        : Number.isFinite(next.x) && Array.isArray(next.points) && next.points[1]
          ? next.x + next.points[1][0]
          : x1 + 100;
    let y2 =
      endEl != null
        ? endEl.y + endEl.height / 2
        : Number.isFinite(next.y) && Array.isArray(next.points) && next.points[1]
          ? next.y + next.points[1][1]
          : y1;

    // Offset start/end to the shape edge along the line (simple radial offset)
    if (startEl) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (dx / len) * (startEl.width / 2);
      const oy = (dy / len) * (startEl.height / 2);
      x1 += ox;
      y1 += oy;
    }
    if (endEl) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (dx / len) * (endEl.width / 2);
      const oy = (dy / len) * (endEl.height / 2);
      x2 -= ox;
      y2 -= oy;
    }

    next.x = x1;
    next.y = y1;
    next.points = [
      [0, 0],
      [x2 - x1, y2 - y1],
    ];
    next.width = Math.abs(x2 - x1);
    next.height = Math.abs(y2 - y1);

    if (next.startBinding) {
      next.startBinding = {
        ...next.startBinding,
        gap: Number.isFinite(next.startBinding.gap) ? next.startBinding.gap : 1,
        focus: Number.isFinite(next.startBinding.focus)
          ? next.startBinding.focus
          : 0,
      };
    }
    if (next.endBinding) {
      next.endBinding = {
        ...next.endBinding,
        gap: Number.isFinite(next.endBinding.gap) ? next.endBinding.gap : 1,
        focus: Number.isFinite(next.endBinding.focus)
          ? next.endBinding.focus
          : 0,
      };
    }
    return next;
  });
}

/** Replace non-finite numbers so JSON stays valid. */
function sanitizeFinite(value) {
  if (typeof value === "number" && !Number.isFinite(value)) return 0;
  if (Array.isArray(value)) return value.map(sanitizeFinite);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeFinite(v);
    return out;
  }
  return value;
}

/**
 * @param {object[]} skeletons
 * @param {Record<string, unknown>} [files]
 */
function buildScene(skeletons, files = {}) {
  const converted = convertToExcalidrawElements(skeletons, {
    regenerateIds: false,
  });
  let elements = restoreElements(converted, null, {
    repairBindings: true,
  });
  elements = repairArrowGeometry(elements);
  elements = elements.map((e) => sanitizeFinite(e));
  const json = serializeAsJSON(elements, DEFAULT_APP_STATE, files, "local");
  return JSON.parse(json);
}

function writeFixture(relPath, scene) {
  const full = join(FIXTURES_DIR, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  console.log("wrote", relPath, `(${scene.elements.length} elements)`);
}

function clone(obj) {
  return structuredClone(obj);
}

/** Deep-clone a scene and return elements as a mutable array. */
function withElements(scene, mutator) {
  const next = clone(scene);
  let elements = mutator(next.elements.map((e) => ({ ...e })));
  elements = restoreElements(elements, null, { repairBindings: true });
  elements = repairArrowGeometry(elements);
  elements = elements.map((e) => sanitizeFinite(e));
  const files = next.files ?? {};
  const json = serializeAsJSON(
    elements,
    next.appState ?? DEFAULT_APP_STATE,
    files,
    "local",
  );
  return JSON.parse(json);
}

function findById(elements, id) {
  const el = elements.find((e) => e.id === id);
  if (!el) throw new Error(`element not found: ${id}`);
  return el;
}

// ---------------------------------------------------------------------------
// Corpus fixtures
// ---------------------------------------------------------------------------

function fixtureEmpty() {
  return buildScene([]);
}

function fixtureSimpleShapes() {
  return buildScene([
    {
      type: "rectangle",
      id: "rect-1",
      x: 100,
      y: 100,
      width: 160,
      height: 80,
      backgroundColor: "#a5d8ff",
      strokeColor: "#1e1e1e",
    },
    {
      type: "ellipse",
      id: "ellipse-1",
      x: 320,
      y: 100,
      width: 100,
      height: 100,
      backgroundColor: "#b2f2bb",
    },
    {
      type: "diamond",
      id: "diamond-1",
      x: 480,
      y: 100,
      width: 100,
      height: 100,
      backgroundColor: "#ffec99",
    },
    {
      type: "text",
      id: "text-standalone",
      x: 100,
      y: 220,
      text: "Simple shapes",
      fontSize: 20,
    },
  ]);
}

function fixtureBoundText() {
  return buildScene([
    {
      type: "rectangle",
      id: "container-auth",
      x: 120,
      y: 140,
      width: 200,
      height: 90,
      backgroundColor: "#e7f5ff",
      label: { text: "Auth Service", fontSize: 18 },
    },
    {
      type: "ellipse",
      id: "container-cache",
      x: 400,
      y: 140,
      width: 160,
      height: 100,
      backgroundColor: "#fff3bf",
      label: { text: "Cache", fontSize: 18 },
    },
  ]);
}

function fixtureArrowsBound() {
  return buildScene([
    {
      type: "rectangle",
      id: "node-api",
      x: 80,
      y: 160,
      width: 140,
      height: 70,
      backgroundColor: "#d0ebff",
      label: { text: "API", fontSize: 16 },
    },
    {
      type: "rectangle",
      id: "node-db",
      x: 360,
      y: 80,
      width: 140,
      height: 70,
      backgroundColor: "#d3f9d8",
      label: { text: "DB", fontSize: 16 },
    },
    {
      type: "rectangle",
      id: "node-cache",
      x: 360,
      y: 240,
      width: 140,
      height: 70,
      backgroundColor: "#fff3bf",
      label: { text: "Cache", fontSize: 16 },
    },
    {
      type: "arrow",
      id: "arrow-api-db",
      start: { id: "node-api" },
      end: { id: "node-db" },
      strokeColor: "#1e1e1e",
    },
    {
      type: "arrow",
      id: "arrow-api-cache",
      start: { id: "node-api" },
      end: { id: "node-cache" },
      strokeColor: "#1e1e1e",
    },
  ]);
}

function fixtureFrames() {
  return buildScene([
    {
      type: "rectangle",
      id: "child-rect",
      x: 140,
      y: 140,
      width: 120,
      height: 60,
      backgroundColor: "#eebefa",
      label: { text: "Worker", fontSize: 16 },
    },
    {
      type: "ellipse",
      id: "child-ellipse",
      x: 300,
      y: 140,
      width: 80,
      height: 80,
      backgroundColor: "#ffc9c9",
    },
    {
      type: "frame",
      id: "frame-main",
      name: "Pipeline",
      children: ["child-rect", "child-ellipse"],
    },
  ]);
}

function fixtureWithImage() {
  const files = {
    [IMAGE_FILE_ID]: {
      mimeType: "image/png",
      id: IMAGE_FILE_ID,
      dataURL: TINY_PNG_DATA_URL,
      created: 1_700_000_000_000,
      lastRetrieved: 1_700_000_000_000,
    },
  };

  // convertToExcalidrawElements supports image skeletons with fileId
  const scene = buildScene(
    [
      {
        type: "image",
        id: "image-1",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        fileId: IMAGE_FILE_ID,
        status: "saved",
      },
      {
        type: "text",
        id: "image-caption",
        x: 100,
        y: 320,
        text: "Embedded image",
        fontSize: 16,
      },
    ],
    files,
  );

  // serializeAsJSON may drop files when type is "local" depending on version;
  // ensure the embedded file is present on the fixture.
  scene.files = { ...files, ...(scene.files ?? {}) };
  return scene;
}

// ---------------------------------------------------------------------------
// Diff pairs (before / after) — each pair differs only as its name claims
// ---------------------------------------------------------------------------

function pairBase() {
  // Shared starting scene for most pairs: two labelled boxes + arrow + free text
  return buildScene([
    {
      type: "rectangle",
      id: "box-a",
      x: 100,
      y: 100,
      width: 150,
      height: 80,
      backgroundColor: "#a5d8ff",
      strokeColor: "#1e1e1e",
      strokeWidth: 2,
      label: { text: "Service A", fontSize: 16 },
    },
    {
      type: "rectangle",
      id: "box-b",
      x: 400,
      y: 100,
      width: 150,
      height: 80,
      backgroundColor: "#b2f2bb",
      strokeColor: "#1e1e1e",
      strokeWidth: 2,
      label: { text: "Service B", fontSize: 16 },
    },
    {
      type: "rectangle",
      id: "box-c",
      x: 250,
      y: 280,
      width: 150,
      height: 80,
      backgroundColor: "#ffec99",
      strokeColor: "#1e1e1e",
      strokeWidth: 2,
      label: { text: "Service C", fontSize: 16 },
    },
    {
      type: "arrow",
      id: "link-ab",
      start: { id: "box-a" },
      end: { id: "box-b" },
    },
    {
      type: "text",
      id: "note-1",
      x: 100,
      y: 400,
      text: "Draft note",
      fontSize: 18,
    },
  ]);
}

function pairMove(before) {
  return withElements(before, (els) => {
    const box = findById(els, "box-a");
    // Move only box-a (bound text moves with container via restore repair)
    box.x = box.x + 80;
    box.y = box.y + 40;
    // Keep bound text in sync position-wise for a clean "moved" delta
    for (const el of els) {
      if (el.type === "text" && el.containerId === "box-a") {
        el.x = el.x + 80;
        el.y = el.y + 40;
      }
    }
    // Arrow endpoints will rebind/reposition via restore; that's ok for move of a bound node
    return els;
  });
}

function pairResize(before) {
  return withElements(before, (els) => {
    const box = findById(els, "box-b");
    box.width = box.width + 60;
    box.height = box.height + 40;
    return els;
  });
}

function pairRestyle(before) {
  return withElements(before, (els) => {
    const box = findById(els, "box-a");
    box.backgroundColor = "#ff8787";
    box.strokeColor = "#c92a2a";
    box.strokeWidth = 4;
    box.fillStyle = "solid";
    return els;
  });
}

function pairTextEdit(before) {
  return withElements(before, (els) => {
    const note = findById(els, "note-1");
    note.text = "Edited note";
    note.originalText = "Edited note";
    // Also edit bound label on box-c
    for (const el of els) {
      if (el.type === "text" && el.containerId === "box-c") {
        el.text = "Service C (renamed)";
        el.originalText = "Service C (renamed)";
      }
    }
    return els;
  });
}

function pairRebind(before) {
  return withElements(before, (els) => {
    const arrow = findById(els, "link-ab");
    // Rebind end from box-b → box-c
    const end = arrow.endBinding;
    if (!end) throw new Error("expected endBinding on link-ab");
    arrow.endBinding = {
      ...end,
      elementId: "box-c",
    };
    // Update boundElements on boxes
    const b = findById(els, "box-b");
    const c = findById(els, "box-c");
    b.boundElements = (b.boundElements ?? []).filter((be) => be.id !== "link-ab");
    const cBounds = [...(c.boundElements ?? [])];
    if (!cBounds.some((be) => be.id === "link-ab")) {
      cBounds.push({ id: "link-ab", type: "arrow" });
    }
    c.boundElements = cBounds;
    // Nudge arrow end point toward box-c
    if (Array.isArray(arrow.points) && arrow.points.length >= 2) {
      const last = arrow.points.length - 1;
      arrow.points = arrow.points.map((p, i) =>
        i === last ? [c.x + c.width / 2 - arrow.x, c.y - arrow.y] : p,
      );
    }
    return els;
  });
}

function pairDelete(before) {
  return withElements(before, (els) => {
    // Soft-delete box-c and its bound text (Excalidraw tombstones)
    for (const el of els) {
      if (el.id === "box-c" || el.containerId === "box-c") {
        el.isDeleted = true;
      }
    }
    return els;
  });
}

function pairReorder(before) {
  return withElements(before, (els) => {
    // Reverse array order of top-level (non-deleted) elements.
    // Fractional index is repaired by restoreElements → syncInvalidIndices.
    const deleted = els.filter((e) => e.isDeleted);
    const live = els.filter((e) => !e.isDeleted).reverse();
    return [...live, ...deleted];
  });
}

function pairGroup(before) {
  return withElements(before, (els) => {
    const groupId = "group-ab-fixture";
    for (const el of els) {
      if (el.id === "box-a" || el.id === "box-b") {
        el.groupIds = [groupId, ...el.groupIds];
      }
      // Bound text of grouped containers also joins the group (editor behavior)
      if (
        el.type === "text" &&
        (el.containerId === "box-a" || el.containerId === "box-b")
      ) {
        el.groupIds = [groupId, ...el.groupIds];
      }
    }
    return els;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Clean previous generated output (keep directory structure)
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
  mkdirSync(PAIRS_DIR, { recursive: true });

  // Corpus
  writeFixture("empty.excalidraw", fixtureEmpty());
  writeFixture("simple-shapes.excalidraw", fixtureSimpleShapes());
  writeFixture("bound-text.excalidraw", fixtureBoundText());
  writeFixture("arrows-bound.excalidraw", fixtureArrowsBound());
  writeFixture("frames.excalidraw", fixtureFrames());
  writeFixture("with-image.excalidraw", fixtureWithImage());

  // Pairs
  const pairs = [
    ["move", pairMove],
    ["resize", pairResize],
    ["restyle", pairRestyle],
    ["text-edit", pairTextEdit],
    ["rebind", pairRebind],
    ["delete", pairDelete],
    ["reorder", pairReorder],
    ["group", pairGroup],
  ];

  for (const [name, afterFn] of pairs) {
    // Fresh base per pair so each before is identical and independent
    seedRandom(0xeca11d42);
    const before = pairBase();
    seedRandom(0xeca11d42 + name.length * 17);
    const after = afterFn(before);
    writeFixture(`pairs/${name}.before.excalidraw`, before);
    writeFixture(`pairs/${name}.after.excalidraw`, after);
  }

  console.log("\nFixtures generated under", FIXTURES_DIR);
}

main();
