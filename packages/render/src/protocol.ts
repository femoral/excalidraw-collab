/**
 * postMessage protocol shared with packages/web RenderPage.
 * Keep string values in lockstep with web/src/render-logic.ts.
 *
 * Three request kinds coexist on one page:
 *   1. PNG/SVG export     — RENDER_MSG.REQUEST, op "export" (or omitted)
 *   2. Server-side merge  — RENDER_MSG.REQUEST, op "merge"
 *   3. Skeleton convert   — RENDER_MSG.SKELETON_REQUEST
 */

export const RENDER_MSG = {
  READY: "excalidraw-collab:render-ready",
  REQUEST: "excalidraw-collab:render-request",
  RESPONSE: "excalidraw-collab:render-response",
  SKELETON_REQUEST: "excalidraw-collab:skeleton-request",
  SKELETON_RESPONSE: "excalidraw-collab:skeleton-response",
} as const;

/** Scene payload shipped into the page for export. */
export type PageScenePayload = {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown> | null;
};

/** PNG/SVG export request (default when `op` is omitted). */
export type PageExportRequest = {
  type: typeof RENDER_MSG.REQUEST;
  id: string;
  /** Default `"export"` when omitted — keeps older workers/pages compatible. */
  op?: "export";
  format: "png" | "svg";
  scene: PageScenePayload;
  options?: {
    scale?: number;
    background?: boolean;
    darkMode?: boolean;
    padding?: number;
  };
};

/**
 * Server-side merge via upstream `restoreElements` + `reconcileElements`.
 * Runs in the browser page (same pool as export) — never hand-rolled.
 */
export type PageMergeRequest = {
  type: typeof RENDER_MSG.REQUEST;
  id: string;
  op: "merge";
  /** Local (client) elements — the side "merge into mine" keeps preferred. */
  local: { elements: readonly unknown[] };
  /** Remote (server head) elements. */
  remote: { elements: readonly unknown[] };
  /**
   * AppState passed as the third arg to `reconcileElements` (editing-state
   * checks). Server-side merges typically pass `{}` so pure version rules apply.
   */
  appState?: Record<string, unknown>;
};

export type PageRenderRequest = PageExportRequest | PageMergeRequest;

export type PageExportResponseOk = {
  type: typeof RENDER_MSG.RESPONSE;
  id: string;
  ok: true;
  mimeType: string;
  data: string;
};

export type PageMergeResponseOk = {
  type: typeof RENDER_MSG.RESPONSE;
  id: string;
  ok: true;
  elements: unknown[];
};

export type PageRenderResponseErr = {
  type: typeof RENDER_MSG.RESPONSE;
  id: string;
  ok: false;
  error: string;
};

export type PageRenderResponse = PageExportResponseOk | PageMergeResponseOk | PageRenderResponseErr;

export type PageSkeletonRequest = {
  type: typeof RENDER_MSG.SKELETON_REQUEST;
  id: string;
  elements: readonly unknown[];
  regenerateIds?: boolean;
};

export type PageSkeletonResponse =
  | {
      type: typeof RENDER_MSG.SKELETON_RESPONSE;
      id: string;
      ok: true;
      elements: unknown[];
    }
  | {
      type: typeof RENDER_MSG.SKELETON_RESPONSE;
      id: string;
      ok: false;
      error: string;
      index?: number;
      reason?: string;
    };
