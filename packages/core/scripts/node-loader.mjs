/**
 * Custom Node ESM loader so we can import the browser-oriented
 * `@excalidraw/excalidraw@0.18.1` bundle under plain Node for fixture generation.
 *
 * Handles:
 *  - JSON modules without `with { type: "json" }` (open-color)
 *  - CSS imports → empty module
 *  - extensionless relative imports (roughjs/bin/rough)
 *  - dual packages whose CJS entry breaks named ESM imports (laser-pointer → ESM)
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, extname } from "node:path";
import { createRequire } from "node:module";

const EXTS = [".js", ".mjs", ".cjs", ".json"];
const require = createRequire(import.meta.url);

/** Prefer ESM builds for dual packages that fail named CJS export analysis. */
const ESM_OVERRIDES = {
  "@excalidraw/laser-pointer": "dist/esm.js",
};

function tryWithExt(url) {
  if (url.startsWith("node:") || url.startsWith("data:")) return null;
  let path;
  try {
    path = fileURLToPath(url);
  } catch {
    return null;
  }
  if (existsSync(path) || extname(path)) return null;
  for (const ext of EXTS) {
    if (existsSync(path + ext)) return pathToFileURL(path + ext).href;
    if (existsSync(join(path, "index" + ext))) {
      return pathToFileURL(join(path, "index" + ext)).href;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css") || /\.css(\?|$)/.test(specifier)) {
    return { url: "data:text/javascript,export default {};", shortCircuit: true };
  }

  if (ESM_OVERRIDES[specifier]) {
    try {
      const paths = context.parentURL
        ? [fileURLToPath(new URL(".", context.parentURL))]
        : undefined;
      const pkgJsonPath = require.resolve(`${specifier}/package.json`, { paths });
      const esmPath = join(dirname(pkgJsonPath), ESM_OVERRIDES[specifier]);
      if (existsSync(esmPath)) {
        return { url: pathToFileURL(esmPath).href, shortCircuit: true };
      }
    } catch {
      /* fall through to default resolve */
    }
  }

  try {
    const resolved = await nextResolve(specifier, context);
    const fixed = tryWithExt(resolved.url);
    if (fixed) return { ...resolved, url: fixed };
    return resolved;
  } catch (err) {
    if (
      (err.code === "ERR_MODULE_NOT_FOUND" ||
        err.code === "ERR_UNSUPPORTED_DIR_IMPORT") &&
      !extname(specifier.split("?")[0]) &&
      !specifier.endsWith("/")
    ) {
      try {
        return await nextResolve(`${specifier}.js`, context);
      } catch {
        /* rethrow original */
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  try {
    const path = fileURLToPath(url);
    if (path.endsWith(".json") && existsSync(path)) {
      return {
        format: "json",
        shortCircuit: true,
        source: readFileSync(path, "utf8"),
      };
    }
  } catch {
    /* not a file URL */
  }
  if (url.endsWith(".css")) {
    return { format: "module", shortCircuit: true, source: "export default {};" };
  }
  return nextLoad(url, context);
}
