/**
 * `excalicli pull SLUG [-o file] [--version N]`
 *
 * Writes a `.excalidraw` file (or stdout with `-`) and records the pulled
 * version in local state so subsequent `push` can send parentVersion.
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
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

function parsePullArgs(args: string[]): {
  slug: string;
  output?: string;
  version?: number;
} {
  let values: { o?: string; output?: string; version?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        o: { type: "string", short: "o" },
        output: { type: "string" },
        version: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as {
      o?: string;
      output?: string;
      version?: string;
    };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "pull requires SLUG\n\nUsage: excalicli pull SLUG [-o file] [--version N]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excalicli pull SLUG [-o file] [--version N]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("pull requires a non-empty SLUG");
  }

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

  return { slug, output, version };
}

function defaultOutputPath(slug: string): string {
  return `${slug}.excalidraw`;
}

async function runPull(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, output, version: requestedVersion } = parsePullArgs(ctx.args);
  const server = ctx.config.server!;

  // Resolve which version we are pulling so we can record it in local state.
  // GET /scene does not return the version number in the body.
  let version: number;
  if (requestedVersion !== undefined) {
    version = requestedVersion;
  } else {
    const meta = await apiFetch<SceneInfo>({
      path: `/api/scenes/${encodeURIComponent(slug)}`,
      method: "GET",
      config: ctx.config,
    });
    version = meta.headVersion;
  }

  const qs =
    requestedVersion !== undefined
      ? `?v=${encodeURIComponent(String(requestedVersion))}`
      : "";
  const scene = await apiFetch<SceneDocument>({
    path: `/api/scenes/${encodeURIComponent(slug)}/scene${qs}`,
    method: "GET",
    config: ctx.config,
  });

  // Record before writing so a write failure still... actually write first?
  // Prefer: write file, then record — if write fails, state stays old.
  const outPath = output ?? defaultOutputPath(slug);
  const pretty = `${JSON.stringify(scene, null, 2)}\n`;

  if (outPath === "-") {
    setPulledVersion(ctx.cwd, server, slug, version);
    const data = {
      slug,
      version,
      path: "-",
      scene,
    };
    return {
      data,
      // Human mode: the file content itself on stdout (agent can pipe it).
      human: pretty,
    };
  }

  const abs = path.isAbsolute(outPath) ? outPath : path.join(ctx.cwd, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, pretty, "utf8");
  setPulledVersion(ctx.cwd, server, slug, version);

  const data = {
    slug,
    version,
    path: outPath,
  };

  return {
    data,
    human: `Pulled ${slug} v${version} → ${outPath}\n`,
  };
}

export const pullCommand: Command = {
  name: "pull",
  description:
    "Download a scene as .excalidraw and record the version in local state",
  usage:
    "excalicli pull SLUG [-o file] [--version N] [--json]\n\n" +
    "  -o file     Output path (default: SLUG.excalidraw). Use - for stdout.\n" +
    "  --version N Pull a specific version instead of head.\n" +
    "Records the pulled version under .excalidraw-collab/state.json (per server).",
  run: runPull,
};
