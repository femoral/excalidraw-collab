/**
 * `excali turn claim|release SLUG` — advisory turn lock.
 *
 * Purely polite: claim fails with exit 5 when someone else holds an active
 * lock, but the scene can still be pushed without the lock.
 */
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";

export type LockInfo = {
  holder: string;
  expiresAt: string;
};

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }
}

function parseTurnArgs(args: string[]): {
  sub: "claim" | "release";
  slug: string;
  ttl?: number;
} {
  let values: { ttl?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        ttl: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { ttl?: string };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const [sub, slug, ...extra] = positionals;
  if (!sub) {
    throw new UsageError(
      "turn requires a subcommand: claim | release\n\n" +
        "Usage:\n" +
        "  excali turn claim SLUG [--ttl SECONDS]\n" +
        "  excali turn release SLUG",
    );
  }
  if (sub !== "claim" && sub !== "release") {
    throw new UsageError(
      `unknown turn subcommand: ${sub}\n\n` +
        "Usage:\n" +
        "  excali turn claim SLUG [--ttl SECONDS]\n" +
        "  excali turn release SLUG",
    );
  }
  if (!slug || slug.trim() === "") {
    throw new UsageError(
      `turn ${sub} requires SLUG\n\nUsage: excali turn ${sub} SLUG` +
        (sub === "claim" ? " [--ttl SECONDS]" : ""),
    );
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected arguments: ${extra.join(" ")}`);
  }

  let ttl: number | undefined;
  if (values.ttl !== undefined) {
    if (sub !== "claim") {
      throw new UsageError("turn release does not take --ttl");
    }
    const n = Number(values.ttl);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError("--ttl must be a positive integer (seconds)");
    }
    ttl = n;
  }

  return { sub, slug: slug.trim(), ttl };
}

async function runClaim(ctx: CommandContext, slug: string, ttl?: number): Promise<CommandResult> {
  requireAuth(ctx);

  const body: { ttl?: number } = {};
  if (ttl !== undefined) body.ttl = ttl;

  let lock: LockInfo;
  try {
    lock = await apiFetch<LockInfo>({
      path: `/api/scenes/${encodeURIComponent(slug)}/lock`,
      method: "POST",
      config: ctx.config,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof CliError && err.code === "LOCK_HELD") {
      const details = err.details as LockInfo | undefined;
      const holder = details?.holder ?? "another identity";
      const until = details?.expiresAt ? ` until ${details.expiresAt}` : "";
      throw new CliError(
        `Turn held by ${holder}${until}.\n` +
          `Release with: excali turn release ${slug}\n` +
          `Or push without the lock (advisory only).`,
        {
          code: "LOCK_HELD",
          details: err.details,
        },
      );
    }
    throw err;
  }

  const data = {
    slug,
    action: "claim" as const,
    holder: lock.holder,
    expiresAt: lock.expiresAt,
  };

  return {
    data,
    human: `Claimed turn on ${slug} as ${lock.holder}\n` + `expires: ${lock.expiresAt}\n`,
  };
}

async function runRelease(ctx: CommandContext, slug: string): Promise<CommandResult> {
  requireAuth(ctx);

  await apiFetch<void>({
    path: `/api/scenes/${encodeURIComponent(slug)}/lock`,
    method: "DELETE",
    config: ctx.config,
  });

  const data = {
    slug,
    action: "release" as const,
  };

  return {
    data,
    human: `Released turn on ${slug}\n`,
  };
}

async function runTurn(ctx: CommandContext): Promise<CommandResult> {
  const { sub, slug, ttl } = parseTurnArgs(ctx.args);
  if (sub === "claim") {
    return runClaim(ctx, slug, ttl);
  }
  return runRelease(ctx, slug);
}

export const turnCommand: Command = {
  name: "turn",
  description: "Claim or release the advisory turn lock on a scene (politeness, not enforcement)",
  usage:
    "excali turn claim SLUG [--ttl SECONDS] | release SLUG [--json]\n\n" +
    "  claim    Hold the turn for this token's identity (default TTL 30 min)\n" +
    "  release  Free the turn (any identity may release — crash recovery)\n" +
    "  --ttl    Claim lifetime in seconds\n\n" +
    "Exit 5 (LOCK_HELD) when claim fails because someone else holds the turn.\n" +
    "Locks never block push unless you pass --respect-lock to push.",
  run: runTurn,
};
