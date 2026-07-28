/**
 * Cheap change-detection hash over an element array.
 *
 * `@excalidraw/excalidraw` exports `hashElementsVersion`, but that package is a
 * browser/React bundle and cannot be imported as a runtime dependency of
 * `packages/core` (which must keep zero runtime deps). The implementation
 * below is a line-for-line local mirror of upstream's function:
 *
 *   // @excalidraw/excalidraw@0.18.1 — element/index.ts
 *   hashElementsVersion = (elements) => {
 *     let hash = 5381;
 *     for (let i = 0; i < elements.length; i++) {
 *       hash = (hash << 5) + hash + elements[i].versionNonce;
 *     }
 *     return hash >>> 0;
 *   };
 *
 * It hashes each element's `versionNonce` with djb2; order matters.
 * Tests assert agreement with the real upstream export (loaded via the
 * fixture-generation browser shim).
 */

import type { ExcalidrawElement } from "./types.js";

/**
 * Hash of an element array for cheap "did anything change?" checks.
 * Mirrors upstream `hashElementsVersion` (djb2 over `versionNonce`, order-
 * sensitive). Returns an unsigned 32-bit integer.
 */
export function sceneHash(elements: readonly Pick<ExcalidrawElement, "versionNonce">[]): number {
  let hash = 5381;
  for (let i = 0; i < elements.length; i++) {
    // versionNonce is required on every ExcalidrawElement; treat missing as 0
    // only so a crash never escapes — malformed inputs should have been
    // rejected by normalizeScene before this runs.
    const nonce = elements[i]?.versionNonce ?? 0;
    hash = (hash << 5) + hash + nonce;
  }
  return hash >>> 0;
}
