/**
 * `excalicli login --server URL --token T`
 *
 * Validates credentials against GET /api/scenes before writing config, so a bad
 * token fails immediately rather than mysteriously later.
 */
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { writeConfigFile, configPath, type ResolvedConfig } from "./config.js";
import { UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";

function parseLoginArgs(args: string[]): { server: string; token: string } {
  let values: { server?: string; token?: string; help?: boolean };
  try {
    const parsed = parseArgs({
      args,
      options: {
        server: { type: "string" },
        token: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values as { server?: string; token?: string; help?: boolean };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (!values.server || values.server.trim() === "") {
    throw new UsageError(
      "login requires --server URL\n\nUsage: excalicli login --server URL --token T",
    );
  }
  if (!values.token || values.token.trim() === "") {
    throw new UsageError(
      "login requires --token T\n\nUsage: excalicli login --server URL --token T",
    );
  }

  // Normalize trailing slash so relative URL joins stay consistent.
  let server = values.server.trim();
  while (server.endsWith("/")) {
    server = server.slice(0, -1);
  }
  return { server, token: values.token.trim() };
}

async function runLogin(ctx: CommandContext): Promise<CommandResult> {
  const { server, token } = parseLoginArgs(ctx.args);
  const cfg: ResolvedConfig = {
    server,
    token,
    path: configPath(ctx.env),
  };

  // Validate before writing: any non-OK response throws CliError via apiFetch.
  await apiFetch<{ scenes: unknown[] }>({
    path: "/api/scenes",
    method: "GET",
    config: cfg,
  });

  const path = writeConfigFile({ server, token }, ctx.env);

  const data = {
    server,
    path,
    ok: true as const,
  };

  return {
    data,
    human: `Logged in to ${server}\nConfig written to ${path} (mode 0600)\n`,
  };
}

export const loginCommand: Command = {
  name: "login",
  description:
    "Save server URL and token after validating against GET /api/scenes",
  usage: "excalicli login --server URL --token T [--json]",
  run: runLogin,
};
