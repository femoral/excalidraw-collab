/**
 * Pure helpers for version thumbnails (issue #30).
 *
 * On commit the editor renders a small PNG with upstream `exportToBlob` and
 * uploads it through the content-addressed file store. The scene list then
 * prefers that uploaded file over the render worker, and falls back to a
 * neutral placeholder when neither is available.
 *
 * Kept free of React / DOM so `node:test` covers the decision and sequencing
 * logic without a browser harness. Components stay thin around these helpers.
 */

// ---------------------------------------------------------------------------
// Export options for client-side thumbnail PNG
// ---------------------------------------------------------------------------

/** Small, list-friendly PNG export (no dark mode, modest scale). */
export const THUMBNAIL_EXPORT = {
  /** Pixel scale for exportToBlob / appState.exportScale. */
  scale: 0.5,
  /** Padding around the scene bbox (CSS px). */
  padding: 8,
  background: true,
  darkMode: false,
  mimeType: "image/png" as const,
} as const;

/**
 * AppState fragment for thumbnail export. Only sets export-related keys;
 * never invents element internals.
 */
export function buildThumbnailExportAppState(
  sceneAppState: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = sceneAppState ? { ...sceneAppState } : {};
  return {
    ...base,
    exportBackground: THUMBNAIL_EXPORT.background,
    exportWithDarkMode: THUMBNAIL_EXPORT.darkMode,
    exportScale: THUMBNAIL_EXPORT.scale,
  };
}

/**
 * Whether the snapshot is worth rendering a thumbnail for.
 * Empty / all-deleted scenes still get a tiny PNG (consistent cards); only
 * a completely missing elements array skips generation.
 */
export function shouldGenerateThumbnail(
  elements: readonly unknown[] | null | undefined,
): boolean {
  return Array.isArray(elements);
}

// ---------------------------------------------------------------------------
// Commit sequencing (upload thumb → attach on push; never block on failure)
// ---------------------------------------------------------------------------

/**
 * Ordered steps the editor runs on "Commit turn". Tests assert that the
 * thumbnail is uploaded *before* the scene commit and that a missing
 * thumbnail never aborts the push.
 */
export const COMMIT_THUMBNAIL_STEPS = [
  "flush_draft",
  "upload_scene_files",
  "export_thumbnail",
  "upload_thumbnail",
  "commit_scene",
] as const;

export type CommitThumbnailStep = (typeof COMMIT_THUMBNAIL_STEPS)[number];

/**
 * Result of the optional thumbnail leg of a commit. Failures are soft —
 * the commit proceeds without a thumbnail (scene list falls back).
 */
export type ThumbnailAttachResult =
  | { ok: true; fileId: string }
  | {
      ok: false;
      reason:
        | "skipped_empty"
        | "export_failed"
        | "upload_failed"
        | "not_attempted";
      error?: string;
    };

/**
 * Decide whether the commit body should carry `thumbnailFileId`.
 * Only a successful upload attaches; all other outcomes omit the field.
 */
export function thumbnailFileIdForCommit(
  result: ThumbnailAttachResult,
): string | undefined {
  return result.ok ? result.fileId : undefined;
}

/**
 * Merge an optional thumbnail into a commit body. Pure — no network.
 * When `fileId` is undefined/null the body is returned unchanged (no key).
 */
export function withThumbnailFileId<T extends Record<string, unknown>>(
  body: T,
  fileId: string | null | undefined,
): T & { thumbnailFileId?: string } {
  if (fileId === undefined || fileId === null || fileId === "") {
    return { ...body };
  }
  return { ...body, thumbnailFileId: fileId };
}

/**
 * Run the soft thumbnail leg: export → upload. Never throws.
 * Used by the editor around `exportToBlob` so commit still lands if export
 * or upload fails (agent path / empty canvas / transient network).
 */
export async function attachThumbnailForCommit(deps: {
  shouldGenerate: boolean;
  exportPng: () => Promise<Blob | ArrayBuffer | Uint8Array>;
  uploadPng: (
    bytes: ArrayBuffer,
  ) => Promise<{ fileId: string }>;
}): Promise<ThumbnailAttachResult> {
  if (!deps.shouldGenerate) {
    return { ok: false, reason: "skipped_empty" };
  }
  let bytes: ArrayBuffer;
  try {
    const raw = await deps.exportPng();
    bytes = await coerceToArrayBuffer(raw);
    if (bytes.byteLength === 0) {
      return { ok: false, reason: "export_failed", error: "empty PNG" };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "export_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const uploaded = await deps.uploadPng(bytes);
    if (!uploaded.fileId || uploaded.fileId.length === 0) {
      return { ok: false, reason: "upload_failed", error: "missing fileId" };
    }
    return { ok: true, fileId: uploaded.fileId };
  } catch (err) {
    return {
      ok: false,
      reason: "upload_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function coerceToArrayBuffer(
  raw: Blob | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) {
    // Copy into a fresh ArrayBuffer (avoids SharedArrayBuffer typing issues).
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    return copy.buffer;
  }
  // Blob (browser) — arrayBuffer() is standard.
  if (typeof (raw as Blob).arrayBuffer === "function") {
    return (raw as Blob).arrayBuffer();
  }
  throw new Error("unsupported PNG payload type");
}

// ---------------------------------------------------------------------------
// Scene-list three-way fallback
// ---------------------------------------------------------------------------

/**
 * Preferred source for a scene card preview, before any network I/O.
 * Order: uploaded thumbnail → render worker URL → placeholder.
 */
export type ThumbnailSource =
  | { kind: "uploaded"; fileId: string }
  | { kind: "render"; slug: string; version: number }
  | { kind: "placeholder" };

export type ThumbnailSceneInput = {
  slug: string;
  headVersion: number;
  thumbnailFileId: string | null | undefined;
};

/**
 * Pure resolution of which source the list should try first.
 * Does **not** call the render worker when an uploaded id is present —
 * that is the "no server render on human commit" guarantee.
 */
export function resolveThumbnailSource(
  scene: ThumbnailSceneInput,
): ThumbnailSource {
  const id = scene.thumbnailFileId;
  if (typeof id === "string" && id.length > 0) {
    return { kind: "uploaded", fileId: id };
  }
  if (
    typeof scene.headVersion === "number" &&
    Number.isFinite(scene.headVersion) &&
    scene.headVersion > 0
  ) {
    return { kind: "render", slug: scene.slug, version: scene.headVersion };
  }
  return { kind: "placeholder" };
}

/** Final display decision after fetch attempts. */
export type ThumbnailDisplay =
  | { kind: "image"; objectUrl: string; source: "uploaded" | "render" }
  | { kind: "placeholder" };

export type ThumbnailLoadDeps = {
  /** Fetch bytes for a content-addressed file id (Bearer auth). */
  getFileBytes: (fileId: string) => Promise<{
    bytes: ArrayBuffer;
    mimeType: string;
  }>;
  /**
   * Fetch a worker-rendered PNG for a scene version. Must reject (or return
   * a failure) when the worker is off/unavailable (501) or the scene cannot
   * be rendered — the chain then degrades to placeholder without erroring.
   */
  getRenderPng: (
    slug: string,
    version: number,
  ) => Promise<{ bytes: ArrayBuffer; mimeType: string }>;
  /**
   * Create an object URL from bytes (browser: URL.createObjectURL).
   * Injected so tests can avoid Blob/URL globals.
   */
  createObjectUrl: (bytes: ArrayBuffer, mimeType: string) => string;
};

/**
 * Load a displayable thumbnail for a resolved source.
 *
 * - `uploaded`: fetch file only — **never** calls getRenderPng.
 * - `render`: try worker; on any failure → placeholder (no throw).
 * - `placeholder`: immediate placeholder.
 */
export async function loadThumbnailDisplay(
  source: ThumbnailSource,
  deps: ThumbnailLoadDeps,
): Promise<ThumbnailDisplay> {
  if (source.kind === "placeholder") {
    return { kind: "placeholder" };
  }

  if (source.kind === "uploaded") {
    try {
      const file = await deps.getFileBytes(source.fileId);
      const objectUrl = deps.createObjectUrl(
        file.bytes,
        file.mimeType || "image/png",
      );
      return { kind: "image", objectUrl, source: "uploaded" };
    } catch {
      // Broken/missing uploaded blob: fall through to render for this head.
      // Caller re-resolves with a synthetic render source when needed; we
      // treat fetch failure as placeholder so list never errors.
      return { kind: "placeholder" };
    }
  }

  // source.kind === "render"
  try {
    const file = await deps.getRenderPng(source.slug, source.version);
    const objectUrl = deps.createObjectUrl(
      file.bytes,
      file.mimeType || "image/png",
    );
    return { kind: "image", objectUrl, source: "render" };
  } catch {
    // Worker off (501), missing Playwright, network error, empty scene, …
    return { kind: "placeholder" };
  }
}

/**
 * Full chain for a scene card: resolve source, then load.
 * When an uploaded thumbnail fetch fails, retries via render worker before
 * placeholder — covers a GC race or corrupt sidecar without failing the list.
 */
export async function loadSceneThumbnail(
  scene: ThumbnailSceneInput,
  deps: ThumbnailLoadDeps,
): Promise<ThumbnailDisplay> {
  const primary = resolveThumbnailSource(scene);

  if (primary.kind === "uploaded") {
    const first = await loadThumbnailDisplay(primary, deps);
    if (first.kind === "image") return first;
    // Uploaded id present but unreadable → try worker, then placeholder.
    if (scene.headVersion > 0) {
      return loadThumbnailDisplay(
        { kind: "render", slug: scene.slug, version: scene.headVersion },
        deps,
      );
    }
    return { kind: "placeholder" };
  }

  return loadThumbnailDisplay(primary, deps);
}

/** API path helpers (relative; auth client attaches Bearer). */
export function thumbnailFilePath(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}`;
}

export function thumbnailRenderPath(slug: string, version: number): string {
  return `/api/scenes/${encodeURIComponent(slug)}/render.png?v=${encodeURIComponent(String(version))}`;
}
