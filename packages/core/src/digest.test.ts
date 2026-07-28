import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  digestScene,
  formatDigest,
  resolveElementLabel,
  DEFAULT_DIGEST_MAX_ELEMENTS,
} from "./digest.js";
import type { ExcalidrawElement, SceneDocument } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");

function loadFixture(name: string): SceneDocument {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as {
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

/** Minimal synthetic element — only fields the digest reads. */
function el(
  partial: Partial<ExcalidrawElement> &
    Pick<ExcalidrawElement, "id" | "type" | "x" | "y" | "width" | "height">,
): ExcalidrawElement {
  return {
    angle: 0,
    strokeColor: "#000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...partial,
  } as ExcalidrawElement;
}

describe("digestScene", () => {
  test("empty scene", () => {
    const doc = loadFixture("empty.excalidraw");
    const d = digestScene(doc);
    assert.equal(d.elementCount, 0);
    assert.deepEqual(d.countsByType, {});
    assert.equal(d.bbox, null);
    assert.equal(d.frameCount, 0);
    assert.equal(d.truncated, false);
    assert.equal(d.omitted, 0);
    assert.deepEqual(d.frames, []);
    assert.deepEqual(d.groups, []);
    assert.deepEqual(d.edges, []);
    assert.deepEqual(d.elements, []);
  });

  test("frames fixture: hierarchy + labels", () => {
    const doc = loadFixture("frames.excalidraw");
    const d = digestScene(doc);

    assert.equal(d.elementCount, 4);
    assert.equal(d.frameCount, 1);
    assert.equal(d.frames.length, 1);
    assert.equal(d.frames[0]!.name, "Pipeline");
    assert.equal(d.frames[0]!.id, "frame-main");
    // children: listable only (rect + ellipse), not the bound text
    assert.deepEqual(d.frames[0]!.children.slice().sort(), ["child-ellipse", "child-rect"]);

    // Bound text is counted but not listed separately
    assert.equal(d.countsByType["text"], 1);
    assert.equal(d.countsByType["frame"], 1);
    assert.equal(d.countsByType["rectangle"], 1);
    assert.equal(d.countsByType["ellipse"], 1);

    const worker = d.elements.find((e) => e.id === "child-rect");
    assert.ok(worker);
    assert.equal(worker!.label, "Worker");
    assert.equal(worker!.frameId, "frame-main");

    // Bound text must not appear as its own listable element
    assert.ok(!d.elements.some((e) => e.type === "text"));
  });

  test("arrows-bound: edges with resolved endpoint labels", () => {
    const doc = loadFixture("arrows-bound.excalidraw");
    const d = digestScene(doc);

    assert.equal(d.edges.length, 2);
    // Spatial order of arrows is stable
    const labels = d.edges.map((e) => `${e.from}→${e.to}`).sort();
    assert.deepEqual(labels, ["API→Cache", "API→DB"]);

    // Arrows are not in the flat element listing
    assert.ok(!d.elements.some((e) => e.type === "arrow"));
    // Nodes have labels
    const api = d.elements.find((e) => e.id === "node-api");
    assert.equal(api?.label, "API");
  });

  test("bound-text: container labels resolve", () => {
    const doc = loadFixture("bound-text.excalidraw");
    const d = digestScene(doc);
    const auth = d.elements.find((e) => e.id === "container-auth");
    const cache = d.elements.find((e) => e.id === "container-cache");
    assert.equal(auth?.label, "Auth Service");
    assert.equal(cache?.label, "Cache");
    assert.ok(!d.elements.some((e) => e.type === "text"));
  });

  test("group pair: groups section lists members", () => {
    const doc = loadFixture("pairs/group.after.excalidraw");
    const d = digestScene(doc);
    assert.ok(d.groups.length >= 1);
    const g = d.groups.find((x) => x.groupId === "group-ab-fixture");
    assert.ok(g);
    assert.ok(g!.members.includes("box-a"));
    assert.ok(g!.members.includes("box-b"));
    assert.ok(!g!.members.includes("box-c"));
  });

  test("simple-shapes: spatial order top-to-bottom left-to-right", () => {
    const doc = loadFixture("simple-shapes.excalidraw");
    const d = digestScene(doc);
    // All shapes at y=100 (rect, ellipse, diamond) then text at y=220
    const ids = d.elements.map((e) => e.id);
    assert.deepEqual(ids, ["rect-1", "ellipse-1", "diamond-1", "text-standalone"]);
  });

  test("deterministic: same input → byte-identical digest + text", () => {
    const doc = loadFixture("arrows-bound.excalidraw");
    const a = digestScene(doc);
    const b = digestScene(doc);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(formatDigest(a), formatDigest(b));
  });

  test("deterministic: ordering ignores input array order", () => {
    const doc = loadFixture("simple-shapes.excalidraw");
    const reversed: SceneDocument = {
      ...doc,
      elements: [...doc.elements].reverse(),
    };
    const shuffled: SceneDocument = {
      ...doc,
      elements: [doc.elements[2]!, doc.elements[0]!, doc.elements[3]!, doc.elements[1]!],
    };
    const base = digestScene(doc);
    assert.equal(JSON.stringify(digestScene(reversed)), JSON.stringify(base));
    assert.equal(JSON.stringify(digestScene(shuffled)), JSON.stringify(base));
    assert.equal(formatDigest(digestScene(reversed)), formatDigest(base));
  });

  test("deterministic: equal position tie-breaks by id", () => {
    const a = el({ id: "z-last", type: "rectangle", x: 0, y: 0, width: 10, height: 10 });
    const b = el({ id: "a-first", type: "ellipse", x: 0, y: 0, width: 10, height: 10 });
    const c = el({ id: "m-mid", type: "diamond", x: 0, y: 0, width: 10, height: 10 });
    const d1 = digestScene({ elements: [a, b, c] });
    const d2 = digestScene({ elements: [c, a, b] });
    assert.deepEqual(
      d1.elements.map((e) => e.id),
      ["a-first", "m-mid", "z-last"],
    );
    assert.equal(JSON.stringify(d1), JSON.stringify(d2));
  });

  test("skips isDeleted elements", () => {
    const live = el({ id: "live", type: "rectangle", x: 0, y: 0, width: 10, height: 10 });
    const dead = el({
      id: "dead",
      type: "rectangle",
      x: 50,
      y: 50,
      width: 10,
      height: 10,
      isDeleted: true,
    });
    const d = digestScene({ elements: [live, dead] });
    assert.equal(d.elementCount, 1);
    assert.equal(d.elements.length, 1);
    assert.equal(d.elements[0]!.id, "live");
  });

  test("truncation: caps element listing, keeps full edge list", () => {
    // 30 listable rects + 5 arrows → cap listable at 10, edges stay 5
    const rects: ExcalidrawElement[] = [];
    for (let i = 0; i < 30; i++) {
      rects.push(
        el({
          id: `r${String(i).padStart(2, "0")}`,
          type: "rectangle",
          x: (i % 10) * 20,
          y: Math.floor(i / 10) * 20,
          width: 15,
          height: 15,
          versionNonce: 1000 + i,
        }),
      );
    }
    const arrows: ExcalidrawElement[] = [];
    for (let i = 0; i < 5; i++) {
      arrows.push(
        el({
          id: `a${i}`,
          type: "arrow",
          x: 0,
          y: 200 + i,
          width: 40,
          height: 0,
          versionNonce: 2000 + i,
          startBinding: { elementId: `r${String(i).padStart(2, "0")}`, focus: 0, gap: 1 },
          endBinding: {
            elementId: `r${String(i + 1).padStart(2, "0")}`,
            focus: 0,
            gap: 1,
          },
        } as Partial<ExcalidrawElement> &
          Pick<ExcalidrawElement, "id" | "type" | "x" | "y" | "width" | "height">),
      );
    }
    const doc: SceneDocument = {
      elements: [...rects, ...arrows],
      appState: {},
      files: {},
    };
    const d = digestScene(doc, { maxElements: 10 });
    assert.equal(d.truncated, true);
    assert.equal(d.elements.length, 10);
    assert.equal(d.omitted, 20);
    assert.equal(d.edges.length, 5); // full edge list
    assert.equal(d.elementCount, 35); // all live

    const text = formatDigest(d);
    assert.match(text, /listing capped/);
    assert.match(text, /omitted 20/);
    assert.match(text, /^edges:/m);
    // all 5 edges present in text
    const edgeLines = text.split("\n").filter((l) => l.includes("→"));
    assert.equal(edgeLines.length, 5);
  });

  test("accepts bare element array", () => {
    const doc = loadFixture("simple-shapes.excalidraw");
    const fromArr = digestScene(doc.elements);
    const fromDoc = digestScene(doc);
    assert.equal(JSON.stringify(fromArr), JSON.stringify(fromDoc));
  });

  test("DEFAULT_DIGEST_MAX_ELEMENTS is positive", () => {
    assert.ok(DEFAULT_DIGEST_MAX_ELEMENTS >= 50);
  });
});

describe("formatDigest", () => {
  test("frames fixture renders a readable hierarchy", () => {
    const doc = loadFixture("frames.excalidraw");
    const text = formatDigest(digestScene(doc));

    // Exact rendering for the report — lock readability.
    const expected =
      [
        "4 elements · ellipse:1 frame:1 rectangle:1 text:1 · 1 frame · bbox (130,130 260x100)",
        "",
        "frames:",
        '  frame "Pipeline"  (130,130 260x100)',
        '    rectangle "Worker"  (140,140 120x60)',
        "    ellipse  (300,140 80x80)",
      ].join("\n") + "\n";

    // Allow the free-elements section to be absent (all kids are in the frame).
    // Print actual on mismatch for easier debugging.
    assert.equal(text, expected, `actual:\n${text}`);
  });

  test("no ids unless verbose", () => {
    const doc = loadFixture("frames.excalidraw");
    const plain = formatDigest(digestScene(doc));
    const verbose = formatDigest(digestScene(doc), { verbose: true });
    assert.ok(!plain.includes("frame-main"));
    assert.ok(!plain.includes("child-rect"));
    assert.ok(verbose.includes("id=frame-main"));
    assert.ok(verbose.includes("id=child-rect"));
  });

  test("arrows render as labeled edges", () => {
    const doc = loadFixture("arrows-bound.excalidraw");
    const text = formatDigest(digestScene(doc));
    assert.match(text, /edges:/);
    assert.match(text, /"API" → "DB"/);
    assert.match(text, /"API" → "Cache"/);
    // no raw element ids
    assert.ok(!text.includes("node-api"));
    assert.ok(!text.includes("arrow-api"));
  });

  test("empty scene is a single summary line", () => {
    const text = formatDigest(digestScene(loadFixture("empty.excalidraw")));
    assert.equal(text, "0 elements\n");
  });

  test("byte-identical across calls", () => {
    const d = digestScene(loadFixture("with-image.excalidraw"));
    assert.equal(formatDigest(d), formatDigest(d));
  });
});

describe("resolveElementLabel", () => {
  test("text / frame / bound-text", () => {
    const text = el({
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: "Hello",
      containerId: "r1",
    } as Partial<ExcalidrawElement> &
      Pick<ExcalidrawElement, "id" | "type" | "x" | "y" | "width" | "height">);
    const rect = el({
      id: "r1",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      boundElements: [{ type: "text", id: "t1" }],
    });
    const frame = el({
      id: "f1",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      name: "Stage",
    } as Partial<ExcalidrawElement> &
      Pick<ExcalidrawElement, "id" | "type" | "x" | "y" | "width" | "height">);
    const byId = new Map<string, ExcalidrawElement>([
      ["t1", text],
      ["r1", rect],
      ["f1", frame],
    ]);
    assert.equal(resolveElementLabel(text, byId), "Hello");
    assert.equal(resolveElementLabel(rect, byId), "Hello");
    assert.equal(resolveElementLabel(frame, byId), "Stage");
  });
});
