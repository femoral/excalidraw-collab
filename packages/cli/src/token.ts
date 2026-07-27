/**
 * `excalicli token create|ls|revoke NAME` — admin-only token management.
 *
 * Server DELETE is by id; revoke looks up NAME via the list endpoint first.
 * token create prints the secret once with a plain warning.
 */
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import { formatTable, type CommandResult } from "./format.js";

export type TokenInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
  isAdmin: boolean;
};

export type TokenCreated = TokenInfo & {
  token: string;
};

const SECRET_WARNING =
  "This secret is shown once and cannot be retrieved again. Save it now.";

const ADMIN_REQUIRED_MESSAGE =
  "Admin token required. Your current token cannot create, list, or revoke tokens.";

function requireAuthConfig(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

function rethrowAdmin(err: unknown): never {
  if (err instanceof CliError && err.code === "FORBIDDEN") {
    throw new CliError(ADMIN_REQUIRED_MESSAGE, {
      code: "FORBIDDEN",
      details: err.details,
    });
  }
  throw err;
}

async function runCreate(
  ctx: CommandContext,
  name: string,
): Promise<CommandResult> {
  requireAuthConfig(ctx);
  let created: TokenCreated;
  try {
    created = await apiFetch<TokenCreated>({
      path: "/api/tokens",
      method: "POST",
      config: ctx.config,
      body: JSON.stringify({ name }),
    });
  } catch (err) {
    rethrowAdmin(err);
  }

  const data = {
    id: created.id,
    name: created.name,
    token: created.token,
    isAdmin: created.isAdmin,
    createdAt: created.createdAt,
    lastUsed: created.lastUsed,
    warning: SECRET_WARNING,
  };

  const human =
    `Created token "${created.name}" (id ${created.id})\n` +
    `\n` +
    `Secret (shown once — cannot be retrieved again):\n` +
    `${created.token}\n` +
    `\n` +
    `${SECRET_WARNING}\n`;

  return { data, human };
}

async function runLs(ctx: CommandContext): Promise<CommandResult> {
  requireAuthConfig(ctx);
  let body: { tokens: TokenInfo[] };
  try {
    body = await apiFetch<{ tokens: TokenInfo[] }>({
      path: "/api/tokens",
      method: "GET",
      config: ctx.config,
    });
  } catch (err) {
    rethrowAdmin(err);
  }

  const tokens = body.tokens.map((t) => ({
    name: t.name,
    id: t.id,
    isAdmin: t.isAdmin,
    createdAt: t.createdAt,
    lastUsed: t.lastUsed,
  }));

  return {
    data: { tokens },
    human: formatTable(tokens, [
      "name",
      "id",
      "isAdmin",
      "createdAt",
      "lastUsed",
    ]),
  };
}

async function runRevoke(
  ctx: CommandContext,
  name: string,
): Promise<CommandResult> {
  requireAuthConfig(ctx);

  let body: { tokens: TokenInfo[] };
  try {
    body = await apiFetch<{ tokens: TokenInfo[] }>({
      path: "/api/tokens",
      method: "GET",
      config: ctx.config,
    });
  } catch (err) {
    rethrowAdmin(err);
  }

  const match = body.tokens.find((t) => t.name === name);
  if (!match) {
    throw new CliError(`token not found: ${name}`, { code: "NOT_FOUND" });
  }

  try {
    await apiFetch<undefined>({
      path: `/api/tokens/${encodeURIComponent(match.id)}`,
      method: "DELETE",
      config: ctx.config,
    });
  } catch (err) {
    rethrowAdmin(err);
  }

  const data = {
    revoked: true as const,
    id: match.id,
    name: match.name,
  };

  return {
    data,
    human: `Revoked token "${match.name}" (id ${match.id})\n`,
  };
}

function parseTokenArgs(args: string[]): {
  sub: "create" | "ls" | "revoke";
  name?: string;
} {
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const [sub, name, ...extra] = positionals;
  if (!sub) {
    throw new UsageError(
      "token requires a subcommand: create | ls | revoke\n\n" +
        "Usage:\n" +
        "  excalicli token create NAME\n" +
        "  excalicli token ls\n" +
        "  excalicli token revoke NAME",
    );
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected arguments: ${extra.join(" ")}`);
  }

  if (sub === "ls" || sub === "list") {
    if (name !== undefined) {
      throw new UsageError("token ls takes no name argument");
    }
    return { sub: "ls" };
  }

  if (sub === "create" || sub === "revoke") {
    if (!name || name.trim() === "") {
      throw new UsageError(
        `token ${sub} requires NAME\n\nUsage: excalicli token ${sub} NAME`,
      );
    }
    return { sub, name: name.trim() };
  }

  throw new UsageError(
    `unknown token subcommand: ${sub}\n\n` +
      "Usage:\n" +
      "  excalicli token create NAME\n" +
      "  excalicli token ls\n" +
      "  excalicli token revoke NAME",
  );
}

async function runToken(ctx: CommandContext): Promise<CommandResult> {
  const { sub, name } = parseTokenArgs(ctx.args);
  if (sub === "create") {
    return runCreate(ctx, name!);
  }
  if (sub === "ls") {
    return runLs(ctx);
  }
  return runRevoke(ctx, name!);
}

export const tokenCommand: Command = {
  name: "token",
  description:
    "Create, list, or revoke named tokens (admin token required)",
  usage:
    "excalicli token create NAME | ls | revoke NAME [--json]\n\n" +
    "Requires an admin token. Non-admin tokens fail with a clear message.\n" +
    "`token create` prints the secret once — it cannot be retrieved again.",
  run: runToken,
};
