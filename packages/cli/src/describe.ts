/**
 * `excali describe SLUG [--version N] [--json] [--verbose]`
 *
 * Fetches the scene document from the server and prints a text outline via
 * core's `digestScene` / `formatDigest` — agents cannot see a canvas.
 */
import { parseArgs } from "node:util";
import {
  digestScene,
  formatDigest,
  type SceneDigest,
  type SceneDocument,
} from "@excalidraw-collab/core";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import type { SceneInfo } from "./ls.js";

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }
}

function parseDescribeArgs(args: string[]): {
  slug: string;
  version?: number;
  verbose: boolean;
} {
  let values: { version?: string; verbose?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        version: { type: "string" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { version?: string; verbose?: boolean };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "describe requires SLUG\n\n" + "Usage: excali describe SLUG [--version N] [--verbose]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excali describe SLUG [--version N] [--verbose]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("describe requires a non-empty SLUG");
  }

  let version: number | undefined;
  if (values.version !== undefined) {
    if (!/^\d+$/.test(values.version.trim())) {
      throw new UsageError(
        `--version must be a non-negative integer, got ${JSON.stringify(values.version)}`,
      );
    }
    version = Number(values.version);
  }

  return {
    slug,
    version,
    verbose: values.verbose === true,
  };
}

async function runDescribe(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, version: requestedVersion, verbose } = parseDescribeArgs(ctx.args);

  // Resolve the version number for the JSON payload (GET /scene does not
  // return it in the body).
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
    requestedVersion !== undefined ? `?v=${encodeURIComponent(String(requestedVersion))}` : "";
  const scene = await apiFetch<SceneDocument>({
    path: `/api/scenes/${encodeURIComponent(slug)}/scene${qs}`,
    method: "GET",
    config: ctx.config,
  });

  const digest: SceneDigest = digestScene(scene);
  const text = formatDigest(digest, { verbose });

  return {
    data: {
      slug,
      version,
      verbose,
      digest,
      text,
    },
    // Default terse outline; --verbose adds element ids.
    human: text,
  };
}

export const describeCommand: Command = {
  name: "describe",
  description: "Print a text outline of a scene (frames, elements, edges) for agents",
  usage:
    "excali describe SLUG [--version N] [--verbose] [--json]\n\n" +
    "  --version N   Describe a specific version instead of head\n" +
    "  --verbose     Include element ids in the outline\n" +
    "Default output is compact; use --verbose for ids.",
  run: runDescribe,
};
