/**
 * Dynamic Playwright loader.
 *
 * Playwright is an **optionalDependency** of this package so production
 * images can run `pnpm install --no-optional` and skip the browser stack.
 * This module is the single place that performs `import("playwright")`;
 * a missing package becomes a clean {@link RenderError} `NOT_INSTALLED`
 * rather than a raw `ERR_MODULE_NOT_FOUND`.
 */
import {
  PLAYWRIGHT_NOT_INSTALLED_MESSAGE,
  RenderError,
} from "./types.js";

export type PlaywrightModule = typeof import("playwright");

type PlaywrightImporter = () => Promise<PlaywrightModule>;

const defaultImporter: PlaywrightImporter = () => import("playwright");

let importer: PlaywrightImporter = defaultImporter;

/**
 * Override the Playwright dynamic import (tests only).
 * Pass `null` to restore the real `import("playwright")`.
 */
export function setPlaywrightImporterForTests(
  next: PlaywrightImporter | null,
): void {
  importer = next ?? defaultImporter;
}

/** Whether an error looks like a failed module resolution for `playwright`. */
export function isPlaywrightModuleNotFound(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    message?: string;
    cause?: unknown;
  };
  if (
    e.code === "ERR_MODULE_NOT_FOUND" ||
    e.code === "MODULE_NOT_FOUND"
  ) {
    const msg = typeof e.message === "string" ? e.message : "";
    // Node messages include the package name; be permissive if the code is
    // already a module-not-found (optional dep simply missing).
    if (msg === "" || /playwright/i.test(msg)) return true;
  }
  // Some bundlers / loaders wrap the original.
  if (e.cause !== undefined && e.cause !== err) {
    return isPlaywrightModuleNotFound(e.cause);
  }
  if (typeof e.message === "string" && /cannot find (package|module) ['"]playwright['"]/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Dynamically import Playwright. Throws {@link RenderError} with code
 * `NOT_INSTALLED` when the optional package is absent.
 */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await importer();
  } catch (err) {
    if (isPlaywrightModuleNotFound(err)) {
      throw new RenderError("NOT_INSTALLED", PLAYWRIGHT_NOT_INSTALLED_MESSAGE, {
        cause: err,
      });
    }
    throw err;
  }
}
