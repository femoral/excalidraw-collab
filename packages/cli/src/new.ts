/**
 * `excali new "Name" [--slug s]` — create a scene.
 */
import { parseArgs } from "node:util";
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

function parseNewArgs(args: string[]): { name: string; slug?: string } {
  let values: { slug?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        slug: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { slug?: string };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length === 0) {
    throw new UsageError('new requires a scene name\n\nUsage: excali new "Name" [--slug s]');
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        'Usage: excali new "Name" [--slug s]',
    );
  }

  const name = positionals[0]!.trim();
  if (name.length === 0) {
    throw new UsageError(
      'new requires a non-empty scene name\n\nUsage: excali new "Name" [--slug s]',
    );
  }

  const slug =
    values.slug !== undefined && values.slug.trim() !== "" ? values.slug.trim() : undefined;

  return { name, slug };
}

async function runNew(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { name, slug } = parseNewArgs(ctx.args);

  const body: { name: string; slug?: string } = { name };
  if (slug !== undefined) {
    body.slug = slug;
  }

  const scene = await apiFetch<SceneInfo>({
    path: "/api/scenes",
    method: "POST",
    config: ctx.config,
    body: JSON.stringify(body),
  });

  return {
    data: scene,
    human: `Created scene "${scene.name}" (slug: ${scene.slug}, head: v${scene.headVersion})\n`,
  };
}

export const newCommand: Command = {
  name: "new",
  description: 'Create a new scene: excali new "Name" [--slug s]',
  usage: 'excali new "Name" [--slug s] [--json]',
  run: runNew,
};
