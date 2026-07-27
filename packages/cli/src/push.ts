/**
 * `excalicli push SLUG [-f file] -m "message" [--force]`
 *
 * Sends the recorded pulled version as `parentVersion` so conflicts are
 * detected without the user tracking version numbers by hand.
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
import type { SceneDocument } from "./pull.js";
import { getPulledVersion, setPulledVersion } from "./state.js";

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
} {
  let values: {
    f?: string;
    file?: string;
    m?: string;
    message?: string;
    force?: boolean;
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
    };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError(
      'push requires SLUG\n\nUsage: excalicli push SLUG [-f file] -m "message" [--force]',
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        'Usage: excalicli push SLUG [-f file] -m "message" [--force]',
    );
  }

  const slug = positionals[0]!.trim();
  if (slug.length === 0) {
    throw new UsageError("push requires a non-empty SLUG");
  }

  const message = (values.message ?? values.m)?.trim() ?? "";
  if (message.length === 0) {
    throw new UsageError(
      'push requires -m / --message\n\nUsage: excalicli push SLUG [-f file] -m "message" [--force]',
    );
  }

  const file = values.file ?? values.f;
  const force = values.force === true;

  return { slug, file, message, force };
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

async function runPush(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { slug, file, message, force } = parsePushArgs(ctx.args);
  const server = ctx.config.server!;

  const parentVersion = getPulledVersion(ctx.cwd, server, slug);
  if (parentVersion === undefined) {
    throw new CliError(
      `No local pulled version for scene "${slug}" on ${server}.\n` +
        `Run: excalicli pull ${slug}`,
      { code: "USAGE" },
    );
  }

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
  };

  return {
    data,
    human:
      `Pushed ${slug} v${result.version}` +
      (force ? " (force)" : "") +
      ` — "${result.message}"\n` +
      `parent: v${result.parentVersion ?? parentVersion}  author: ${result.author}\n`,
  };
}

export const pushCommand: Command = {
  name: "push",
  description:
    "Upload a .excalidraw file as a new version (uses last pulled version as parent)",
  usage:
    'excalicli push SLUG [-f file] -m "message" [--force] [--json]\n\n' +
    "  -f file     Input path (default: SLUG.excalidraw)\n" +
    "  -m message  Commit message (required)\n" +
    "  --force     Overwrite head even if parentVersion is stale\n" +
    "parentVersion comes from .excalidraw-collab/state.json (set by pull).",
  run: runPush,
};
