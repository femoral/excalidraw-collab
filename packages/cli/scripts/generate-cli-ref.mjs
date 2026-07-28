#!/usr/bin/env node
/**
 * Write docs/cli.md from the compiled command registry.
 *
 * Prerequisites: `pnpm --filter @excalidraw-collab/cli build` (or root `pnpm build`).
 *
 * Usage (from repo root or this package):
 *   pnpm --filter @excalidraw-collab/cli generate-cli-ref
 *   node packages/cli/scripts/generate-cli-ref.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const distEntry = path.join(packageRoot, "dist", "cli-ref.js");

if (!fs.existsSync(distEntry)) {
  console.error(
    "packages/cli/dist/cli-ref.js not found. Build first:\n" +
      "  pnpm --filter @excalidraw-collab/cli build",
  );
  process.exit(1);
}

const { generateCliReference, CLI_REF_RELATIVE_PATH, cliRefPath } = await import(distEntry);

const outPath = cliRefPath(repoRoot);
const body = generateCliReference();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body, "utf8");

console.log(`Wrote ${path.relative(repoRoot, outPath)} (${body.length} bytes)`);
console.log(`  source: command registry (CLI_REF_RELATIVE_PATH=${CLI_REF_RELATIVE_PATH})`);
