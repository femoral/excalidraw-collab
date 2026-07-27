/**
 * Pure helpers for the headless `/render` page.
 *
 * The page accepts export (PNG/SVG) and merge (reconcileElements) requests via
 * postMessage. Message types are namespaced so they never collide with
 * Excalidraw's own postMessage traffic.
 *
 * Keep RENDER_MSG string values in lockstep with packages/render/src/protocol.ts.
 */

export const RENDER_MSG = {
  READY: "excalidraw-collab:render-ready",
  REQUEST: "excalidraw-collab:render-request",
  RESPONSE: "excalidraw-collab:render-response",
} as const;

export type RenderFormat = "png" | "svg";

export type RenderExportOptions = {
  /** Pixel scale for PNG (and SVG exportScale). Default 1. */
  scale?: number;
  /** Include scene background. Default true. */
  background?: boolean;
  /** Dark-mode export. Default false. */
  darkMode?: boolean;
  /** Padding around the bounding box in CSS pixels. Default 10. */
  padding?: number;
};

/** Scene payload the worker posts into the page. */
export type RenderScenePayload = {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown> | null;
};

/** PNG/SVG export request (default when `op` is omitted). */
export type RenderExportRequestMessage = {
  type: typeof RENDER_MSG.REQUEST;
  id: string;
  op?: "export";
  format: RenderFormat;
  scene: RenderScenePayload;
  options?: RenderExportOptions;
};

/**
 * Merge request: restoreElements + reconcileElements(local, remote, appState).
 * Never invent conflict rules here — only call upstream public APIs.
 */
export type RenderMergeRequestMessage = {
  type: typeof RENDER_MSG.REQUEST;
  id: string;
  op: "merge";
  local: { elements: readonly unknown[] };
  remote: { elements: readonly unknown[] };
  appState?: Record<string, unknown>;
};

export type RenderRequestMessage =
  | RenderExportRequestMessage
  | RenderMergeRequestMessage;

export type RenderExportResponseOk = {
  type: typeof RENDER_MSG.RESPONSE;
  id: string;
  ok: true;
  mimeType: string;
  /** PNG: base64; SVG: full SVG markup string. */
  data: string;
};

export type RenderMergeResponseOk = {
  type: typeof RENDER_MSG.RESPONSE;
  id: string;
  ok: true;
  elements: unknown[];
};

export type RenderResponseErr = {
  type: typeof RENDER_MSG.RESPONSE;
  id: string;
  ok: false;
  error: string;
};

export type RenderResponseMessage =
  | RenderExportResponseOk
  | RenderMergeResponseOk
  | RenderResponseErr;

export type RenderReadyMessage = {
  type: typeof RENDER_MSG.READY;
};

/** Normalize export options with defaults. */
export function normalizeRenderOptions(
  options: RenderExportOptions | undefined,
): Required<RenderExportOptions> {
  const scale =
    options?.scale !== undefined && Number.isFinite(options.scale) && options.scale > 0
      ? options.scale
      : 1;
  const padding =
    options?.padding !== undefined &&
    Number.isFinite(options.padding) &&
    options.padding >= 0
      ? options.padding
      : 10;
  return {
    scale,
    background: options?.background !== false,
    darkMode: options?.darkMode === true,
    padding,
  };
}

/**
 * Build the appState fragment passed to upstream export helpers.
 * Only sets the export-relevant keys; never invents element internals.
 */
export function buildExportAppState(
  sceneAppState: Record<string, unknown> | undefined,
  options: Required<RenderExportOptions>,
): Record<string, unknown> {
  const base = sceneAppState ? { ...sceneAppState } : {};
  return {
    ...base,
    exportBackground: options.background,
    exportWithDarkMode: options.darkMode,
    exportScale: options.scale,
    // Match dark-mode export to the theme flag Excalidraw reads for styling.
    ...(options.darkMode ? { theme: "dark" } : {}),
  };
}

/** Drop deleted elements — export helpers expect non-deleted only. */
export function filterExportElements(
  elements: readonly unknown[],
): readonly unknown[] {
  return elements.filter((el) => {
    if (el === null || typeof el !== "object") return false;
    const rec = el as { isDeleted?: unknown };
    return rec.isDeleted !== true;
  });
}

function isElementsArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function isExportRequest(
  data: unknown,
): data is RenderExportRequestMessage {
  if (data === null || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  if (m.type !== RENDER_MSG.REQUEST) return false;
  if (typeof m.id !== "string" || m.id.length === 0) return false;
  // Merge requests are not export requests.
  if (m.op === "merge") return false;
  if (m.format !== "png" && m.format !== "svg") return false;
  if (m.scene === null || typeof m.scene !== "object") return false;
  const scene = m.scene as Record<string, unknown>;
  if (!Array.isArray(scene.elements)) return false;
  return true;
}

export function isMergeRequest(
  data: unknown,
): data is RenderMergeRequestMessage {
  if (data === null || typeof data !== "object") return false;
  const m = data as Record<string, unknown>;
  if (m.type !== RENDER_MSG.REQUEST) return false;
  if (typeof m.id !== "string" || m.id.length === 0) return false;
  if (m.op !== "merge") return false;
  if (m.local === null || typeof m.local !== "object") return false;
  if (m.remote === null || typeof m.remote !== "object") return false;
  const local = m.local as Record<string, unknown>;
  const remote = m.remote as Record<string, unknown>;
  if (!isElementsArray(local.elements)) return false;
  if (!isElementsArray(remote.elements)) return false;
  return true;
}

/** Any structured render-page request (export or merge). */
export function isRenderRequest(data: unknown): data is RenderRequestMessage {
  return isExportRequest(data) || isMergeRequest(data);
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a data URL"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}
