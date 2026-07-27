/**
 * postMessage protocol shared with packages/web RenderPage.
 * Keep string values in lockstep with web/src/render-logic.ts.
 */

export const RENDER_MSG = {
  READY: "excalidraw-collab:render-ready",
  REQUEST: "excalidraw-collab:render-request",
  RESPONSE: "excalidraw-collab:render-response",
  SKELETON_REQUEST: "excalidraw-collab:skeleton-request",
  SKELETON_RESPONSE: "excalidraw-collab:skeleton-response",
} as const;

export type PageRenderRequest = {
  type: typeof RENDER_MSG.REQUEST;
  id: string;
  format: "png" | "svg";
  scene: {
    elements: readonly unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown> | null;
  };
  options?: {
    scale?: number;
    background?: boolean;
    darkMode?: boolean;
    padding?: number;
  };
};

export type PageRenderResponse =
  | {
      type: typeof RENDER_MSG.RESPONSE;
      id: string;
      ok: true;
      mimeType: string;
      data: string;
    }
  | {
      type: typeof RENDER_MSG.RESPONSE;
      id: string;
      ok: false;
      error: string;
    };

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
