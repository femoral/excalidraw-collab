/**
 * `excalicli watch SLUG` — long-poll for new versions and print each diff.
 *
 * Human mode prints a text diff as versions arrive. `--json` emits one JSON
 * object per line (JSONL) so an agent loop can consume events incrementally
 * without buffering a full array.
 */
import { parseArgs } from "node:util";
import { apiFetch, apiFetchResult, apiFetchText } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import type { SceneInfo } from "./ls.js";
import { getPulledVersion } from "./state.js";

/** Server body from `GET /api/scenes/:slug/events?since=N`. */
export type SceneEventResponse = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  headVersion: number;
};

/** One JSONL event under `--json`. */
export type WatchEvent = {
  slug: string;
  from: number;
  to: number;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  diff: unknown;
};

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

function parseWatchArgs(args: string[]): {
  slug: string;
  since?: number;
} {
  let values: { since?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        since: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { since?: string };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "watch requires SLUG\n\nUsage: excalicli watch SLUG [--since N] [--json]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excalicli watch SLUG [--since N] [--json]",
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("watch requires a non-empty SLUG");
  }

  let since: number | undefined;
  if (values.since !== undefined) {
    if (!/^\d+$/.test(values.since.trim())) {
      throw new UsageError(
        `--since must be a non-negative integer, got ${JSON.stringify(values.since)}`,
      );
    }
    since = Number(values.since);
  }

  return { slug, since };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * Resolve the starting `since` watermark:
 *   1. explicit `--since N`
 *   2. last pulled version in local state (so agents see changes since pull)
 *   3. current head (wait for the *next* commit only)
 */
async function resolveSince(
  ctx: CommandContext,
  slug: string,
  explicit?: number,
): Promise<number> {
  if (explicit !== undefined) return explicit;

  const server = ctx.config.server!;
  const recorded = getPulledVersion(ctx.cwd, server, slug);
  if (recorded !== undefined) return recorded;

  const meta = await apiFetch<SceneInfo>({
    path: `/api/scenes/${encodeURIComponent(slug)}`,
    method: "GET",
    config: ctx.config,
    signal: ctx.signal,
  });
  return meta.headVersion;
}

async function fetchStructuredDiff(
  ctx: CommandContext,
  slug: string,
  from: number,
  to: number,
): Promise<unknown> {
  return apiFetch({
    path:
      `/api/scenes/${encodeURIComponent(slug)}/diff` +
      `?from=${encodeURIComponent(String(from))}` +
      `&to=${encodeURIComponent(String(to))}`,
    method: "GET",
    config: ctx.config,
    signal: ctx.signal,
  });
}

async function fetchTextDiff(
  ctx: CommandContext,
  slug: string,
  from: number,
  to: number,
): Promise<string> {
  return apiFetchText({
    path:
      `/api/scenes/${encodeURIComponent(slug)}/diff` +
      `?from=${encodeURIComponent(String(from))}` +
      `&to=${encodeURIComponent(String(to))}` +
      `&format=text`,
    method: "GET",
    config: ctx.config,
    signal: ctx.signal,
  });
}

function writeLine(ctx: CommandContext, line: string): void {
  const io = ctx.io;
  if (!io) {
    throw new CliError("watch requires an IO stream (internal error)", {
      code: "INTERNAL",
    });
  }
  io.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

async function runWatch(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, since: sinceArg } = parseWatchArgs(ctx.args);
  const signal = ctx.signal;

  let since = await resolveSince(ctx, slug, sinceArg);
  let eventsSeen = 0;

  if (!ctx.json) {
    writeLine(
      ctx,
      `watching ${slug} since v${since} (Ctrl-C to stop)\n`,
    );
  }

  while (true) {
    if (signal?.aborted) break;

    let status: number;
    let event: SceneEventResponse | undefined;
    try {
      const result = await apiFetchResult<SceneEventResponse>({
        path:
          `/api/scenes/${encodeURIComponent(slug)}/events` +
          `?since=${encodeURIComponent(String(since))}`,
        method: "GET",
        config: ctx.config,
        signal,
      });
      status = result.status;
      event = result.body;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) break;
      throw err;
    }

    if (status === 204 || event === undefined) {
      // Idle timeout — re-poll. No CPU spin on the client either: we only
      // re-enter after the server's ~30 s long-poll returns.
      continue;
    }

    const to = event.headVersion;
    if (!Number.isInteger(to) || to <= since) {
      // Defensive: server should not return 200 without progress.
      continue;
    }

    const from = since;

    if (ctx.json) {
      const diff = await fetchStructuredDiff(ctx, slug, from, to);
      const payload: WatchEvent = {
        slug,
        from,
        to,
        author: event.author,
        message: event.message,
        createdAt: event.createdAt,
        elementCount: event.elementCount,
        sceneHash: event.sceneHash,
        diff,
      };
      // Compact single-line JSON (JSONL) — not pretty-printed.
      writeLine(ctx, JSON.stringify(payload));
    } else {
      let text: string;
      try {
        text = await fetchTextDiff(ctx, slug, from, to);
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) break;
        throw err;
      }
      writeLine(
        ctx,
        `── ${slug} v${from} → v${to}  ${event.author}: ${event.message}`,
      );
      writeLine(ctx, text.endsWith("\n") ? text : `${text}\n`);
    }

    since = to;
    eventsSeen += 1;

    // Tests pass an AbortSignal and abort after the first event, or a
    // maxEvents cap via env (EXCALICLI_WATCH_MAX_EVENTS) for harnesses.
    const maxRaw = ctx.env.EXCALICLI_WATCH_MAX_EVENTS;
    if (maxRaw !== undefined && maxRaw !== "") {
      const max = Number(maxRaw);
      if (Number.isInteger(max) && max > 0 && eventsSeen >= max) {
        break;
      }
    }
  }

  // Streaming command: dispatcher must not re-render a final object that
  // would break JSONL (a trailing array/object on stdout).
  return {
    data: { slug, since, eventsSeen },
    human: "",
    streamed: true,
  };
}

export const watchCommand: Command = {
  name: "watch",
  description:
    "Long-poll for new versions and print each diff (JSONL under --json)",
  usage:
    "excalicli watch SLUG [--since N] [--json]\n\n" +
    "  --since N   Start after version N (default: last pulled, else current head)\n" +
    "  --json      Emit one JSON object per line (JSONL) as versions arrive\n" +
    "Blocks until interrupted. Each new commit prints the from→to diff.",
  run: runWatch,
};
