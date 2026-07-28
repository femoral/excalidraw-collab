/**
 * `excali whoami` — print the token's identity (the name that appears as
 * `author` in version history).
 */
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError } from "./errors.js";
import type { CommandResult } from "./format.js";

export type WhoamiData = {
  id: string;
  name: string;
  isAdmin: boolean;
};

async function runWhoami(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }

  const data = await apiFetch<WhoamiData>({
    path: "/api/whoami",
    method: "GET",
    config: ctx.config,
  });

  return {
    data,
    human:
      `name:     ${data.name}\n` +
      `id:       ${data.id}\n` +
      `isAdmin:  ${data.isAdmin}\n` +
      `\n` +
      `This name appears as author in version history.\n`,
  };
}

export const whoamiCommand: Command = {
  name: "whoami",
  description: "Print the token's identity — the name that will appear as author in history",
  usage: "excali whoami [--json]",
  run: runWhoami,
};
