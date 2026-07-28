import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectReferencedFileIds,
  deterministicVersionNonce,
  formatMergeCommitMessage,
  MERGE_WORKER_DISABLED_MESSAGE,
  parseMergeQuery,
  prepareLocalElementsForMerge,
} from "./merge.js";

test("parseMergeQuery accepts common truthy forms", () => {
  assert.equal(parseMergeQuery(undefined), false);
  assert.equal(parseMergeQuery(""), false);
  assert.equal(parseMergeQuery("false"), false);
  assert.equal(parseMergeQuery("0"), false);
  assert.equal(parseMergeQuery("true"), true);
  assert.equal(parseMergeQuery("TRUE"), true);
  assert.equal(parseMergeQuery("1"), true);
  assert.equal(parseMergeQuery("yes"), true);
  assert.equal(parseMergeQuery("on"), true);
  assert.equal(parseMergeQuery(true), true);
  assert.equal(parseMergeQuery(1), true);
});

test("formatMergeCommitMessage records both parents", () => {
  assert.equal(formatMergeCommitMessage("added queue", 2, 4), "added queue [merge: parents v2+v4]");
  assert.equal(formatMergeCommitMessage("  spaced  ", 0, 1), "spaced [merge: parents v0+v1]");
});

test("collectReferencedFileIds reads public fileId only", () => {
  assert.deepEqual(
    collectReferencedFileIds([
      { id: "a", type: "rectangle" },
      { id: "b", type: "image", fileId: "abc123" },
      { id: "c", type: "image", fileId: "def456" },
      { id: "d", type: "image", fileId: "abc123" },
      null,
      "skip",
    ]),
    ["abc123", "def456"],
  );
});

test("MERGE_WORKER_DISABLED_MESSAGE is actionable", () => {
  assert.match(MERGE_WORKER_DISABLED_MESSAGE, /RENDER_WORKER=on/);
  assert.match(MERGE_WORKER_DISABLED_MESSAGE, /--force|pull/i);
  assert.match(MERGE_WORKER_DISABLED_MESSAGE, /Hand-rolled merge/i);
});

test("deterministicVersionNonce is stable and non-zero", () => {
  const a = deterministicVersionNonce("api", 2);
  const b = deterministicVersionNonce("api", 2);
  const c = deterministicVersionNonce("api", 3);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a > 0 && a < 0x80000000);
});

/** Minimal element shape for prepareLocalElementsForMerge unit tests. */
function el(
  id: string,
  opts: {
    version?: number;
    versionNonce?: number;
    backgroundColor?: string;
    x?: number;
    isDeleted?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    id,
    type: "rectangle",
    x: opts.x ?? 0,
    y: 0,
    width: 100,
    height: 50,
    backgroundColor: opts.backgroundColor ?? "transparent",
    version: opts.version ?? 1,
    versionNonce: opts.versionNonce ?? 1,
    isDeleted: opts.isDeleted ?? false,
    seed: 1,
    updated: 1,
  };
}

test("prepareLocalElementsForMerge bumps hand-edited elements with stale version", () => {
  const parent = [
    el("api", { version: 1, versionNonce: 10, backgroundColor: "transparent" }),
    el("db", { x: 300, version: 1, versionNonce: 11 }),
  ];
  // Agent hand-edit: recolor API only, leave version/versionNonce alone.
  const local = [
    el("api", { version: 1, versionNonce: 10, backgroundColor: "#b2f2bb" }),
    el("db", { x: 300, version: 1, versionNonce: 11 }),
  ];

  const prepared = prepareLocalElementsForMerge(local, parent) as Array<Record<string, unknown>>;
  const byId = Object.fromEntries(prepared.map((e) => [e.id as string, e]));

  assert.equal(byId.api!.backgroundColor, "#b2f2bb");
  assert.equal(byId.api!.version, 2, "stale hand-edit must bump version");
  assert.equal(byId.api!.versionNonce, deterministicVersionNonce("api", 2));
  // Untouched DB: exact version fields preserved so remote can still win.
  assert.equal(byId.db!.version, 1);
  assert.equal(byId.db!.versionNonce, 11);
  assert.equal(byId.db!.x, 300);
});

test("prepareLocalElementsForMerge leaves already-bumped edits alone", () => {
  const parent = [el("a", { version: 1, versionNonce: 10, x: 0 })];
  const local = [el("a", { version: 5, versionNonce: 99, x: 7 })];
  const prepared = prepareLocalElementsForMerge(local, parent) as Array<Record<string, unknown>>;
  assert.equal(prepared[0]!.version, 5);
  assert.equal(prepared[0]!.versionNonce, 99);
  assert.equal(prepared[0]!.x, 7);
});

test("prepareLocalElementsForMerge injects soft-delete for hard deletes", () => {
  const parent = [
    el("keep", { version: 1, versionNonce: 1 }),
    el("gone", { version: 2, versionNonce: 5, x: 50 }),
  ];
  const local = [el("keep", { version: 1, versionNonce: 1 })];
  const prepared = prepareLocalElementsForMerge(local, parent) as Array<Record<string, unknown>>;
  const byId = Object.fromEntries(prepared.map((e) => [e.id as string, e]));
  assert.ok(byId.gone, "hard delete must become a soft-delete for reconcile");
  assert.equal(byId.gone!.isDeleted, true);
  assert.equal(byId.gone!.version, 3);
  assert.equal(byId.gone!.versionNonce, deterministicVersionNonce("gone", 3));
  assert.equal(byId.keep!.isDeleted, false);
});

test("prepareLocalElementsForMerge bumps soft-delete with stale version", () => {
  const parent = [el("a", { version: 1, versionNonce: 1 })];
  const local = [el("a", { version: 1, versionNonce: 1, isDeleted: true })];
  const prepared = prepareLocalElementsForMerge(local, parent) as Array<Record<string, unknown>>;
  assert.equal(prepared[0]!.isDeleted, true);
  assert.equal(prepared[0]!.version, 2);
});

test("prepareLocalElementsForMerge keeps client additions as-is", () => {
  const parent = [el("a", { version: 1, versionNonce: 1 })];
  const local = [
    el("a", { version: 1, versionNonce: 1 }),
    el("new", { version: 1, versionNonce: 42, x: 9 }),
  ];
  const prepared = prepareLocalElementsForMerge(local, parent) as Array<Record<string, unknown>>;
  const added = prepared.find((e) => e.id === "new")!;
  assert.equal(added.version, 1);
  assert.equal(added.versionNonce, 42);
  assert.equal(added.x, 9);
});

test("prepareLocalElementsForMerge is deterministic", () => {
  const parent = [el("a", { version: 1, versionNonce: 1, x: 0 })];
  const local = [el("a", { version: 1, versionNonce: 1, x: 10 })];
  const once = prepareLocalElementsForMerge(local, parent);
  const twice = prepareLocalElementsForMerge(local, parent);
  assert.deepEqual(once, twice);
});
