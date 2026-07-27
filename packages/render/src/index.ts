/**
 * @excalidraw-collab/render — optional headless Chromium export worker.
 *
 * Playwright is an **optionalDependency**: production images can
 * `pnpm install --no-optional` and never download the browser stack. It is
 * only *imported* when the worker is enabled and a render actually runs.
 * With `RENDER_WORKER=off` (default for the server), nothing from Playwright
 * is loaded. When Playwright is missing, callers get {@link RenderError}
 * with code `NOT_INSTALLED` — never a raw `ERR_MODULE_NOT_FOUND`.
 *
 * Usage:
 *   import { isRenderWorkerEnabled, openRenderWorker } from "@excalidraw-collab/render";
 *   if (isRenderWorkerEnabled()) {
 *     const worker = await openRenderWorker({ baseUrl });
 *     const png = await worker.render({ scene, format: "png" });
 *   }
 */

export {
  PLAYWRIGHT_NOT_INSTALLED_MESSAGE,
  RenderError,
  type MergeRequest,
  type MergeResult,
  type RenderFormat,
  type RenderOptions,
  type RenderRequest,
  type RenderResult,
  type RenderScene,
  type RenderWorker,
  type RenderWorkerOptions,
  type SkeletonConvertRequest,
  type SkeletonConvertResult,
} from "./types.js";

export {
  RENDER_MSG,
  type PageExportRequest,
  type PageMergeRequest,
  type PageRenderRequest,
  type PageRenderResponse,
} from "./protocol.js";

export {
  isPlaywrightModuleNotFound,
  loadPlaywright,
  setPlaywrightImporterForTests,
  type PlaywrightModule,
} from "./playwright-loader.js";

/**
 * Whether the render worker should be loaded for this process.
 *
 * Reads `RENDER_WORKER` from the environment (or an explicit mode).
 * Default is **off** — matching packages/server config — so local dev and
 * hosts without Chromium never pay for a browser launch.
 */
export function isRenderWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
  mode?: "on" | "off",
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  const raw = env.RENDER_WORKER;
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  // Unknown values: treat as off rather than crashing a host that only
  // wanted the HTTP API.
  return false;
}

/**
 * Open a render worker **only if enabled**.
 *
 * When disabled, returns `null` without importing Playwright. When enabled,
 * dynamically imports `./worker.js` (which pulls in Playwright) and creates
 * the worker.
 */
export async function openRenderWorker(
  options: import("./types.js").RenderWorkerOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<import("./types.js").RenderWorker | null> {
  if (!isRenderWorkerEnabled(env)) {
    return null;
  }
  const { createRenderWorker } = await import("./worker.js");
  return createRenderWorker(options);
}

/**
 * Always create a worker (dynamic import of Playwright). Use this when the
 * caller has already decided the worker is wanted (e.g. tests that set
 * RENDER_WORKER=on, or a server path that already checked the flag).
 *
 * Prefer {@link openRenderWorker} at the server boundary so `off` never loads
 * Playwright.
 */
export async function createRenderWorker(
  options: import("./types.js").RenderWorkerOptions,
): Promise<import("./worker.js").RenderWorkerHandle> {
  const { createRenderWorker: create } = await import("./worker.js");
  return create(options);
}
