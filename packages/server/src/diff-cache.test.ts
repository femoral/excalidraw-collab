import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SceneDiff } from "@excalidraw-collab/core";
import { DiffCache, diffCacheKey } from "./diff-cache.js";

function emptyDiff(from: number, to: number): SceneDiff {
  return {
    from,
    to,
    summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
    elements: [],
    appState: [],
  };
}

describe("diffCacheKey", () => {
  test("is stable and distinguishes ends", () => {
    assert.equal(diffCacheKey("s1", 1, 2), diffCacheKey("s1", 1, 2));
    assert.notEqual(diffCacheKey("s1", 1, 2), diffCacheKey("s1", 2, 1));
    assert.notEqual(diffCacheKey("s1", 1, 2), diffCacheKey("s2", 1, 2));
  });
});

describe("DiffCache", () => {
  test("get returns undefined for a miss and the value after set", () => {
    const cache = new DiffCache(4);
    const key = diffCacheKey("scene-a", 1, 2);
    assert.equal(cache.get(key), undefined);
    const diff = emptyDiff(1, 2);
    cache.set(key, diff);
    assert.equal(cache.size, 1);
    assert.deepEqual(cache.get(key), diff);
  });

  test("evicts oldest entry when capacity is exceeded", () => {
    const cache = new DiffCache(2);
    cache.set("a", emptyDiff(0, 1));
    cache.set("b", emptyDiff(1, 2));
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.keys(), ["a", "b"]);

    cache.set("c", emptyDiff(2, 3));
    assert.equal(cache.size, 2);
    assert.equal(cache.has("a"), false, "oldest key a must be evicted");
    assert.equal(cache.has("b"), true);
    assert.equal(cache.has("c"), true);
  });

  test("get promotes a key to most-recently-used", () => {
    const cache = new DiffCache(2);
    cache.set("a", emptyDiff(0, 1));
    cache.set("b", emptyDiff(1, 2));
    // Touch a → a becomes MRU, b is oldest.
    assert.ok(cache.get("a"));
    cache.set("c", emptyDiff(2, 3));
    assert.equal(cache.has("b"), false, "untouched b is evicted");
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("c"), true);
  });

  test("set on an existing key updates without growing", () => {
    const cache = new DiffCache(2);
    cache.set("a", emptyDiff(0, 1));
    cache.set("a", emptyDiff(0, 9));
    assert.equal(cache.size, 1);
    assert.equal(cache.get("a")?.to, 9);
  });

  test("rejects non-positive maxSize", () => {
    assert.throws(() => new DiffCache(0));
    assert.throws(() => new DiffCache(-1));
  });
});
