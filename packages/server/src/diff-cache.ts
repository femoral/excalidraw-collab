/**
 * Bounded LRU cache for scene diffs.
 *
 * Diffs are keyed by `(sceneId, from, to)` and are immutable once both
 * versions exist — entries never need invalidation for correctness. The
 * bound prevents unbounded growth when clients probe many pairs.
 */

import type { SceneDiff } from "@excalidraw-collab/core";

/** Default max entries kept in memory per process. */
export const DEFAULT_DIFF_CACHE_MAX = 256;

/**
 * Build the cache key for a diff between two absolute version numbers.
 * Versions are integers (0 = empty base, 1..head = committed versions).
 */
export function diffCacheKey(sceneId: string, from: number, to: number): string {
  return `${sceneId}\0${from}\0${to}`;
}

/**
 * Insertion-order LRU via `Map`: on hit, re-insert to move to the end;
 * on overflow, delete the oldest key (first insertion-order entry).
 */
export class DiffCache {
  private readonly map = new Map<string, SceneDiff>();
  readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_DIFF_CACHE_MAX) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(`DiffCache maxSize must be a positive integer, got ${maxSize}`);
    }
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.map.size;
  }

  /** Current keys in LRU order (oldest first). Useful for tests. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): SceneDiff | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Promote to most-recently-used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: SceneDiff): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
