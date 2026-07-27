import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Resolve package root by walking up from a resolved entry (exports may hide package.json). */
function resolvePackageRoot(specifier: string): string {
  let dir = dirname(require.resolve(specifier));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find package root for ${specifier}`);
}

/**
 * Copy Excalidraw's production fonts into `public/fonts` so
 * `window.EXCALIDRAW_ASSET_PATH = "/"` resolves them locally (offline-safe).
 * Runs on both dev and build; fonts stay out of git.
 */
function copyExcalidrawFonts(): Plugin {
  const copy = () => {
    const pkgRoot = resolvePackageRoot("@excalidraw/excalidraw");
    const fontsSrc = resolve(pkgRoot, "dist/prod/fonts");
    const fontsDest = resolve(__dirname, "public/fonts");

    if (!existsSync(fontsSrc)) {
      throw new Error(
        `Excalidraw fonts not found at ${fontsSrc}. Is @excalidraw/excalidraw installed?`,
      );
    }

    rmSync(fontsDest, { recursive: true, force: true });
    mkdirSync(fontsDest, { recursive: true });
    cpSync(fontsSrc, fontsDest, { recursive: true });
  };

  return {
    name: "copy-excalidraw-fonts",
    buildStart() {
      copy();
    },
  };
}

const apiProxyTarget =
  process.env.API_PROXY_TARGET ?? process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), copyExcalidrawFonts()],
  server: {
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
