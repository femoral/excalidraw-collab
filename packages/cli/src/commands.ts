import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult } from "./format.js";
import { formatTable } from "./format.js";
import type { ResolvedConfig } from "./config.js";
import { backupCommand } from "./backup.js";
import { describeCommand } from "./describe.js";
import { diffCommand } from "./diff.js";
import { exportCommand } from "./export.js";
import { loginCommand } from "./login.js";
import { logCommand } from "./log.js";
import { lsCommand } from "./ls.js";
import { newCommand } from "./new.js";
import { pullCommand } from "./pull.js";
import { pushCommand } from "./push.js";
import { restoreCommand } from "./restore.js";
import { skillsCommand } from "./skills.js";
import { turnCommand } from "./turn.js";
import { whoamiCommand } from "./whoami.js";
import { tokenCommand } from "./token.js";
import { watchCommand } from "./watch.js";

/** Stream handles the dispatcher (and streaming commands) write to. */
export type IoStreams = {
  /** Accepts strings or binary (export `-o -` PNG/SVG). */
  stdout: { write(chunk: string | Uint8Array): void };
  stderr: { write(chunk: string | Uint8Array): void };
};

/** Runtime context passed into every command. */
export type CommandContext = {
  /** Global `--json` flag (commands must not print; dispatcher renders). */
  json: boolean;
  /** Remaining argv after the subcommand name (for per-command parseArgs). */
  args: string[];
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  /**
   * Working directory for local state (`.excalidraw-collab/state.json`) and
   * relative scene file paths. Injectable in tests; defaults to process.cwd().
   */
  cwd: string;
  /**
   * stdout/stderr for streaming commands (`watch` JSONL / incremental diffs).
   * Most commands return a {@link CommandResult} instead of writing.
   */
  io?: IoStreams;
  /**
   * Abort signal for long-running commands. `watch` stops when aborted;
   * tests inject a controller to bound the loop without SIGINT.
   */
  signal?: AbortSignal;
};

export type Command = {
  name: string;
  description: string;
  /**
   * Run the command. Return a result value — never write to stdout/stderr.
   * Throw {@link import("./errors.js").CliError} / UsageError on failure.
   */
  run: (ctx: CommandContext) => CommandResult | Promise<CommandResult>;
  /** Optional extra help lines for `excali <cmd> --help`. */
  usage?: string;
};

const registry = new Map<string, Command>();

export function registerCommand(command: Command): void {
  registry.set(command.name, command);
}

export function getCommand(name: string): Command | undefined {
  return registry.get(name);
}

export function listCommands(): Command[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Package version, read from the shipped package.json (`dist/` sits one level
 * below it both in the repo and in the published tarball) so it cannot drift.
 */
export const CLI_VERSION: string = readPackageVersion();

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.resolve(here, "../package.json"), "utf8");
  const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json is missing a version");
  }
  return version;
}

/**
 * Stub command that exercises both human-table and `--json` output modes.
 */
const versionCommand: Command = {
  name: "version",
  description: "Print CLI version",
  usage: "excali version [--json]",
  run(): CommandResult {
    const data = {
      name: "excali",
      version: CLI_VERSION,
    };
    return {
      data,
      human: formatTable([data], ["name", "version"]),
    };
  },
};

registerCommand(versionCommand);
registerCommand(loginCommand);
registerCommand(whoamiCommand);
registerCommand(tokenCommand);
registerCommand(lsCommand);
registerCommand(newCommand);
registerCommand(pullCommand);
registerCommand(pushCommand);
registerCommand(turnCommand);
registerCommand(watchCommand);
registerCommand(diffCommand);
registerCommand(describeCommand);
registerCommand(logCommand);
registerCommand(exportCommand);
registerCommand(backupCommand);
registerCommand(restoreCommand);
registerCommand(skillsCommand);
