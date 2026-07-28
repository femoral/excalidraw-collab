/**
 * Unit tests for the on-disk render cache key/path helpers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  optionsFileStem,
  RenderCache,
  renderCacheEtag,
  renderCachePath,
  RENDERS_SUBDIR,
} from "./render-cache.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-rcache-"));
  tempDirs.push(dir);
  return dir;
}

describe("render-cache", () => {
  test("optionsFileStem encodes scale and dark", () => {
    assert.equal(optionsFileStem({ scale: 1, dark: false }), "s1_d0");
    assert.equal(optionsFileStem({ scale: 2, dark: true }), "s2_d1");
    assert.equal(optionsFileStem({ scale: 0.5, dark: false }), "s0.5_d0");
  });

  test("renderCachePath nests under renders/<sceneId>/<version>/", () => {
    const p = renderCachePath("/data", {
      sceneId: "abc",
      version: 3,
      format: "png",
      options: { scale: 1, dark: false },
    });
    assert.equal(p, path.join("/data", RENDERS_SUBDIR, "abc", "3", "s1_d0.png"));
  });

  test("etag is stable for the same key and differs when options change", () => {
    const base = {
      sceneId: "s1",
      version: 1,
      format: "png" as const,
      options: { scale: 1, dark: false },
    };
    assert.equal(renderCacheEtag(base), renderCacheEtag({ ...base }));
    assert.notEqual(
      renderCacheEtag(base),
      renderCacheEtag({ ...base, options: { scale: 2, dark: false } }),
    );
    assert.notEqual(renderCacheEtag(base), renderCacheEtag({ ...base, format: "svg" }));
    assert.match(renderCacheEtag(base), /^"[0-9a-f]{40}"$/);
  });

  test("put then get round-trips bytes; second put is a no-op", () => {
    const dir = tempDir();
    const cache = new RenderCache(dir);
    const key = {
      sceneId: "scene-1",
      version: 2,
      format: "png" as const,
      options: { scale: 1, dark: false },
    };
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);

    assert.equal(cache.has(key), false);
    assert.equal(cache.get(key), null);

    cache.put(key, bytes);
    assert.equal(cache.has(key), true);
    assert.deepEqual(cache.get(key), bytes);
    assert.ok(existsSync(cache.pathFor(key)));

    // Overwrite with different bytes must not replace (first writer wins).
    cache.put(key, Buffer.from("other"));
    assert.deepEqual(cache.get(key), bytes);
    assert.deepEqual(readFileSync(cache.pathFor(key)), bytes);
  });
});
