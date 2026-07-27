/**
 * On-disk cache for rendered scene exports (PNG/SVG).
 *
 * A version is immutable, so a given (sceneId, version, options, format)
 * pair is computed at most once and stored under DATA_DIR. Entries are
 * never invalidated for correctness — only deleted if the operator
 * clears the cache directory.
 *
 * Layout:
 *   <dataDir>/renders/<sceneId>/<version>/s{scale}_d{0|1}.{png|svg}
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Subdirectory of DATA_DIR holding render cache blobs. */
export const RENDERS_SUBDIR = "renders";

export type RenderFormat = "png" | "svg";

/** Normalized options that form part of the cache key. */
export type RenderCacheOptions = {
  /** Pixel scale (exportScale). Default 1. */
  scale: number;
  /** Dark-mode export. Default false. */
  dark: boolean;
};

export type RenderCacheKey = {
  sceneId: string;
  version: number;
  format: RenderFormat;
  options: RenderCacheOptions;
};

/**
 * Stable filename stem for options: `s1_d0`, `s2_d1`, `s0.5_d0`.
 * Scale is serialized without trailing zeros beyond necessity.
 */
export function optionsFileStem(options: RenderCacheOptions): string {
  const scale = formatScale(options.scale);
  const dark = options.dark ? "1" : "0";
  return `s${scale}_d${dark}`;
}

function formatScale(scale: number): string {
  // Avoid scientific notation; keep enough precision for common values.
  if (Number.isInteger(scale)) return String(scale);
  // Trim trailing zeros from fixed representation.
  return scale.toFixed(6).replace(/\.?0+$/, "");
}

/** Absolute path for a cache entry (may not exist yet). */
export function renderCachePath(dataDir: string, key: RenderCacheKey): string {
  const stem = optionsFileStem(key.options);
  return path.join(
    dataDir,
    RENDERS_SUBDIR,
    key.sceneId,
    String(key.version),
    `${stem}.${key.format}`,
  );
}

/**
 * Strong ETag for a cache key. Content is deterministic for immutable
 * versions, so the key itself is a valid etag source (no need to hash
 * the body on every hit).
 */
export function renderCacheEtag(key: RenderCacheKey): string {
  const raw = [
    key.sceneId,
    String(key.version),
    key.format,
    optionsFileStem(key.options),
  ].join("\0");
  const digest = createHash("sha1").update(raw).digest("hex");
  return `"${digest}"`;
}

/**
 * Disk-backed render cache. `get` / `put` are synchronous (small images;
 * keep the request path simple). Writes are atomic via temp+rename.
 */
export class RenderCache {
  readonly dataDir: string;
  readonly root: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.root = path.join(dataDir, RENDERS_SUBDIR);
  }

  pathFor(key: RenderCacheKey): string {
    return renderCachePath(this.dataDir, key);
  }

  has(key: RenderCacheKey): boolean {
    return existsSync(this.pathFor(key));
  }

  get(key: RenderCacheKey): Buffer | null {
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }

  /**
   * Store bytes for `key`. Idempotent: if the file already exists it is
   * left alone (first writer wins; content must be identical for a given
   * immutable key).
   */
  put(key: RenderCacheKey, bytes: Buffer | Uint8Array): void {
    const dest = this.pathFor(key);
    if (existsSync(dest)) return;

    const dir = path.dirname(dest);
    mkdirSync(dir, { recursive: true });

    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, bytes);
      try {
        renameSync(tmp, dest);
      } catch (err) {
        // Race: another process/request wrote first — treat as success.
        if (existsSync(dest)) {
          try {
            unlinkSync(tmp);
          } catch {
            // ignore
          }
          return;
        }
        throw err;
      }
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
