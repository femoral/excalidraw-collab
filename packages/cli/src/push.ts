/**
 * `excalicli push SLUG [-f file] -m "message" [--force] [--respect-lock] [--skeleton]`
 *
 * Sends the recorded pulled version as `parentVersion` so conflicts are
 * detected without the user tracking version numbers by hand.
 *
 * With `--skeleton`, the file is a short element skeleton list (not a full
 * `.excalidraw` document). The server runs upstream `convertToExcalidrawElements`
 * inside the render worker and the resulting full elements are pushed.
 *
 * Advisory locks: when someone else holds the turn, push **warns** and still
 * succeeds. Pass `--respect-lock` to refuse with exit 5 (LOCK_HELD) instead.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import {
  formatConflictMessage,
  resolutionCommands,
  type ConflictDetails,
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
};

export type SkeletonConvertResponse = {
  elements: unknown[];
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
  respectLock: boolean;
  skeleton: boolean;
} {
  let values: {
    f?: string;
    file?: string;
    m?: string;
    message?: string;
    force?: boolean;
    "respect-lock"?: boolean;
    skeleton?: boolean;
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
        "respect-lock": { type: "boolean", default: false },
        skeleton: { type: "boolean", default: false },
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
      "respect-lock"?: boolean;
      skeleton?: boolean;
    };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      'push requires SLUG\n\nUsage: excalicli push SLUG [-f file] -m "message" [--force] [--respect-lock] [--skeleton]',
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        'Usage: excalicli push SLUG [-f file] -m "message" [--force] [--respect-lock] [--skeleton]',
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("push requires a non-empty SLUG");
  }

  const message = (values.message ?? values.m)?.trim() ?? "";
  if (message.length === 0) {
    throw new UsageError(
      'push requires -m / --message\n\nUsage: excalicli push SLUG [-f file] -m "message" [--force] [--respect-lock] [--skeleton]',
    );
  }

  const file = values.file ?? values.f;
  const force = values.force === true;
  const respectLock = values["respect-lock"] === true;
  const skeleton = values.skeleton === true;

  return { slug, file, message, force, respectLock, skeleton };
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

function defaultFilePath(slug: string, skeleton: boolean): string {
  return skeleton ? `${slug}.skeleton.json` : `${slug}.excalidraw`;
}

function readJsonFile(cwd: string, filePath: string): unknown {
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

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CliError(`invalid JSON in scene file: ${filePath}`, {
      code: "VALIDATION",
    });
  }
}

function readSceneFile(cwd: string, filePath: string): SceneDocument {
  const parsed = readJsonFile(cwd, filePath);

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
 * Read a skeleton file. Accepts either a bare array of skeleton entries or
 * an object `{ elements: [...] }` (optional appState/files passthrough).
 */
function readSkeletonFile(
  cwd: string,
  filePath: string,
): {
  elements: unknown[];
  appState?: unknown;
  files?: unknown;
} {
  const parsed = readJsonFile(cwd, filePath);

  if (Array.isArray(parsed)) {
    return { elements: parsed };
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new CliError(
      `invalid skeleton file ${filePath}: expected a JSON array or { "elements": [...] }`,
      { code: "VALIDATION" },
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.elements)) {
    throw new CliError(
      `invalid skeleton file ${filePath}: "elements" must be an array`,
      { code: "VALIDATION" },
    );
  }

  return {
    elements: obj.elements,
    appState: obj.appState,
    files: obj.files,
  };
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

async function convertSkeleton(
  ctx: CommandContext,
  elements: unknown[],
): Promise<unknown[]> {
  try {
    const result = await apiFetch<SkeletonConvertResponse>({
      path: "/api/skeleton/convert",
      method: "POST",
      config: ctx.config,
      body: JSON.stringify({ elements, regenerateIds: false }),
    });
    if (!result || !Array.isArray(result.elements)) {
      throw new CliError(
        "skeleton convert response missing elements array",
        { code: "ERROR" },
      );
    }
    return result.elements;
  } catch (err) {
    if (err instanceof CliError && err.code === "NOT_IMPLEMENTED") {
      throw new CliError(
        err.message ||
          "Skeleton conversion requires the render worker (RENDER_WORKER=on).",
        { code: "NOT_IMPLEMENTED", details: err.details },
      );
    }
    // Validation errors already carry skeleton[i]: reason from the server.
    throw err;
  }
}

async function runPush(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, file, message, force, respectLock, skeleton } = parsePushArgs(
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

  const filePath = file ?? defaultFilePath(slug, skeleton);

  let elements: unknown[];
  let appState: unknown | undefined;
  let files: unknown | undefined;
  let skeletonElementCount: number | undefined;

  if (skeleton) {
    const skel = readSkeletonFile(ctx.cwd, filePath);
    skeletonElementCount = skel.elements.length;
    elements = await convertSkeleton(ctx, skel.elements);
    appState = skel.appState;
    files = skel.files;
  } else {
    const scene = readSceneFile(ctx.cwd, filePath);
    elements = scene.elements;
    appState = scene.appState;
    files = scene.files;
  }

  const body: {
    parentVersion: number;
    elements: unknown[];
    appState?: unknown;
    files?: unknown;
    message: string;
  } = {
    parentVersion,
    elements,
    message,
  };
  if (appState !== undefined) {
    body.appState = appState;
  }
  if (files !== undefined) {
    body.files = files;
  }

  const qs = force ? "?force=true" : "";
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
    respectLock,
    skeleton,
    skeletonElementCount,
    lockHeldBy,
  };

  return {
    data,
    warning: lockWarning,
    human:
      `Pushed ${slug} v${result.version}` +
      (force ? " (force)" : "") +
      (skeleton ? " (from skeleton)" : "") +
      ` — "${result.message}"\n` +
      `parent: v${result.parentVersion ?? parentVersion}  author: ${result.author}` +
      (skeleton
        ? `  skeleton: ${skeletonElementCount} → ${result.elementCount} elements`
        : "") +
      `\n`,
  };
}

export const pushCommand: Command = {
  name: "push",
  description:
    "Upload a .excalidraw file (or --skeleton) as a new version",
  usage:
    'excalicli push SLUG [-f file] -m "message" [--force] [--respect-lock] [--skeleton] [--json]\n\n' +
    "  -f file          Input path (default: SLUG.excalidraw, or SLUG.skeleton.json with --skeleton)\n" +
    "  -m message       Commit message (required)\n" +
    "  --skeleton       Treat -f as a skeleton element list; convert via render worker then push\n" +
    "  --force          Overwrite head even if parentVersion is stale\n" +
    "  --respect-lock   Exit 5 if someone else holds the advisory turn lock\n" +
    "parentVersion comes from .excalidraw-collab/state.json (set by pull/push).\n" +
    "A fresh scene (head 0) or --force can push without a prior pull.\n" +
    "Without --respect-lock, a held lock only warns on stderr.\n" +
    "Skeleton conversion requires RENDER_WORKER=on on the server.",
  run: runPush,
};
