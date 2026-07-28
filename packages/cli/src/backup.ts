/**
 * `excali backup -o backup.tar.gz`
 *
 * Downloads a portable server archive (every scene, all versions, all files)
 * produced via the SQLite backup API. Layout is documented inside the archive
 * (README.md + MANIFEST.json) and below in --help.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { apiFetchBinary } from "./api.js";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";

function requireAuth(ctx: CommandContext): void {
  if (!ctx.config.server || !ctx.config.token) {
    throw new CliError(
      "No server/token configured. Set EXCALI_SERVER and EXCALI_TOKEN, or run `excali login`.",
      { code: "USAGE" },
    );
  }
}

function parseBackupArgs(args: string[]): { output: string } {
  let values: { o?: string; output?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        o: { type: "string", short: "o" },
        output: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as { o?: string; output?: string };
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length > 0) {
    throw new UsageError(
      `unexpected arguments: ${positionals.join(" ")}\n\n` +
        "Usage: excali backup -o backup.tar.gz",
    );
  }

  const output = values.output ?? values.o;
  if (!output || output.trim().length === 0) {
    throw new UsageError(
      "backup requires -o / --output PATH\n\n" + "Usage: excali backup -o backup.tar.gz",
    );
  }

  return { output: output.trim() };
}

async function runBackup(ctx: CommandContext): Promise<CommandResult> {
  requireAuth(ctx);
  const { output } = parseBackupArgs(ctx.args);

  const result = await apiFetchBinary({
    path: "/api/backup",
    method: "GET",
    config: ctx.config,
    headers: { Accept: "application/gzip, application/json" },
  });

  const sceneCount = headerInt(result.headers, "x-backup-scene-count");
  const fileCount = headerInt(result.headers, "x-backup-file-count");

  if (output === "-") {
    // Stream raw archive bytes; no JSON trailer.
    ctx.io?.stdout.write(result.bytes);
    return {
      data: {
        path: "-",
        bytes: result.bytes.byteLength,
        sceneCount,
        fileCount,
      },
      streamed: true,
      human: "",
    };
  }

  const abs = path.isAbsolute(output) ? output : path.join(ctx.cwd, output);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, result.bytes);

  const data = {
    path: output,
    bytes: result.bytes.byteLength,
    sceneCount,
    fileCount,
  };

  return {
    data,
    human:
      `Wrote backup ${output} (${result.bytes.byteLength} bytes` +
      (sceneCount !== undefined ? `, ${sceneCount} scene(s)` : "") +
      (fileCount !== undefined ? `, ${fileCount} file(s)` : "") +
      `).\n` +
      `Archive layout is documented inside as README.md / MANIFEST.json.\n`,
  };
}

function headerInt(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export const backupCommand: Command = {
  name: "backup",
  description: "Download a full portable server backup (.tar.gz) of every scene, version, and file",
  usage:
    "excali backup -o backup.tar.gz [--json]\n\n" +
    "  -o, --output PATH   Write the archive here (use - for stdout).\n\n" +
    "Requires an admin token. The server builds a consistent SQLite snapshot\n" +
    "(sqlite.backup API — never a live WAL copy) and packs a documented,\n" +
    "human-readable layout:\n\n" +
    "  README.md\n" +
    "  MANIFEST.json\n" +
    "  scenes/<slug>/meta.json\n" +
    "  scenes/<slug>/versions/<N>.json   # elements, appState, author, message\n" +
    "  files/<fileId>                    # raw bytes\n" +
    "  files/<fileId>.json               # mimeType, created\n\n" +
    "Tokens/secrets are not included; version authorship (names) is preserved.\n" +
    "Restore with: excali restore backup.tar.gz\n" +
    "Escape hatch without history: excali pull --all -o dir/",
  run: runBackup,
};
