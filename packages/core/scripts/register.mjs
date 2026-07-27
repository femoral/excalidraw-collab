/**
 * Entry-point import for the fixture generator:
 *   node --import ./scripts/register.mjs ./scripts/generate-fixtures.mjs
 *
 * Registers the custom ESM loader, then applies browser shims.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(join(here, "node-loader.mjs"), pathToFileURL("./"));

// Side-effect: install browser globals before generate-fixtures imports excalidraw
await import("./browser-shim.mjs");
