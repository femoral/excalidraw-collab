/**
 * `excalicli ls` — list scenes on the configured server.
 */
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError } from "./errors.js";
import { formatTable, type CommandResult } from "./format.js";

export type SceneInfo = {
  id: string;
  slug: string;
  name: string;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  lock: { holder: string; expiresAt: string } | null;
  elementCount: number;
};

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

async function runLs(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);

  if (ctx.args.length > 0) {
    // Strict: no unexpected positionals/flags for ls (help is peeled earlier).
    const first = ctx.args[0]!;
    if (first === "--help" || first === "-h") {
      // dispatcher already handles --help; fall through
    } else if (first.startsWith("-")) {
      throw new CliError(`unexpected option: ${first}`, { code: "USAGE" });
    } else {
      throw new CliError(`unexpected argument: ${first}`, { code: "USAGE" });
    }
  }

  const body = await apiFetch<{ scenes: SceneInfo[] }>({
    path: "/api/scenes",
    method: "GET",
    config: ctx.config,
  });

  const scenes = body.scenes.map((s) => ({
    slug: s.slug,
    name: s.name,
    headVersion: s.headVersion,
    elementCount: s.elementCount,
    updatedAt: s.updatedAt,
    lock: s.lock ? s.lock.holder : "",
  }));

  return {
    data: { scenes: body.scenes },
    human: formatTable(scenes, [
      "slug",
      "name",
      "headVersion",
      "elementCount",
      "updatedAt",
      "lock",
    ]),
  };
}

export const lsCommand: Command = {
  name: "ls",
  description: "List scenes on the server",
  usage: "excalicli ls [--json]",
  run: runLs,
};
