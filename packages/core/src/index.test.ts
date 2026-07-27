import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import type {
  SceneDocument,
  SceneVersion,
  SceneMeta,
  PushRequest,
  PushResponse,
  ConflictResponse,
  ElementChange,
  SceneDiff,
  SceneDigest,
  ExcalidrawElement,
  BinaryFiles,
} from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");

/** Structural checks that a parsed JSON blob is a SceneDocument-shaped fixture. */
function assertSceneDocument(value: unknown, label: string): asserts value is SceneDocument {
  assert.ok(value && typeof value === "object", `${label}: expected object`);
  const doc = value as Record<string, unknown>;
  assert.ok(Array.isArray(doc.elements), `${label}: elements must be an array`);
  assert.ok(
    doc.appState === undefined || (doc.appState && typeof doc.appState === "object"),
    `${label}: appState must be object if present`,
  );
  // files may be missing on empty scenes serialized by upstream
  if (doc.files !== undefined) {
    assert.equal(typeof doc.files, "object", `${label}: files must be object`);
    assert.ok(doc.files !== null, `${label}: files must not be null`);
  }

  for (const [i, el] of (doc.elements as unknown[]).entries()) {
    assert.ok(el && typeof el === "object", `${label}: element[${i}] object`);
    const e = el as Record<string, unknown>;
    assert.equal(typeof e.id, "string", `${label}: element[${i}].id`);
    assert.equal(typeof e.type, "string", `${label}: element[${i}].type`);
    assert.equal(typeof e.x, "number", `${label}: element[${i}].x`);
    assert.ok(Number.isFinite(e.x as number), `${label}: element[${i}].x finite`);
    assert.equal(typeof e.y, "number", `${label}: element[${i}].y`);
    assert.ok(Number.isFinite(e.y as number), `${label}: element[${i}].y finite`);
    assert.equal(typeof e.width, "number", `${label}: element[${i}].width`);
    assert.equal(typeof e.height, "number", `${label}: element[${i}].height`);
    assert.equal(typeof e.version, "number", `${label}: element[${i}].version`);
    assert.equal(typeof e.versionNonce, "number", `${label}: element[${i}].versionNonce`);
    assert.equal(typeof e.seed, "number", `${label}: element[${i}].seed`);
    assert.equal(typeof e.isDeleted, "boolean", `${label}: element[${i}].isDeleted`);
  }
}

function loadFixture(path: string): SceneDocument {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertSceneDocument(raw, relative(FIXTURES_DIR, path));
  const doc = raw as {
    elements: ExcalidrawElement[];
    appState?: SceneDocument["appState"];
    files?: BinaryFiles;
  };
  // Normalize to SceneDocument (files defaults to {})
  return {
    elements: doc.elements,
    appState: doc.appState ?? {},
    files: doc.files ?? {},
  };
}

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

const IGNORE_PROPS = new Set([
  "version",
  "versionNonce",
  "updated",
  "seed",
  "index",
]);

function elementMap(elements: readonly ExcalidrawElement[]): Map<string, ExcalidrawElement> {
  return new Map(elements.map((e) => [e.id, e]));
}

function propDiffs(
  before: ExcalidrawElement,
  after: ExcalidrawElement,
): Array<{ key: string; from: unknown; to: unknown }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const key of keys) {
    if (IGNORE_PROPS.has(key)) continue;
    const from = (before as Record<string, unknown>)[key];
    const to = (after as Record<string, unknown>)[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diffs.push({ key, from, to });
    }
  }
  return diffs;
}

describe("type surface (compile-time + shape smoke)", () => {
  test("SceneDocument / SceneVersion / SceneMeta / wire types are constructible", () => {
    const doc: SceneDocument = {
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const version: SceneVersion = {
      version: 1,
      parentVersion: null,
      author: "agent",
      message: "init",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const meta: SceneMeta = {
      id: "s1",
      slug: "arch",
      name: "Architecture",
      headVersion: 1,
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
      lock: null,
    };
    const push: PushRequest = {
      parentVersion: 1,
      elements: doc.elements,
      appState: doc.appState,
      files: doc.files,
      author: "agent",
      message: "turn",
    };
    const ok: PushResponse = {
      version: 2,
      parentVersion: 1,
      author: "agent",
      message: "turn",
      createdAt: version.createdAt,
    };
    const change: ElementChange = {
      op: "add",
      id: "x",
      type: "rectangle",
      label: null,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      describe: "+ rectangle",
    };
    const diff: SceneDiff = {
      from: 1,
      to: 2,
      summary: { added: 1, deleted: 0, updated: 0, reordered: 0 },
      elements: [change],
      appState: [],
    };
    const conflict: ConflictResponse = {
      parentVersion: 1,
      headVersion: 3,
      diff,
    };
    const digest: SceneDigest = {
      elementCount: 0,
      countsByType: {},
      bbox: null,
      frameCount: 0,
      truncated: false,
      omitted: 0,
      frames: [],
      groups: [],
      edges: [],
      elements: [],
    };

    assert.equal(meta.slug, "arch");
    assert.equal(push.parentVersion, 1);
    assert.equal(ok.version, 2);
    assert.equal(conflict.headVersion, 3);
    assert.equal(digest.elementCount, 0);
    assert.equal(diff.summary.added, 1);
  });
});

describe("fixture corpus", () => {
  const allFixtures = listExcalidrawFiles(FIXTURES_DIR);
  const corpus = allFixtures.filter((p) => !p.includes(`${join("fixtures", "pairs")}`));

  test("at least 6 corpus fixtures exist", () => {
    assert.ok(corpus.length >= 6, `expected ≥6 fixtures, got ${corpus.length}`);
  });

  test("every fixture loads as a SceneDocument", () => {
    assert.ok(allFixtures.length > 0, "no fixtures found");
    for (const path of allFixtures) {
      const doc = loadFixture(path);
      // Assign through the type to force structural compatibility
      const typed: SceneDocument = doc;
      assert.ok(Array.isArray(typed.elements));
      assert.equal(typeof typed.files, "object");
    }
  });

  test("empty fixture has no elements", () => {
    const doc = loadFixture(join(FIXTURES_DIR, "empty.excalidraw"));
    assert.equal(doc.elements.length, 0);
  });

  test("simple-shapes has rectangle/ellipse/diamond/text", () => {
    const doc = loadFixture(join(FIXTURES_DIR, "simple-shapes.excalidraw"));
    const types = new Set(doc.elements.map((e) => e.type));
    for (const t of ["rectangle", "ellipse", "diamond", "text"] as const) {
      assert.ok(types.has(t), `missing type ${t}`);
    }
  });

  test("bound-text has containers with bound text elements", () => {
    const doc = loadFixture(join(FIXTURES_DIR, "bound-text.excalidraw"));
    const texts = doc.elements.filter((e) => e.type === "text");
    assert.ok(texts.length >= 2);
    for (const t of texts) {
      assert.ok(
        "containerId" in t && t.containerId,
        `text ${t.id} should have containerId`,
      );
    }
    const containers = doc.elements.filter(
      (e) => e.type === "rectangle" || e.type === "ellipse",
    );
    for (const c of containers) {
      const bounds = c.boundElements ?? [];
      assert.ok(
        bounds.some((b) => b.type === "text"),
        `container ${c.id} should list bound text`,
      );
    }
  });

  test("arrows-bound has arrows with start/end bindings", () => {
    const doc = loadFixture(join(FIXTURES_DIR, "arrows-bound.excalidraw"));
    const arrows = doc.elements.filter((e) => e.type === "arrow");
    assert.ok(arrows.length >= 2);
    for (const a of arrows) {
      assert.ok("startBinding" in a && a.startBinding, `${a.id} startBinding`);
      assert.ok("endBinding" in a && a.endBinding, `${a.id} endBinding`);
    }
  });

  test("frames fixture has a frame with children", () => {
    const doc = loadFixture(join(FIXTURES_DIR, "frames.excalidraw"));
    const frames = doc.elements.filter((e) => e.type === "frame");
    assert.equal(frames.length, 1);
    const frame = frames[0]!;
    const children = doc.elements.filter((e) => e.frameId === frame.id);
    assert.ok(children.length >= 2, "frame should have ≥2 children");
  });

  test("with-image fixture embeds a binary file", () => {
    const doc = loadFixture(join(FIXTURES_DIR, "with-image.excalidraw"));
    const images = doc.elements.filter((e) => e.type === "image");
    assert.equal(images.length, 1);
    const img = images[0]!;
    assert.ok("fileId" in img && img.fileId, "image.fileId");
    const fileId = img.fileId as string;
    assert.ok(doc.files[fileId], `files[${fileId}] present`);
    assert.ok(
      String(doc.files[fileId]!.dataURL).startsWith("data:image/"),
      "dataURL is image",
    );
  });
});

describe("fixture pairs", () => {
  const PAIR_NAMES = [
    "move",
    "resize",
    "restyle",
    "text-edit",
    "rebind",
    "delete",
    "reorder",
    "group",
  ] as const;

  for (const name of PAIR_NAMES) {
    test(`pairs/${name}: before and after differ as claimed`, () => {
      const before = loadFixture(join(FIXTURES_DIR, "pairs", `${name}.before.excalidraw`));
      const after = loadFixture(join(FIXTURES_DIR, "pairs", `${name}.after.excalidraw`));
      const bMap = elementMap(before.elements);
      const aMap = elementMap(after.elements);

      switch (name) {
        case "move": {
          const b = bMap.get("box-a");
          const a = aMap.get("box-a");
          assert.ok(b && a);
          assert.ok(b.x !== a.x || b.y !== a.y, "box-a position should change");
          // No size/style change on box-a
          assert.equal(b.width, a.width);
          assert.equal(b.height, a.height);
          assert.equal(b.backgroundColor, a.backgroundColor);
          break;
        }
        case "resize": {
          const b = bMap.get("box-b");
          const a = aMap.get("box-b");
          assert.ok(b && a);
          assert.ok(b.width !== a.width || b.height !== a.height, "size change");
          assert.equal(b.x, a.x);
          assert.equal(b.y, a.y);
          assert.equal(b.backgroundColor, a.backgroundColor);
          break;
        }
        case "restyle": {
          const b = bMap.get("box-a");
          const a = aMap.get("box-a");
          assert.ok(b && a);
          assert.notEqual(b.backgroundColor, a.backgroundColor);
          assert.equal(b.x, a.x);
          assert.equal(b.y, a.y);
          assert.equal(b.width, a.width);
          assert.equal(b.height, a.height);
          break;
        }
        case "text-edit": {
          const bNote = bMap.get("note-1");
          const aNote = aMap.get("note-1");
          assert.ok(bNote && aNote && bNote.type === "text" && aNote.type === "text");
          assert.notEqual(
            (bNote as { text: string }).text,
            (aNote as { text: string }).text,
          );
          break;
        }
        case "rebind": {
          const b = bMap.get("link-ab");
          const a = aMap.get("link-ab");
          assert.ok(b && a && b.type === "arrow" && a.type === "arrow");
          const bEnd = (b as { endBinding: { elementId: string } | null }).endBinding;
          const aEnd = (a as { endBinding: { elementId: string } | null }).endBinding;
          assert.ok(bEnd && aEnd);
          assert.notEqual(bEnd.elementId, aEnd.elementId, "end binding target changes");
          break;
        }
        case "delete": {
          assert.ok(bMap.has("box-c"), "before has box-c");
          // Deleted either missing or isDeleted
          const a = aMap.get("box-c");
          assert.ok(!a || a.isDeleted, "box-c deleted after");
          break;
        }
        case "reorder": {
          const bOrder = before.elements.map((e) => e.id);
          const aOrder = after.elements.map((e) => e.id);
          assert.notDeepEqual(bOrder, aOrder, "array order changes");
          // Same element set (by id), ignoring churn props
          assert.deepEqual(
            [...bMap.keys()].sort(),
            [...aMap.keys()].sort(),
            "same element ids",
          );
          for (const id of bMap.keys()) {
            const diffs = propDiffs(bMap.get(id)!, aMap.get(id)!);
            // reorder should not change meaningful props (index is ignored)
            assert.equal(
              diffs.length,
              0,
              `reorder should not change props of ${id}: ${JSON.stringify(diffs)}`,
            );
          }
          break;
        }
        case "group": {
          const b = bMap.get("box-a");
          const a = aMap.get("box-a");
          assert.ok(b && a);
          assert.equal(b.groupIds.length, 0);
          assert.ok(a.groupIds.length > 0, "box-a gains a groupId");
          const b2 = bMap.get("box-b");
          const a2 = aMap.get("box-b");
          assert.ok(b2 && a2);
          assert.deepEqual(a.groupIds, a2.groupIds);
          break;
        }
        default: {
          const _exhaustive: never = name;
          throw new Error(`unhandled pair ${_exhaustive}`);
        }
      }
    });
  }
});
