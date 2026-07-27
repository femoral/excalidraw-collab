/**
 * `excalicli restore backup.tar.gz [--on-collision skip|overwrite|abort]`
 *
 * Uploads a portable archive to the server. Collision policy is always
 * explicit in the response (never silent skip/overwrite).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiFetch } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";

export type CollisionPolicy = "skip" | "overwrite" | "abort";

export type RestoreReport = {
  collisionPolicy: CollisionPolicy;
  restored: string[];
  skipped: string[];
  overwritten: string[];
  filesRestored: number;
  messages: string[];
};

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALICLI_SERVER and EXCALICLI_TOKEN, or run `excalicli login`.",
      { code: "USAGE" },
    );
  }
}

function parseRestoreArgs(args: string[]): {
  archive: string;
  onCollision: CollisionPolicy;
} {
  let values: { "on-collision"?: string; onCollision?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        "on-collision": { type: "string" },
        onCollision: { type: "string" },
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
      "restore requires ARCHIVE.tar.gz\n\n" +
        "Usage: excalicli restore backup.tar.gz [--on-collision skip|overwrite|abort]",
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected arguments: ${positionals.slice(1).join(" ")}\n\n` +
        "Usage: excalicli restore backup.tar.gz [--on-collision skip|overwrite|abort]",
    );
  }

  const archive = positionals[0]!.trim();
  if (archive.length === 0) {
    throw new UsageError("restore requires a non-empty ARCHIVE path");
  }

  const rawPolicy = (
    values["on-collision"] ??
    values.onCollision ??
    "skip"
  )
    .trim()
    .toLowerCase();
  if (rawPolicy !== "skip" && rawPolicy !== "overwrite" && rawPolicy !== "abort") {
    throw new UsageError(
      `--on-collision must be skip|overwrite|abort (got ${JSON.stringify(rawPolicy)})`,
    );
  }

  return { archive, onCollision: rawPolicy };
}

async function runRestore(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { archive, onCollision } = parseRestoreArgs(ctx.args);

  const abs = path.isAbsolute(archive)
    ? archive
    : path.join(ctx.cwd, archive);
  if (!fs.existsSync(abs)) {
    throw new CliError(`backup file not found: ${archive}`, { code: "ERROR" });
  }
  const bytes = fs.readFileSync(abs);
  if (bytes.byteLength === 0) {
    throw new CliError("backup file is empty", { code: "VALIDATION" });
  }

  const qs = `?onCollision=${encodeURIComponent(onCollision)}`;
  const report = await apiFetch<RestoreReport>({
    path: `/api/restore${qs}`,
    method: "POST",
    config: ctx.config,
    headers: {
      "Content-Type": "application/gzip",
      Accept: "application/json",
    },
    body: bytes,
  });

  const lines = [
    `Restore complete (policy=${report.collisionPolicy}).`,
    `  restored:     ${report.restored.length ? report.restored.join(", ") : "(none)"}`,
    `  skipped:      ${report.skipped.length ? report.skipped.join(", ") : "(none)"}`,
    `  overwritten:  ${report.overwritten.length ? report.overwritten.join(", ") : "(none)"}`,
    `  files:        ${report.filesRestored}`,
  ];
  if (report.messages.length > 0) {
    lines.push("", "Details:");
    for (const m of report.messages) {
      lines.push(`  - ${m}`);
    }
  }
  lines.push("");

  return {
    data: report,
    human: lines.join("\n"),
  };
}

export const restoreCommand: Command = {
  name: "restore",
  description:
    "Restore a portable backup archive into the server (explicit collision policy)",
  usage:
    "excalicli restore backup.tar.gz [--on-collision skip|overwrite|abort] [--json]\n\n" +
    "  ARCHIVE                 Path to a .tar.gz produced by `excalicli backup`.\n" +
    "  --on-collision POLICY   What to do when a scene slug already exists:\n" +
    "                            skip       leave existing scene (default); report it\n" +
    "                            overwrite  replace existing scene + history\n" +
    "                            abort      fail on first collision (409)\n\n" +
    "Requires an admin token. Never silent: stdout (or --json) always lists\n" +
    "what was restored, skipped, and overwritten.\n\n" +
    "Tokens are not restored (secrets are never in the archive). Version\n" +
    "authorship names, messages, parent links, and image bytes are preserved.",
  run: runRestore,
};
