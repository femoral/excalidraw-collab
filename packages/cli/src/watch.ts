/**
 * `excali watch SLUG` — long-poll for scene events and print each one.
 *
 * Default (no flags): streaming tail of commits — prints each new version's
 * diff until Ctrl-C. Behaviour is unchanged from issue #24.
 *
 * Blocking wait primitives (issue #39):
 *   --once              exit 0 after the first matching event
 *   --timeout SECONDS   give up with exit 6 after N seconds of silence
 *   --events commit,turn  what wakes the watcher (default: commit)
 *   --for-turn          sugar: block until lock free or held by me
 *
 * Flagless / default-events path uses GET /api/scenes/:slug/events (version
 * watermark). When turn events are selected (or --for-turn), the CLI reuses
 * the multiplexed GET /api/events sequence from issue #37, filtered by slug.
 */
import { parseArgs } from "node:util";
import { apiFetch, apiFetchResult, apiFetchText } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, ExitCode, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import type { SceneInfo } from "./ls.js";
import { getPulledVersion } from "./state.js";
import type { WhoamiData } from "./whoami.js";

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

/** Multiplexed event from `GET /api/events?since=N` (issue #37). */
export type GlobalSceneEvent = {
  seq: number;
  sceneId: string;
  slug: string;
  kind: "version" | "lock";
  headVersion: number;
  version?: number;
  parentVersion?: number | null;
  author?: string;
  message?: string;
  createdAt?: string;
  elementCount?: number;
  sceneHash?: string;
  lock: { holder: string; expiresAt: string } | null;
  actor?: string;
};

type MultiplexedEventsResponse = {
  cursor: number;
  events: GlobalSceneEvent[];
};

/** One JSONL event under `--json` for a version commit (shape stable for flagless watch). */
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

/** One JSONL event under `--json` for a turn/lock change. */
export type WatchTurnEvent = {
  slug: string;
  kind: "turn";
  headVersion: number;
  lock: { holder: string; expiresAt: string } | null;
  actor?: string;
};

export type WatchTimeoutEvent = {
  timeout: true;
  slug: string;
};

export type WatchEventKind = "commit" | "turn";

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }
}

function parseWatchArgs(args: string[]): {
  slug: string;
  since?: number;
  once: boolean;
  timeoutSeconds?: number;
  events: Set<WatchEventKind>;
  forTurn: boolean;
} {
  let values: {
    since?: string;
    once?: boolean;
    timeout?: string;
    events?: string;
    "for-turn"?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        since: { type: "string" },
        once: { type: "boolean", default: false },
        timeout: { type: "string" },
        events: { type: "string" },
        "for-turn": { type: "boolean", default: false },
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
      "watch requires SLUG\n\n" +
        "Usage: excali watch SLUG [--since N] [--once] [--timeout SECONDS] " +
        "[--events commit,turn] [--for-turn] [--json]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excali watch SLUG [--since N] [--once] [--timeout SECONDS] " +
        "[--events commit,turn] [--for-turn] [--json]",
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

  let timeoutSeconds: number | undefined;
  if (values.timeout !== undefined) {
    const n = Number(values.timeout);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(
        `--timeout must be a non-negative integer (seconds), got ${JSON.stringify(values.timeout)}`,
      );
    }
    timeoutSeconds = n;
  }

  const events = parseEventsFlag(values.events);
  const forTurn = values["for-turn"] === true;
  const once = values.once === true || forTurn;

  // --for-turn always listens for turn (lock) events; commits also wake so a
  // holder push auto-release is observed without waiting for TTL.
  if (forTurn) {
    events.add("turn");
  }

  return {
    slug,
    since,
    once,
    timeoutSeconds,
    events,
    forTurn,
  };
}

function parseEventsFlag(raw: string | undefined): Set<WatchEventKind> {
  if (raw === undefined || raw.trim() === "") {
    return new Set<WatchEventKind>(["commit"]);
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new UsageError(
      `--events must list commit and/or turn (comma-separated), got ${JSON.stringify(raw)}`,
    );
  }
  const set = new Set<WatchEventKind>();
  for (const p of parts) {
    if (p === "commit" || p === "version") {
      set.add("commit");
    } else if (p === "turn" || p === "lock") {
      set.add("turn");
    } else {
      throw new UsageError(`unknown event kind ${JSON.stringify(p)}; expected commit and/or turn`);
    }
  }
  return set;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Resolve the starting `since` watermark for commit watching:
 *   1. explicit `--since N`
 *   2. last pulled version in local state (so agents see changes since pull)
 *   3. current head (wait for the *next* commit only)
 */
async function resolveSince(ctx: CommandContext, slug: string, explicit?: number): Promise<number> {
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

function writeStderr(ctx: CommandContext, line: string): void {
  const io = ctx.io;
  if (!io) return;
  io.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

async function emitCommit(
  ctx: CommandContext,
  slug: string,
  from: number,
  to: number,
  event: {
    author: string;
    message: string;
    createdAt: string;
    elementCount: number;
    sceneHash: string;
  },
): Promise<void> {
  if (ctx.json) {
    const diff = await fetchStructuredDiff(ctx, slug, from, to);
    // Compact single-line JSON (JSONL) — same keys as pre-#39 flagless watch.
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
    writeLine(ctx, JSON.stringify(payload));
  } else {
    let text: string;
    try {
      text = await fetchTextDiff(ctx, slug, from, to);
    } catch (err) {
      if (isAbortError(err) || ctx.signal?.aborted) throw err;
      throw err;
    }
    writeLine(ctx, `── ${slug} v${from} → v${to}  ${event.author}: ${event.message}`);
    writeLine(ctx, text.endsWith("\n") ? text : `${text}\n`);
  }
}

async function emitTurn(ctx: CommandContext, slug: string, event: GlobalSceneEvent): Promise<void> {
  if (ctx.json) {
    const payload: WatchTurnEvent = {
      slug,
      kind: "turn",
      headVersion: event.headVersion,
      lock: event.lock,
      actor: event.actor,
    };
    writeLine(ctx, JSON.stringify(payload));
  } else {
    if (event.lock) {
      writeLine(
        ctx,
        `── ${slug} turn  held by ${event.lock.holder} until ${event.lock.expiresAt}` +
          (event.actor ? `  (by ${event.actor})` : ""),
      );
    } else {
      writeLine(ctx, `── ${slug} turn  free` + (event.actor ? `  (by ${event.actor})` : ""));
    }
  }
}

function remainingTimeoutMs(deadlineMs: number | null): number | null {
  if (deadlineMs === null) return null;
  return Math.max(0, deadlineMs - Date.now());
}

function timedOut(deadlineMs: number | null): boolean {
  return deadlineMs !== null && Date.now() >= deadlineMs;
}

/**
 * Combine the command AbortSignal with an optional wall-clock deadline so
 * `--timeout` aborts an in-flight long-poll instead of waiting the full
 * server idle window (~30 s).
 */
function signalUntilDeadline(
  parent: AbortSignal | undefined,
  deadlineMs: number | null,
): { signal: AbortSignal | undefined; cancel: () => void } {
  if (deadlineMs === null && !parent) {
    return { signal: undefined, cancel: () => {} };
  }
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onParentAbort = (): void => {
    ac.abort();
  };
  if (parent) {
    if (parent.aborted) {
      ac.abort();
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  if (deadlineMs !== null) {
    const ms = remainingTimeoutMs(deadlineMs) ?? 0;
    if (ms <= 0) {
      ac.abort();
    } else {
      timer = setTimeout(() => {
        ac.abort();
      }, ms);
      if (
        typeof timer === "object" &&
        timer !== null &&
        "unref" in timer &&
        typeof timer.unref === "function"
      ) {
        timer.unref();
      }
    }
  }
  return {
    signal: ac.signal,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function timeoutResult(
  ctx: CommandContext,
  slug: string,
  eventsSeen: number,
  since: number,
): CommandResult {
  if (ctx.json) {
    const payload: WatchTimeoutEvent = { timeout: true, slug };
    writeLine(ctx, JSON.stringify(payload));
  } else {
    writeStderr(ctx, `watch: timed out waiting for ${slug}`);
  }
  return {
    data: { slug, since, eventsSeen, timeout: true },
    human: "",
    streamed: true,
    exitCode: ExitCode.TIMEOUT,
  };
}

/**
 * Resolve the current multiplexed event cursor without waiting.
 * Uses the restart-resync path (since ahead of hub → empty batch + cursor).
 */
async function fetchEventCursor(ctx: CommandContext): Promise<number> {
  const result = await apiFetchResult<MultiplexedEventsResponse>({
    path: `/api/events?since=${encodeURIComponent(String(Number.MAX_SAFE_INTEGER))}`,
    method: "GET",
    config: ctx.config,
    signal: ctx.signal,
  });
  if (result.status === 204 || !result.body) return 0;
  return result.body.cursor;
}

async function fetchScene(ctx: CommandContext, slug: string): Promise<SceneInfo> {
  return apiFetch<SceneInfo>({
    path: `/api/scenes/${encodeURIComponent(slug)}`,
    method: "GET",
    config: ctx.config,
    signal: ctx.signal,
  });
}

async function fetchWhoami(ctx: CommandContext): Promise<WhoamiData> {
  return apiFetch<WhoamiData>({
    path: "/api/whoami",
    method: "GET",
    config: ctx.config,
    signal: ctx.signal,
  });
}

function lockIsFreeOrMine(lock: SceneInfo["lock"], me: string): boolean {
  return lock === null || lock.holder === me;
}

/**
 * Self-authored event suppression (issue #39):
 *
 * Under `--for-turn`, ignore events whose actor/author is this token so an
 * agent does not wake itself (e.g. its own release echo while waiting for
 * the human). Under plain `--once` / streaming watch we do NOT suppress —
 * the caller may legitimately want to observe its own commit landing.
 */
function isSelfAuthored(event: GlobalSceneEvent, me: string, forTurn: boolean): boolean {
  if (!forTurn) return false;
  if (event.kind === "lock") {
    return event.actor === me;
  }
  return event.author === me;
}

function eventMatchesKinds(event: GlobalSceneEvent, kinds: Set<WatchEventKind>): boolean {
  if (event.kind === "version") return kinds.has("commit");
  if (event.kind === "lock") return kinds.has("turn");
  return false;
}

/**
 * Default commit-only streaming path (and `--once` / `--timeout` on commits).
 * Uses per-scene version long-poll — byte-compatible with pre-#39 flagless watch.
 */
async function runCommitWatch(
  ctx: CommandContext,
  opts: {
    slug: string;
    since: number;
    once: boolean;
    deadlineMs: number | null;
  },
): Promise<CommandResult> {
  const { slug, once, deadlineMs } = opts;
  let since = opts.since;
  let eventsSeen = 0;
  const signal = ctx.signal;

  if (!ctx.json) {
    writeLine(ctx, `watching ${slug} since v${since} (Ctrl-C to stop)\n`);
  }

  while (true) {
    if (signal?.aborted) break;
    if (timedOut(deadlineMs)) {
      return timeoutResult(ctx, slug, eventsSeen, since);
    }

    let status: number;
    let event: SceneEventResponse | undefined;
    const wait = signalUntilDeadline(signal, deadlineMs);
    try {
      const result = await apiFetchResult<SceneEventResponse>({
        path:
          `/api/scenes/${encodeURIComponent(slug)}/events` +
          `?since=${encodeURIComponent(String(since))}`,
        method: "GET",
        config: ctx.config,
        signal: wait.signal,
      });
      status = result.status;
      event = result.body;
    } catch (err) {
      wait.cancel();
      if (timedOut(deadlineMs)) {
        return timeoutResult(ctx, slug, eventsSeen, since);
      }
      if (isAbortError(err) || signal?.aborted) break;
      throw err;
    }
    wait.cancel();

    if (timedOut(deadlineMs)) {
      return timeoutResult(ctx, slug, eventsSeen, since);
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
    await emitCommit(ctx, slug, from, to, {
      author: event.author,
      message: event.message,
      createdAt: event.createdAt,
      elementCount: event.elementCount,
      sceneHash: event.sceneHash,
    });

    since = to;
    eventsSeen += 1;

    if (once) break;

    // Tests pass an AbortSignal and abort after the first event, or a
    // maxEvents cap via env (EXCALI_WATCH_MAX_EVENTS) for harnesses.
    const maxRaw = ctx.env.EXCALI_WATCH_MAX_EVENTS;
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

/**
 * Watch path when turn events are selected (or `--for-turn`).
 * Reuses the global event sequence from GET /api/events (issue #37).
 */
async function runMuxWatch(
  ctx: CommandContext,
  opts: {
    slug: string;
    versionSince: number;
    once: boolean;
    deadlineMs: number | null;
    events: Set<WatchEventKind>;
    forTurn: boolean;
    me: string;
  },
): Promise<CommandResult> {
  const { slug, once, deadlineMs, events: kinds, forTurn, me } = opts;
  let versionSince = opts.versionSince;
  let eventsSeen = 0;
  const signal = ctx.signal;

  // Catch up: a commit that landed while the agent was thinking must not
  // be missed. Same since resolution order as commit-only watch.
  if (kinds.has("commit") && !forTurn) {
    const scene = await fetchScene(ctx, slug);
    if (scene.headVersion > versionSince) {
      // Load head event details via per-scene fast path.
      const result = await apiFetchResult<SceneEventResponse>({
        path:
          `/api/scenes/${encodeURIComponent(slug)}/events` +
          `?since=${encodeURIComponent(String(versionSince))}`,
        method: "GET",
        config: ctx.config,
        signal,
      });
      if (result.status === 200 && result.body) {
        const event = result.body;
        const to = event.headVersion;
        if (to > versionSince) {
          await emitCommit(ctx, slug, versionSince, to, {
            author: event.author,
            message: event.message,
            createdAt: event.createdAt,
            elementCount: event.elementCount,
            sceneHash: event.sceneHash,
          });
          versionSince = to;
          eventsSeen += 1;
          if (once) {
            return {
              data: { slug, since: versionSince, eventsSeen },
              human: "",
              streamed: true,
            };
          }
        }
      }
    }
  }

  if (forTurn) {
    const scene = await fetchScene(ctx, slug);
    if (lockIsFreeOrMine(scene.lock, me)) {
      if (!ctx.json) {
        writeLine(
          ctx,
          scene.lock ? `turn for ${slug}: held by you (${me})\n` : `turn for ${slug}: free\n`,
        );
      } else {
        writeLine(
          ctx,
          JSON.stringify({
            slug,
            kind: "turn",
            ready: true,
            lock: scene.lock,
            headVersion: scene.headVersion,
          }),
        );
      }
      return {
        data: {
          slug,
          since: versionSince,
          eventsSeen: 0,
          ready: true,
          lock: scene.lock,
        },
        human: "",
        streamed: true,
      };
    }
  }

  let cursor = await fetchEventCursor(ctx);

  if (!ctx.json) {
    if (forTurn) {
      writeLine(ctx, `waiting for turn on ${slug} (Ctrl-C to stop)\n`);
    } else {
      writeLine(ctx, `watching ${slug} events=${[...kinds].join(",")} (Ctrl-C to stop)\n`);
    }
  }

  while (true) {
    if (signal?.aborted) break;
    if (timedOut(deadlineMs)) {
      return timeoutResult(ctx, slug, eventsSeen, versionSince);
    }

    // --for-turn: re-check lock each iteration in case state moved without
    // an event we care about (defensive; expiry publishes lock events).
    if (forTurn) {
      const scene = await fetchScene(ctx, slug);
      if (lockIsFreeOrMine(scene.lock, me)) {
        if (ctx.json) {
          writeLine(
            ctx,
            JSON.stringify({
              slug,
              kind: "turn",
              ready: true,
              lock: scene.lock,
              headVersion: scene.headVersion,
            }),
          );
        } else {
          writeLine(
            ctx,
            scene.lock ? `── ${slug} turn  held by you (${me})` : `── ${slug} turn  free`,
          );
        }
        return {
          data: {
            slug,
            since: versionSince,
            eventsSeen,
            ready: true,
            lock: scene.lock,
          },
          human: "",
          streamed: true,
        };
      }
    }

    let status: number;
    let body: MultiplexedEventsResponse | undefined;
    const wait = signalUntilDeadline(signal, deadlineMs);
    try {
      const result = await apiFetchResult<MultiplexedEventsResponse>({
        path: `/api/events?since=${encodeURIComponent(String(cursor))}`,
        method: "GET",
        config: ctx.config,
        signal: wait.signal,
      });
      status = result.status;
      body = result.body;
    } catch (err) {
      wait.cancel();
      if (timedOut(deadlineMs)) {
        return timeoutResult(ctx, slug, eventsSeen, versionSince);
      }
      if (isAbortError(err) || signal?.aborted) break;
      throw err;
    }
    wait.cancel();

    if (timedOut(deadlineMs)) {
      return timeoutResult(ctx, slug, eventsSeen, versionSince);
    }

    if (status === 204 || !body) {
      continue;
    }

    cursor = body.cursor;
    for (const event of body.events) {
      if (event.slug !== slug) continue;
      if (!eventMatchesKinds(event, kinds)) continue;
      if (isSelfAuthored(event, me, forTurn)) continue;

      if (forTurn) {
        // Only exit when lock is free or ours; a claim by someone else continues.
        if (event.kind === "lock") {
          if (event.lock === null || event.lock.holder === me) {
            await emitTurn(ctx, slug, event);
            eventsSeen += 1;
            return {
              data: {
                slug,
                since: versionSince,
                eventsSeen,
                ready: true,
                lock: event.lock,
              },
              human: "",
              streamed: true,
            };
          }
        } else if (event.kind === "version") {
          // Holder push may have auto-released; re-check after commit.
          versionSince = Math.max(versionSince, event.headVersion);
          const scene = await fetchScene(ctx, slug);
          if (lockIsFreeOrMine(scene.lock, me)) {
            if (ctx.json) {
              writeLine(
                ctx,
                JSON.stringify({
                  slug,
                  kind: "turn",
                  ready: true,
                  lock: scene.lock,
                  headVersion: scene.headVersion,
                }),
              );
            } else {
              writeLine(
                ctx,
                scene.lock ? `── ${slug} turn  held by you (${me})` : `── ${slug} turn  free`,
              );
            }
            eventsSeen += 1;
            return {
              data: {
                slug,
                since: versionSince,
                eventsSeen,
                ready: true,
                lock: scene.lock,
              },
              human: "",
              streamed: true,
            };
          }
        }
        continue;
      }

      // Non-for-turn: emit matching events.
      if (event.kind === "version") {
        const to = event.headVersion;
        if (to <= versionSince) continue;
        const from = versionSince;
        await emitCommit(ctx, slug, from, to, {
          author: event.author ?? "",
          message: event.message ?? "",
          createdAt: event.createdAt ?? "",
          elementCount: event.elementCount ?? 0,
          sceneHash: event.sceneHash ?? "",
        });
        versionSince = to;
        eventsSeen += 1;
      } else {
        await emitTurn(ctx, slug, event);
        eventsSeen += 1;
      }

      if (once) {
        return {
          data: { slug, since: versionSince, eventsSeen },
          human: "",
          streamed: true,
        };
      }

      const maxRaw = ctx.env.EXCALI_WATCH_MAX_EVENTS;
      if (maxRaw !== undefined && maxRaw !== "") {
        const max = Number(maxRaw);
        if (Number.isInteger(max) && max > 0 && eventsSeen >= max) {
          return {
            data: { slug, since: versionSince, eventsSeen },
            human: "",
            streamed: true,
          };
        }
      }
    }
  }

  return {
    data: { slug, since: versionSince, eventsSeen },
    human: "",
    streamed: true,
  };
}

async function runWatch(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const parsed = parseWatchArgs(ctx.args);
  const { slug, since: sinceArg, once, timeoutSeconds, events, forTurn } = parsed;

  const deadlineMs = timeoutSeconds !== undefined ? Date.now() + timeoutSeconds * 1000 : null;

  // Zero timeout: fail immediately if we would have to wait.
  if (timeoutSeconds === 0) {
    // Still honour catch-up for --once commits that already landed.
    if (!forTurn && events.has("commit") && !events.has("turn")) {
      const since = await resolveSince(ctx, slug, sinceArg);
      const scene = await fetchScene(ctx, slug);
      if (scene.headVersion > since) {
        return runCommitWatch(ctx, {
          slug,
          since,
          once: true,
          deadlineMs: Date.now() + 60_000,
        });
      }
      return timeoutResult(ctx, slug, 0, since);
    }
    if (forTurn) {
      const me = (await fetchWhoami(ctx)).name;
      const scene = await fetchScene(ctx, slug);
      if (lockIsFreeOrMine(scene.lock, me)) {
        if (ctx.json) {
          writeLine(
            ctx,
            JSON.stringify({
              slug,
              kind: "turn",
              ready: true,
              lock: scene.lock,
              headVersion: scene.headVersion,
            }),
          );
        }
        return {
          data: { slug, ready: true, lock: scene.lock },
          human: "",
          streamed: true,
        };
      }
      return timeoutResult(ctx, slug, 0, scene.headVersion);
    }
  }

  const needsMux = forTurn || events.has("turn");
  const versionSince = await resolveSince(ctx, slug, sinceArg);

  if (!needsMux) {
    return runCommitWatch(ctx, {
      slug,
      since: versionSince,
      once,
      deadlineMs,
    });
  }

  const me = (await fetchWhoami(ctx)).name;
  return runMuxWatch(ctx, {
    slug,
    versionSince,
    once,
    deadlineMs,
    events,
    forTurn,
    me,
  });
}

export const watchCommand: Command = {
  name: "watch",
  description:
    "Long-poll for new versions (and optional turn events); --once/--timeout for agent waits",
  usage:
    "excali watch SLUG [--since N] [--once] [--timeout SECONDS] [--events commit,turn] [--for-turn] [--json]\n\n" +
    "  --since N              Start after version N (default: last pulled, else current head)\n" +
    "  --once                 Exit 0 after the first matching event (prints one diff/JSONL line)\n" +
    "  --timeout SECONDS      Give up after N seconds with no event (exit 6 TIMEOUT)\n" +
    "  --events commit,turn   What wakes the watcher (default: commit). turn = lock claim/release/expiry\n" +
    "  --for-turn             Block until the lock is free or held by this token, then exit 0\n" +
    "  --json                 Emit one JSON object per line (JSONL) as events arrive\n\n" +
    "Default (no flags): stream forever until Ctrl-C — same as historical watch.\n" +
    "Agent hand-back: push → turn release → watch --once --timeout 900 → pull → diff.",
  run: runWatch,
};
