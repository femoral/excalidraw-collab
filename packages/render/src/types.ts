/** Public types for the headless render worker. */

export type RenderFormat = "png" | "svg";

export type RenderOptions = {
  /** Pixel scale (exportScale). Default 1. */
  scale?: number;
  /** Include scene background. Default true. */
  background?: boolean;
  /** Dark-mode export. Default false. */
  darkMode?: boolean;
  /** Padding around the bounding box in CSS pixels. Default 10. */
  padding?: number;
};

/** Scene document the worker ships into the browser page. */
export type RenderScene = {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown> | null;
};

export type RenderRequest = {
  scene: RenderScene;
  format: RenderFormat;
  options?: RenderOptions;
};

export type RenderResult = {
  /** Raw PNG bytes or UTF-8 SVG markup. */
  bytes: Uint8Array;
  mimeType: "image/png" | "image/svg+xml";
  format: RenderFormat;
};

/** Input for server-side merge (upstream reconcileElements). */
export type MergeRequest = {
  local: { elements: readonly unknown[] };
  remote: { elements: readonly unknown[] };
  /**
   * Passed through as reconcileElements' appState. Prefer `{}` for pure
   * version/versionNonce resolution (no "currently editing" local bias).
   */
  appState?: Record<string, unknown>;
};

export type MergeResult = {
  elements: unknown[];
};

export type RenderWorkerOptions = {
  /**
   * Base URL of the web app that serves `/render` (e.g. `http://127.0.0.1:3000`).
   * Required — the worker never embeds the editor; it drives our own route.
   */
  baseUrl: string;
  /** Max concurrent pages in the pool. Default 2. */
  concurrency?: number;
  /** Per-render wall-clock timeout in ms. Default 30_000. */
  renderTimeoutMs?: number;
  /**
   * Close the browser after this many ms of idle (no in-flight renders).
   * Default 10 minutes. Set 0 to disable idle shutdown.
   */
  idleTimeoutMs?: number;
  /** Headless Chromium launch args (extra). */
  launchArgs?: string[];
};

export type RenderWorker = {
  /** Render a scene to PNG or SVG. Lazily launches the browser on first call. */
  render(request: RenderRequest): Promise<RenderResult>;
  /**
   * Merge two element arrays via upstream `restoreElements` +
   * `reconcileElements` in the browser page. Same page pool as export.
   */
  merge(request: MergeRequest): Promise<MergeResult>;
  /** Shut down the browser and drain the pool. Safe to call multiple times. */
  close(): Promise<void>;
  /** True while a Chromium process is held open. */
  readonly isRunning: boolean;
};

/** Error thrown for clean, recoverable render failures. */
export class RenderError extends Error {
  readonly code:
    | "TIMEOUT"
    | "BROWSER_CLOSED"
    | "RENDER_FAILED"
    | "INVALID_REQUEST"
    | "DISABLED";

  constructor(
    code: RenderError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RenderError";
    this.code = code;
  }
}
