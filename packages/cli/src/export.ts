/**
 * `excalicli export SLUG --format png|svg|json [--scale 2] [--dark] [--version N] [-o file]`
 *
 * PNG/SVG hit the server render endpoints; json fetches the scene document
 * (works even when the render worker is unavailable).
 *
 * Binary vs --json:
 * - File output: binary/JSON goes to the file; `--json` emits a single
 *   metadata object on stdout (path, bytes, version, …).
 * - `-o -` with png/svg: raw bytes on stdout only (`streamed: true`).
 *   Combining binary stdout with `--json` is a usage error so agents never
 *   get half-JSON mixed with image bytes.
 * - Failures always use the normal error path (stderr message; under `--json`
 *   also one error envelope on stdout).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiFetch, apiFetchBinary } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import type { SceneInfo } from "./ls.js";

export type ExportFormat = "png" | "svg" | "json";

/** Minimal .excalidraw document shape from GET /scene. */
type SceneDocument = {
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

function parseExportArgs(args: string[]): {
  slug: string;
  format: ExportFormat;
  output?: string;
  version?: number;
  scale?: number;
  dark: boolean;
} {
  let values: {
    format?: string;
    o?: string;
    output?: string;
    version?: string;
    scale?: string;
    dark?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        format: { type: "string" },
        o: { type: "string", short: "o" },
        output: { type: "string" },
        version: { type: "string" },
        scale: { type: "string" },
        dark: { type: "boolean", default: false },
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

  if (positionals.length === 0) {
    throw new UsageError(
      "export requires SLUG\n\n" +
        "Usage: excalicli export SLUG --format png|svg|json [--scale 2] [--dark] [--version N] [-o file]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excalicli export SLUG --format png|svg|json [--scale 2] [--dark] [--version N] [-o file]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("export requires a non-empty SLUG");
  }

  if (values.format === undefined || values.format.trim() === "") {
    throw new UsageError(
      "export requires --format png|svg|json\n\n" +
        "Usage: excalicli export SLUG --format png|svg|json [--scale 2] [--dark] [--version N] [-o file]",
    );
  }
  const formatRaw = values.format.trim().toLowerCase();
  if (formatRaw !== "png" && formatRaw !== "svg" && formatRaw !== "json") {
    throw new UsageError(
      `--format must be png, svg, or json, got ${JSON.stringify(values.format)}`,
    );
  }
  const format = formatRaw as ExportFormat;

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

  let scale: number | undefined;
  if (values.scale !== undefined) {
    const n = Number(values.scale.trim());
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError(
        `--scale must be a positive number, got ${JSON.stringify(values.scale)}`,
      );
    }
    scale = n;
  }

  if (format === "json" && (scale !== undefined || values.dark === true)) {
    throw new UsageError(
      "--scale and --dark only apply to --format png|svg",
    );
  }

  return {
    slug,
    format,
    output,
    version,
    scale,
    dark: values.dark === true,
  };
}

/** Default path: `{slug}-v{version}.{ext}`. */
export function defaultExportPath(
  slug: string,
  version: number,
  format: ExportFormat,
): string {
  const ext = format === "json" ? "json" : format;
  return `${slug}-v${version}.${ext}`;
}

function renderUnavailableMessage(
  reason: unknown,
  serverMessage: string,
): string {
  const tip =
    "Tip: --format json still works without a render worker (no browser needed).";
  if (reason === "disabled") {
    return (
      "PNG/SVG rendering is not available: RENDER_WORKER=off. " +
      "Set RENDER_WORKER=on and ensure Playwright/Chromium are installed " +
      "(optional dependency of @excalidraw-collab/render) to enable render endpoints. " +
      tip
    );
  }
  if (reason === "not_installed") {
    return (
      "PNG/SVG rendering is not available: Playwright is not installed. " +
      "This deployment was built without render support (optional dependency skipped — " +
      "e.g. pnpm install --no-optional). Install optional dependencies or rebuild with " +
      "Playwright, then set RENDER_WORKER=on. " +
      tip
    );
  }
  // Preserve server wording when reason is missing/unknown, still add the tip.
  const base = serverMessage.trim() || "PNG/SVG rendering is not available.";
  return `${base} ${tip}`;
}

function rethrowRenderUnavailable(err: unknown): never {
  if (err instanceof CliError && err.code === "NOT_IMPLEMENTED") {
    const details = err.details as { reason?: unknown } | undefined;
    throw new CliError(renderUnavailableMessage(details?.reason, err.message), {
      code: "NOT_IMPLEMENTED",
      details: err.details,
    });
  }
  throw err;
}

async function resolveVersion(
  ctx: CommandContext,
  slug: string,
  requested: number | undefined,
): Promise<number> {
  if (requested !== undefined) return requested;
  const meta = await apiFetch<SceneInfo>({
    path: `/api/scenes/${encodeURIComponent(slug)}`,
    method: "GET",
    config: ctx.config,
  });
  return meta.headVersion;
}

function writeBinaryStdout(ctx: CommandContext, bytes: Uint8Array): void {
  const io = ctx.io;
  if (!io) {
    // Fallback when tests omit io — still write via process for real runs.
    process.stdout.write(bytes);
    return;
  }
  io.stdout.write(bytes);
}

async function exportJson(
  ctx: CommandContext,
  opts: {
    slug: string;
    version: number;
    requestedVersion: number | undefined;
    output: string | undefined;
  },
): Promise<CommandResult> {
  const qs =
    opts.requestedVersion !== undefined
      ? `?v=${encodeURIComponent(String(opts.requestedVersion))}`
      : "";
  const scene = await apiFetch<SceneDocument>({
    path: `/api/scenes/${encodeURIComponent(opts.slug)}/scene${qs}`,
    method: "GET",
    config: ctx.config,
  });

  const outPath =
    opts.output ?? defaultExportPath(opts.slug, opts.version, "json");
  const pretty = `${JSON.stringify(scene, null, 2)}\n`;

  if (outPath === "-") {
    // Binary-corruption rule does not apply to JSON format. Under --json we
    // emit one metadata object (including the scene); human mode writes the
    // document itself so agents can pipe it.
    const data = {
      slug: opts.slug,
      version: opts.version,
      format: "json" as const,
      path: "-",
      bytes: Buffer.byteLength(pretty, "utf8"),
      scene,
    };
    return {
      data,
      human: pretty,
    };
  }

  const abs = path.isAbsolute(outPath) ? outPath : path.join(ctx.cwd, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, pretty, "utf8");

  const data = {
    slug: opts.slug,
    version: opts.version,
    format: "json" as const,
    path: outPath,
    bytes: Buffer.byteLength(pretty, "utf8"),
  };
  return {
    data,
    human: `Exported ${opts.slug} v${opts.version} → ${outPath} (json, ${data.bytes} bytes)\n`,
  };
}

async function exportRender(
  ctx: CommandContext,
  opts: {
    slug: string;
    version: number;
    requestedVersion: number | undefined;
    format: "png" | "svg";
    output: string | undefined;
    scale?: number;
    dark: boolean;
  },
): Promise<CommandResult> {
  const outPath =
    opts.output ?? defaultExportPath(opts.slug, opts.version, opts.format);

  // Binary on stdout cannot share the stream with a --json metadata object.
  if (outPath === "-" && ctx.json) {
    throw new UsageError(
      "cannot combine --json with binary stdout (-o -). " +
        "Write to a file (omit -o or pass -o path) to get a metadata JSON object, " +
        "or omit --json to stream raw image bytes.",
    );
  }

  const params = new URLSearchParams();
  if (opts.requestedVersion !== undefined) {
    params.set("v", String(opts.requestedVersion));
  }
  if (opts.scale !== undefined) {
    params.set("scale", String(opts.scale));
  }
  if (opts.dark) {
    params.set("dark", "1");
  }
  const qs = params.toString() ? `?${params.toString()}` : "";
  const endpoint =
    opts.format === "png"
      ? `/api/scenes/${encodeURIComponent(opts.slug)}/render.png${qs}`
      : `/api/scenes/${encodeURIComponent(opts.slug)}/render.svg${qs}`;

  let binary;
  try {
    binary = await apiFetchBinary({
      path: endpoint,
      method: "GET",
      config: ctx.config,
    });
  } catch (err) {
    rethrowRenderUnavailable(err);
  }

  const bytes = binary.bytes;
  if (bytes.byteLength === 0) {
    throw new CliError("server returned an empty render body", {
      code: "ERROR",
    });
  }

  if (outPath === "-") {
    writeBinaryStdout(ctx, bytes);
    return {
      data: {
        slug: opts.slug,
        version: opts.version,
        format: opts.format,
        path: "-",
        bytes: bytes.byteLength,
        scale: opts.scale ?? 1,
        dark: opts.dark,
      },
      human: "",
      // Dispatcher must not print anything else on stdout.
      streamed: true,
    };
  }

  const abs = path.isAbsolute(outPath) ? outPath : path.join(ctx.cwd, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);

  const data = {
    slug: opts.slug,
    version: opts.version,
    format: opts.format,
    path: outPath,
    bytes: bytes.byteLength,
    scale: opts.scale ?? 1,
    dark: opts.dark,
  };
  return {
    data,
    human: `Exported ${opts.slug} v${opts.version} → ${outPath} (${opts.format}, ${data.bytes} bytes)\n`,
  };
}

async function runExport(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const parsed = parseExportArgs(ctx.args);
  const version = await resolveVersion(ctx, parsed.slug, parsed.version);

  if (parsed.format === "json") {
    return exportJson(ctx, {
      slug: parsed.slug,
      version,
      requestedVersion: parsed.version,
      output: parsed.output,
    });
  }

  return exportRender(ctx, {
    slug: parsed.slug,
    version,
    requestedVersion: parsed.version,
    format: parsed.format,
    output: parsed.output,
    scale: parsed.scale,
    dark: parsed.dark,
  });
}

export const exportCommand: Command = {
  name: "export",
  description:
    "Export a scene as PNG, SVG, or JSON (scene document)",
  usage:
    "excalicli export SLUG --format png|svg|json [--scale 2] [--dark] [--version N] [-o file] [--json]\n\n" +
    "  --format     png | svg | json (required)\n" +
    "  --scale N    Render scale for png/svg (default: server default, usually 1)\n" +
    "  --dark       Dark-mode export for png/svg\n" +
    "  --version N  Export a specific version instead of head\n" +
    "  -o file      Output path (default: SLUG-vN.ext). Use - for stdout.\n\n" +
    "PNG/SVG require the server render worker. If unavailable, the CLI reports\n" +
    "whether RENDER_WORKER is off or Playwright is missing. --format json always\n" +
    "works without a browser.\n\n" +
    "With --json and a file path, stdout is one metadata object. Binary to\n" +
    "stdout (-o -) cannot be combined with --json (would corrupt the image).",
  run: runExport,
};
