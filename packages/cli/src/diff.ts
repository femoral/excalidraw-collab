/**
 * `excali diff SLUG [--from head~1] [--to head] [--since-last-pull] [--json]`
 *
 * Thin client over GET /api/scenes/:slug/diff. Empty diffs exit 0 — nothing
 * changed is success for agent loops that check exit status.
 */
import { parseArgs } from "node:util";
import { formatDiff, type SceneDiff } from "@excalidraw-collab/core";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import { getPulledVersion } from "./state.js";

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }
}

function parseDiffArgs(args: string[]): {
  slug: string;
  from?: string;
  to?: string;
  sinceLastPull: boolean;
} {
  let values: {
    from?: string;
    to?: string;
    "since-last-pull"?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        "since-last-pull": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as {
      from?: string;
      to?: string;
      "since-last-pull"?: boolean;
    };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "diff requires SLUG\n\n" +
        "Usage: excali diff SLUG [--from head~1] [--to head] [--since-last-pull]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excali diff SLUG [--from head~1] [--to head] [--since-last-pull]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("diff requires a non-empty SLUG");
  }

  const sinceLastPull = values["since-last-pull"] === true;
  if (sinceLastPull && values.from !== undefined) {
    throw new UsageError(
      "diff: --since-last-pull and --from cannot be used together\n\n" +
        "Usage: excali diff SLUG [--from head~1] [--to head] [--since-last-pull]",
    );
  }

  return {
    slug,
    from: values.from,
    to: values.to,
    sinceLastPull,
  };
}

function resolveRefs(
  ctx: CommandContext,
  slug: string,
  opts: {
    from?: string;
    to?: string;
    sinceLastPull: boolean;
  },
): { from: string; to: string } {
  if (opts.sinceLastPull) {
    const server = ctx.config.server!;
    const pulled = getPulledVersion(ctx.cwd, server, slug);
    if (pulled === undefined) {
      throw new CliError(
        `No local pulled version for scene "${slug}" on ${server}.\n` + `Run: excali pull ${slug}`,
        { code: "USAGE" },
      );
    }
    return {
      from: String(pulled),
      to: opts.to ?? "head",
    };
  }

  return {
    from: opts.from ?? "head~1",
    to: opts.to ?? "head",
  };
}

async function runDiff(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const parsed = parseDiffArgs(ctx.args);
  const { from, to } = resolveRefs(ctx, parsed.slug, parsed);

  const qs = new URLSearchParams({ from, to });
  const diff = await apiFetch<SceneDiff>({
    path: `/api/scenes/${encodeURIComponent(parsed.slug)}/diff?${qs}`,
    method: "GET",
    config: ctx.config,
  });

  // Empty diff is success (exit 0). Agents treat non-zero as "something broke".
  // `fromRef`/`toRef` are the request refs; `from`/`to` on the diff are absolute
  // version numbers resolved by the server (do not clobber them).
  return {
    data: {
      slug: parsed.slug,
      fromRef: from,
      toRef: to,
      diff,
    },
    human: formatDiff(diff),
  };
}

export const diffCommand: Command = {
  name: "diff",
  description: "Show what changed between two scene versions (default: head~1 → head)",
  usage:
    "excali diff SLUG [--from head~1] [--to head] [--since-last-pull] [--json]\n\n" +
    "  --from REF           Start version (N, head, head~N). Default: head~1\n" +
    "  --to REF             End version. Default: head\n" +
    "  --since-last-pull    Diff from the version recorded by pull/push to head\n" +
    "                       (reads .excalidraw-collab/state.json)\n" +
    "Empty diffs exit 0 — nothing changed is not an error.",
  run: runDiff,
};
