/**
 * `excalicli push SLUG [-f file] -m "message" [--force|--merge] [--respect-lock]`
 *
 * Sends the recorded pulled version as `parentVersion` so conflicts are
 * detected without the user tracking version numbers by hand.
 *
 * On a stale parent, `--force` overwrites head; `--merge` asks the server to
 * run upstream `reconcileElements` in the render worker (response includes
 * the merge diff). Force and merge are mutually exclusive.
 *
 * Advisory locks: when someone else holds the turn, push **warns** and still
 * succeeds. Pass `--respect-lock` to refuse with exit 5 (LOCK_HELD) instead.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import {
  formatConflictDiff,
  formatConflictMessage,
  resolutionCommands,
  type ConflictDetails,
  type ConflictDiff,
} from "./conflict.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import type { SceneInfo } from "./ls.js";
import type { SceneDocument } from "./pull.js";
import { getPulledVersion, setPulledVersion } from "./state.js";
import type { WhoamiData } from "./whoami.js";

export type PushVersionResponse = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  headVersion: number;
  merged?: boolean;
  mergeParents?: { local: number; remote: number };
  diff?: unknown;
};

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

function parsePushArgs(args: string[]): {
  slug: string;
  file?: string;
  message: string;
  force: boolean;
  merge: boolean;
  respectLock: boolean;
} {
  let values: {
    f?: string;
    file?: string;
    m?: string;
    message?: string;
    force?: boolean;
    merge?: boolean;
    "respect-lock"?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        f: { type: "string", short: "f" },
        file: { type: "string" },
        m: { type: "string", short: "m" },
        message: { type: "string" },
        force: { type: "boolean", default: false },
        merge: { type: "boolean", default: false },
        "respect-lock": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as {
      f?: string;
      file?: string;
      m?: string;
      message?: string;
      force?: boolean;
      merge?: boolean;
      "respect-lock"?: boolean;
    };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      'push requires SLUG\n\nUsage: excalicli push SLUG [-f file] -m "message" [--force|--merge] [--respect-lock]',
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        'Usage: excalicli push SLUG [-f file] -m "message" [--force|--merge] [--respect-lock]',
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("push requires a non-empty SLUG");
  }

  const message = (values.message ?? values.m)?.trim() ?? "";
  if (message.length === 0) {
    throw new UsageError(
      'push requires -m / --message\n\nUsage: excalicli push SLUG [-f file] -m "message" [--force|--merge] [--respect-lock]',
    );
  }

  const file = values.file ?? values.f;
  const force = values.force === true;
  const merge = values.merge === true;
  const respectLock = values["respect-lock"] === true;

  if (force && merge) {
    throw new UsageError(
      "--force and --merge are mutually exclusive; choose one conflict resolution strategy",
    );
  }

  return { slug, file, message, force, merge, respectLock };
}

/** Active advisory lock (null when free or expired). */
function activeLock(
  lock: SceneInfo["lock"],
  nowMs: number = Date.now(),
): SceneInfo["lock"] {
  if (lock === null) return null;
  if (!lock.expiresAt) return lock;
  const expires = Date.parse(lock.expiresAt);
  if (Number.isNaN(expires)) return lock;
  return expires > nowMs ? lock : null;
}

function defaultFilePath(slug: string): string {
  return `${slug}.excalidraw`;
}

function readSceneFile(cwd: string, filePath: string): SceneDocument {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CliError(`scene file not found: ${filePath}`, {
        code: "NOT_FOUND",
      });
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CliError(`invalid JSON in scene file: ${filePath}`, {
      code: "VALIDATION",
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      `invalid scene file ${filePath}: expected a JSON object`,
      { code: "VALIDATION" },
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.elements)) {
    throw new CliError(
      `invalid scene file ${filePath}: "elements" must be an array`,
      { code: "VALIDATION" },
    );
  }

  return obj as SceneDocument;
}

/**
 * Resolve parentVersion for a push.
 *
 * Prefer the recorded last-pulled version. When local state is missing:
 * - head === 0 (never pushed): parentVersion 0 is unambiguous — allow push
 * - --force: commit onto current head regardless of local state
 * - otherwise: refuse (exit 2) — the agent must pull first so conflicts work
 */
async function resolveParentVersion(
  ctx: CommandContext,
  slug: string,
  force: boolean,
): Promise<number> {
  const server = ctx.config.server!;
  const recorded = getPulledVersion(ctx.cwd, server, slug);
  if (recorded !== undefined) {
    return recorded;
  }

  const meta = await apiFetch<SceneInfo>({
    path: `/api/scenes/${encodeURIComponent(slug)}`,
    method: "GET",
    config: ctx.config,
  });
  const head = meta.headVersion;

  if (head === 0) {
    return 0;
  }
  if (force) {
    // Force means "commit onto whatever head currently is".
    return head;
  }

  throw new CliError(
    `No local pulled version for scene "${slug}" on ${server}.\n` +
      `Run: excalicli pull ${slug}`,
    { code: "USAGE" },
  );
}

async function runPush(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, file, message, force, merge, respectLock } = parsePushArgs(
    ctx.args,
  );
  const server = ctx.config.server!;

  // Advisory lock check (never enforced by the server). Warn, or refuse with
  // exit 5 when --respect-lock is set and someone else holds the turn.
  let lockWarning: string | undefined;
  let lockHeldBy: string | null = null;
  const meta = await apiFetch<SceneInfo>({
    path: `/api/scenes/${encodeURIComponent(slug)}`,
    method: "GET",
    config: ctx.config,
  });
  const held = activeLock(meta.lock);
  if (held) {
    const me = await apiFetch<WhoamiData>({
      path: "/api/whoami",
      method: "GET",
      config: ctx.config,
    });
    if (held.holder !== me.name) {
      lockHeldBy = held.holder;
      const msg =
        `warning: turn held by ${held.holder}` +
        (held.expiresAt ? ` until ${held.expiresAt}` : "") +
        ` — push is still allowed (advisory lock)`;
      if (respectLock) {
        throw new CliError(
          `Turn held by ${held.holder}` +
            (held.expiresAt ? ` until ${held.expiresAt}` : "") +
            `.\n` +
            `Refusing push because --respect-lock was set.\n` +
            `Release with: excalicli turn release ${slug}\n` +
            `Or omit --respect-lock to push anyway.`,
          {
            code: "LOCK_HELD",
            details: {
              holder: held.holder,
              expiresAt: held.expiresAt,
            },
          },
        );
      }
      lockWarning = msg;
    }
  }

  const parentVersion = await resolveParentVersion(ctx, slug, force);

  const filePath = file ?? defaultFilePath(slug);
  const scene = readSceneFile(ctx.cwd, filePath);

  const body: {
    parentVersion: number;
    elements: unknown[];
    appState?: unknown;
    files?: unknown;
    message: string;
  } = {
    parentVersion,
    elements: scene.elements,
    message,
  };
  if (scene.appState !== undefined) {
    body.appState = scene.appState;
  }
  if (scene.files !== undefined) {
    body.files = scene.files;
  }

  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (merge) params.set("merge", "true");
  const qs = params.toString() ? `?${params.toString()}` : "";
  let result: PushVersionResponse;
  try {
    result = await apiFetch<PushVersionResponse>({
      path: `/api/scenes/${encodeURIComponent(slug)}/scene${qs}`,
      method: "POST",
      config: ctx.config,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof CliError && err.code === "CONFLICT") {
      const details = err.details as ConflictDetails | undefined;
      const human = formatConflictMessage(slug, details, {
        message,
        serverMessage: err.message,
      });
      throw new CliError(human, {
        code: "CONFLICT",
        details: {
          ...(details && typeof details === "object" ? details : {}),
          resolution: resolutionCommands(slug, message),
        },
      });
    }
    throw err;
  }

  // Successful push advances our "pulled" watermark so the next push is not
  // immediately stale against our own commit.
  setPulledVersion(ctx.cwd, server, slug, result.version);

  const data = {
    slug,
    version: result.version,
    parentVersion: result.parentVersion,
    headVersion: result.headVersion,
    author: result.author,
    message: result.message,
    elementCount: result.elementCount,
    sceneHash: result.sceneHash,
    path: filePath,
    force,
    merge,
    merged: result.merged === true,
    mergeParents: result.mergeParents,
    diff: result.diff,
    respectLock,
    lockHeldBy,
  };

  let human =
    `Pushed ${slug} v${result.version}` +
    (force ? " (force)" : "") +
    (result.merged ? " (merged)" : merge ? " (merge)" : "") +
    ` — "${result.message}"\n` +
    `parent: v${result.parentVersion ?? parentVersion}  author: ${result.author}\n`;

  if (result.merged && result.mergeParents) {
    human +=
      `merge parents: v${result.mergeParents.local}+v${result.mergeParents.remote}\n`;
  }
  if (result.merged && result.diff) {
    // Surface the merge decision so a silent merge is never worse than a
    // conflict (PLAN.md / issue #29).
    human += "\nMerge decided (remote head → result):\n";
    human += formatConflictDiff(result.diff as ConflictDiff);
  }

  return {
    data,
    warning: lockWarning,
    human,
  };
}

export const pushCommand: Command = {
  name: "push",
  description:
    "Upload a .excalidraw file as a new version (uses last pulled version as parent)",
  usage:
    'excalicli push SLUG [-f file] -m "message" [--force|--merge] [--respect-lock] [--json]\n\n' +
    "  -f file          Input path (default: SLUG.excalidraw)\n" +
    "  -m message       Commit message (required)\n" +
    "  --force          Overwrite head even if parentVersion is stale\n" +
    "  --merge          On stale parent, server-side reconcileElements (needs RENDER_WORKER=on)\n" +
    "  --respect-lock   Exit 5 if someone else holds the advisory turn lock\n" +
    "parentVersion comes from .excalidraw-collab/state.json (set by pull/push).\n" +
    "A fresh scene (head 0) or --force can push without a prior pull.\n" +
    "Without --respect-lock, a held lock only warns on stderr.",
  run: runPush,
};
