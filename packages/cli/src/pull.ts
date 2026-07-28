/**
 * `excali pull SLUG [-o file] [--version N]`
 * `excali pull --all -o dir/`
 *
 * Writes a `.excalidraw` file (or stdout with `-`) and records the pulled
 * version in local state so subsequent `push` can send parentVersion.
 *
 * `--all` is the no-lock-in escape hatch: plain `.excalidraw` files on disk
 * for every scene head (no version history in the files themselves).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import type { SceneInfo } from "./ls.js";
import { setPulledVersion } from "./state.js";

/** Minimal .excalidraw document shape from GET /scene. */
export type SceneDocument = {
  type?: string;
  version?: number;
  elements: unknown[];
  appState?: unknown;
  files?: unknown;
  [k: string]: unknown;
};

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }
}

function parsePullArgs(args: string[]): {
  slug?: string;
  output?: string;
  version?: number;
  all: boolean;
} {
  let values: {
    o?: string;
    output?: string;
    version?: string;
    all?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        o: { type: "string", short: "o" },
        output: { type: "string" },
        version: { type: "string" },
        all: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const all = values.all === true;
  const output = values.output ?? values.o;

  let version: number | undefined;
  if (values.version !== undefined) {
    if (!/^\d+$/.test(values.version.trim())) {
      throw new UsageError(
        `--version must be a non-negative integer, got ${JSON.stringify(values.version)}`,
      );
    }
    version = Number(values.version);
  }

  if (all) {
    if (positionals.length > 0) {
      throw new UsageError(
        `pull --all does not take a SLUG (got ${positionals.join(" ")})\n\n` +
          "Usage: excali pull --all -o dir/",
      );
    }
    if (version !== undefined) {
      throw new UsageError("pull --all does not accept --version (pulls each scene head)");
    }
    if (!output || output.trim().length === 0 || output === "-") {
      throw new UsageError(
        "pull --all requires -o DIR (a directory path, not -)\n\n" +
          "Usage: excali pull --all -o dir/",
      );
    }
    return { all: true, output: output.trim() };
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "pull requires SLUG (or --all)\n\n" +
        "Usage: excali pull SLUG [-o file] [--version N]\n" +
        "       excali pull --all -o dir/",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excali pull SLUG [-o file] [--version N]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("pull requires a non-empty SLUG");
  }

  return { slug, output, version, all: false };
}

function defaultOutputPath(slug: string): string {
  return `${slug}.excalidraw`;
}

async function pullOne(
  ctx: CommandContext,
  slug: string,
  opts: { output?: string; version?: number },
): Promise<{ slug: string; version: number; path: string }> {
  const server = ctx.config.server!;

  let version: number;
  if (opts.version !== undefined) {
    version = opts.version;
  } else {
    const meta = await apiFetch<SceneInfo>({
      path: `/api/scenes/${encodeURIComponent(slug)}`,
      method: "GET",
      config: ctx.config,
    });
    version = meta.headVersion;
  }

  const qs = opts.version !== undefined ? `?v=${encodeURIComponent(String(opts.version))}` : "";
  const scene = await apiFetch<SceneDocument>({
    path: `/api/scenes/${encodeURIComponent(slug)}/scene${qs}`,
    method: "GET",
    config: ctx.config,
  });

  const outPath = opts.output ?? defaultOutputPath(slug);
  const pretty = `${JSON.stringify(scene, null, 2)}\n`;

  if (outPath === "-") {
    setPulledVersion(ctx.cwd, server, slug, version);
    // Caller handles stdout for single-slug "-" only.
    return { slug, version, path: "-" };
  }

  const abs = path.isAbsolute(outPath) ? outPath : path.join(ctx.cwd, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, pretty, "utf8");
  setPulledVersion(ctx.cwd, server, slug, version);
  return { slug, version, path: outPath };
}

async function runPullAll(ctx: CommandContext, outDir: string): Promise<CommandResult> {
  const list = await apiFetch<{ scenes: SceneInfo[] }>({
    path: "/api/scenes",
    method: "GET",
    config: ctx.config,
  });

  const dirAbs = path.isAbsolute(outDir) ? outDir : path.join(ctx.cwd, outDir);
  fs.mkdirSync(dirAbs, { recursive: true });

  const pulled: Array<{ slug: string; version: number; path: string }> = [];
  for (const scene of list.scenes) {
    const fileName = `${scene.slug}.excalidraw`;
    const rel = path.join(outDir, fileName);
    const abs = path.join(dirAbs, fileName);
    const result = await pullOne(ctx, scene.slug, { output: abs });
    pulled.push({
      slug: result.slug,
      version: result.version,
      path: rel,
    });
  }

  const data = {
    all: true as const,
    directory: outDir,
    count: pulled.length,
    scenes: pulled,
  };

  if (pulled.length === 0) {
    return {
      data,
      human: `No scenes on server; wrote nothing under ${outDir}\n`,
    };
  }

  const lines = [
    `Pulled ${pulled.length} scene(s) → ${outDir}/`,
    ...pulled.map((p) => `  ${p.slug} v${p.version} → ${p.path}`),
    "",
  ];
  return { data, human: lines.join("\n") };
}

async function runPull(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const parsed = parsePullArgs(ctx.args);

  if (parsed.all) {
    return runPullAll(ctx, parsed.output!);
  }

  const slug = parsed.slug!;
  const server = ctx.config.server!;

  let version: number;
  if (parsed.version !== undefined) {
    version = parsed.version;
  } else {
    const meta = await apiFetch<SceneInfo>({
      path: `/api/scenes/${encodeURIComponent(slug)}`,
      method: "GET",
      config: ctx.config,
    });
    version = meta.headVersion;
  }

  const qs = parsed.version !== undefined ? `?v=${encodeURIComponent(String(parsed.version))}` : "";
  const scene = await apiFetch<SceneDocument>({
    path: `/api/scenes/${encodeURIComponent(slug)}/scene${qs}`,
    method: "GET",
    config: ctx.config,
  });

  const outPath = parsed.output ?? defaultOutputPath(slug);
  const pretty = `${JSON.stringify(scene, null, 2)}\n`;

  if (outPath === "-") {
    setPulledVersion(ctx.cwd, server, slug, version);
    return {
      data: { slug, version, path: "-", scene },
      human: pretty,
    };
  }

  const abs = path.isAbsolute(outPath) ? outPath : path.join(ctx.cwd, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, pretty, "utf8");
  setPulledVersion(ctx.cwd, server, slug, version);

  return {
    data: { slug, version, path: outPath },
    human: `Pulled ${slug} v${version} → ${outPath}\n`,
  };
}

export const pullCommand: Command = {
  name: "pull",
  description: "Download a scene as .excalidraw (or all heads with --all) and record local state",
  usage:
    "excali pull SLUG [-o file] [--version N] [--json]\n" +
    "excali pull --all -o dir/ [--json]\n\n" +
    "  -o file       Output path (default: SLUG.excalidraw). Use - for stdout.\n" +
    "  --version N   Pull a specific version instead of head.\n" +
    "  --all -o dir  Write every scene head as plain .excalidraw files under dir/\n" +
    "                (no-lock-in escape hatch; works even if backup/history is broken).\n\n" +
    "Records the pulled version under .excalidraw-collab/state.json (per server).",
  run: runPull,
};
