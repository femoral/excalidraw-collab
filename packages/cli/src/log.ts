/**
 * `excalicli log SLUG [-n N]`
 *
 * Version history: version, author, message, and per-version change counts
 * (from consecutive parent→version diffs via GET /diff).
 */
import { parseArgs } from "node:util";
import type { SceneDiff } from "@excalidraw-collab/core";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";

/** Wire shape from GET /api/scenes/:slug/versions. */
export type VersionInfo = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
};

export type VersionsPage = {
  versions: VersionInfo[];
  total: number;
  limit: number;
  offset: number;
  headVersion: number;
};

export type VersionLogEntry = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  /** Diff summary vs parent (or empty base when parent is null/0). */
  changes: {
    added: number;
    deleted: number;
    updated: number;
    reordered: number;
  };
};

const DEFAULT_LIMIT = 20;

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

function parseLogArgs(args: string[]): { slug: string; limit: number } {
  let values: { n?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        n: { type: "string", short: "n" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { n?: string };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "log requires SLUG\n\nUsage: excalicli log SLUG [-n N]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excalicli log SLUG [-n N]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("log requires a non-empty SLUG");
  }

  let limit = DEFAULT_LIMIT;
  if (values.n !== undefined) {
    if (!/^\d+$/.test(values.n.trim()) || Number(values.n) < 1) {
      throw new UsageError(
        `-n must be a positive integer, got ${JSON.stringify(values.n)}`,
      );
    }
    limit = Number(values.n);
  }

  return { slug, limit };
}

/** Compact change summary: `+2 -1 ~3` or `·` when empty. */
export function formatChangeCounts(c: {
  added: number;
  deleted: number;
  updated: number;
  reordered: number;
}): string {
  const parts: string[] = [];
  if (c.added) parts.push(`+${c.added}`);
  if (c.deleted) parts.push(`-${c.deleted}`);
  if (c.updated) parts.push(`~${c.updated}`);
  if (c.reordered) parts.push(`↕${c.reordered}`);
  return parts.length > 0 ? parts.join(" ") : "·";
}

function formatLogHuman(
  slug: string,
  headVersion: number,
  entries: VersionLogEntry[],
): string {
  if (entries.length === 0) {
    return `scene ${slug}  head v${headVersion}\n(no versions)\n`;
  }

  const lines: string[] = [`scene ${slug}  head v${headVersion}`];

  // Column widths for a compact aligned table.
  const verW = Math.max(
    2,
    ...entries.map((e) => String(e.version).length),
  );
  const authorW = Math.max(
    6,
    ...entries.map((e) => e.author.length),
  );
  const changeW = Math.max(
    7,
    ...entries.map((e) => formatChangeCounts(e.changes).length),
  );

  for (const e of entries) {
    const ver = String(e.version).padStart(verW, " ");
    const author = e.author.padEnd(authorW, " ");
    const changes = formatChangeCounts(e.changes).padEnd(changeW, " ");
    const msg = e.message.length > 0 ? e.message : "(no message)";
    lines.push(`v${ver}  ${author}  ${changes}  ${msg}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function fetchChangeSummary(
  ctx: CommandContext,
  slug: string,
  from: number,
  to: number,
): Promise<VersionLogEntry["changes"]> {
  if (from === to) {
    return { added: 0, deleted: 0, updated: 0, reordered: 0 };
  }
  const qs = new URLSearchParams({
    from: String(from),
    to: String(to),
  });
  const diff = await apiFetch<SceneDiff>({
    path: `/api/scenes/${encodeURIComponent(slug)}/diff?${qs}`,
    method: "GET",
    config: ctx.config,
  });
  return {
    added: diff.summary.added,
    deleted: diff.summary.deleted,
    updated: diff.summary.updated,
    reordered: diff.summary.reordered,
  };
}

async function runLog(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, limit } = parseLogArgs(ctx.args);

  const page = await apiFetch<VersionsPage>({
    path: `/api/scenes/${encodeURIComponent(slug)}/versions?limit=${limit}&offset=0`,
    method: "GET",
    config: ctx.config,
  });

  // Parallel change-count lookups (parent → version). Parent null → empty base 0.
  const entries: VersionLogEntry[] = await Promise.all(
    page.versions.map(async (v) => {
      const from = v.parentVersion ?? 0;
      const changes = await fetchChangeSummary(ctx, slug, from, v.version);
      return {
        version: v.version,
        parentVersion: v.parentVersion,
        author: v.author,
        message: v.message,
        createdAt: v.createdAt,
        elementCount: v.elementCount,
        changes,
      };
    }),
  );

  return {
    data: {
      slug,
      headVersion: page.headVersion,
      total: page.total,
      limit: page.limit,
      versions: entries,
    },
    human: formatLogHuman(slug, page.headVersion, entries),
  };
}

export const logCommand: Command = {
  name: "log",
  description:
    "Show version history (version, author, message, change counts)",
  usage:
    "excalicli log SLUG [-n N] [--json]\n\n" +
    `  -n N   Number of versions to show (default: ${DEFAULT_LIMIT})\n` +
    "Newest first. Change counts are parent→version diffs.",
  run: runLog,
};
