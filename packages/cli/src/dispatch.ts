import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import {
  getCommand,
  listCommands,
  type CommandContext,
  type IoStreams,
} from "./commands.js";
import {
  CliError,
  ExitCode,
  UsageError,
  toErrorEnvelope,
  type ExitCodeValue,
} from "./errors.js";
import { formatHuman, formatJson, type CommandResult } from "./format.js";

export type { IoStreams };

export type RunOptions = {
  /** argv without node/executable (e.g. process.argv.slice(2)). */
  argv: string[];
  env?: NodeJS.ProcessEnv;
  io?: IoStreams;
  /**
   * Working directory for local state and relative scene paths.
   * Defaults to `process.cwd()`. Tests pass a temp dir.
   */
  cwd?: string;
  /**
   * Abort signal for long-running commands (e.g. `watch`). When omitted and
   * running against real process streams, SIGINT aborts the signal so watch
   * exits cleanly.
   */
  signal?: AbortSignal;
};

function globalUsage(): string {
  const cmds = listCommands();
  const lines = [
    "Usage: excalicli [--json] <command> [options]",
    "",
    "Global options:",
    "  --json       Emit exactly one JSON value on stdout",
    "  -h, --help   Show help",
    "",
    "Commands:",
  ];
  const width = Math.max(8, ...cmds.map((c) => c.name.length));
  for (const c of cmds) {
    lines.push(`  ${c.name.padEnd(width)}  ${c.description}`);
  }
  lines.push("");
  lines.push("Run `excalicli <command> --help` for command-specific help.");
  lines.push("");
  return lines.join("\n");
}

function commandUsage(name: string): string {
  const cmd = getCommand(name);
  if (!cmd) {
    return globalUsage();
  }
  const lines = [
    `Usage: ${cmd.usage ?? `excalicli ${cmd.name} [options]`}`,
    "",
    cmd.description,
    "",
    "Global options:",
    "  --json       Emit exactly one JSON value on stdout",
    "  -h, --help   Show help",
    "",
  ];
  return lines.join("\n");
}

function writeSuccess(
  io: IoStreams,
  result: CommandResult,
  json: boolean,
): void {
  if (result.warning) {
    const msg = result.warning.endsWith("\n")
      ? result.warning
      : `${result.warning}\n`;
    io.stderr.write(msg);
  }
  // Streaming commands (watch JSONL) already wrote; do not emit a trailer.
  if (result.streamed) return;
  if (json) {
    io.stdout.write(formatJson(result.data));
  } else {
    io.stdout.write(result.human ?? formatHuman(result.data));
  }
}

function writeFailure(
  io: IoStreams,
  err: CliError,
  json: boolean,
): ExitCodeValue {
  // Stream discipline: human diagnostics always on stderr.
  // Under --json, also emit exactly one JSON error object on stdout so
  // agents can parse without half-JSON or mixed streams on the data channel.
  if (json) {
    io.stdout.write(formatJson(toErrorEnvelope(err)));
  }
  io.stderr.write(`${err.message}\n`);
  return err.exitCode;
}

/**
 * Peel global `--json` / `--help` / `-h` from argv and rebuild the remaining
 * tokens so per-command options (e.g. `login --server URL --token T`) are not
 * swallowed by the global parser. With `strict: false`, unknown flags are
 * treated as booleans and their values become positionals — tokens let us
 * reassemble the original shape for the subcommand.
 */
function peelGlobalArgs(argv: string[]): {
  json: boolean;
  help: boolean;
  /** Argv with only global flags removed (command name + its args/options). */
  rest: string[];
} {
  const parsed = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const rest: string[] = [];
  for (const token of parsed.tokens ?? []) {
    if (token.kind === "option") {
      if (token.name === "json" || token.name === "help") {
        continue;
      }
      // Unknown option: re-emit so the subcommand's parseArgs sees it.
      if (token.inlineValue === true && token.value !== undefined) {
        rest.push(`${token.rawName}=${token.value}`);
      } else {
        rest.push(token.rawName);
      }
      continue;
    }
    if (token.kind === "positional") {
      rest.push(token.value);
      continue;
    }
    if (token.kind === "option-terminator") {
      rest.push("--");
    }
  }

  const values = parsed.values as { help?: boolean; json?: boolean };
  return {
    json: values.json === true,
    help: values.help === true,
    rest,
  };
}

/**
 * Parse argv, dispatch to a command, render the result.
 * Commands return values; this function is the only place that writes streams.
 */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
  const env = options.env ?? process.env;
  const io: IoStreams = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };

  let json = false;

  try {
    // Global parse: strip only --json/--help; pass every other token through.
    let help = false;
    let argvRest: string[];
    try {
      const peeled = peelGlobalArgs(options.argv);
      json = peeled.json;
      help = peeled.help;
      argvRest = peeled.rest;
    } catch (err) {
      throw new UsageError(
        err instanceof Error ? err.message : String(err),
      );
    }

    const [commandName, ...rest] = argvRest;

    // No subcommand: print help (and exit 0). Agents use --json for a machine list.
    if (!commandName) {
      if (json) {
        io.stdout.write(
          formatJson({
            name: "excalicli",
            commands: listCommands().map((c) => ({
              name: c.name,
              description: c.description,
            })),
          }),
        );
      } else {
        io.stdout.write(globalUsage());
      }
      return ExitCode.OK;
    }

    const command = getCommand(commandName);
    if (!command) {
      throw new UsageError(
        `Unknown command: ${commandName}\n\n${globalUsage().trimEnd()}`,
      );
    }

    // Per-command help: `excalicli version --help`
    if (help || rest.includes("--help") || rest.includes("-h")) {
      if (json) {
        io.stdout.write(
          formatJson({
            name: command.name,
            description: command.description,
            usage: command.usage ?? `excalicli ${command.name}`,
          }),
        );
      } else {
        io.stdout.write(commandUsage(commandName));
      }
      return ExitCode.OK;
    }

    const config = loadConfig(env);
    // Long-running commands honour AbortSignal. When the caller did not pass
    // one and we own the process streams, wire SIGINT so `watch` exits cleanly.
    let signal = options.signal;
    let removeSigint: (() => void) | undefined;
    if (!signal && io.stdout === process.stdout) {
      const ac = new AbortController();
      signal = ac.signal;
      const onSigint = (): void => {
        ac.abort();
      };
      process.once("SIGINT", onSigint);
      removeSigint = () => {
        process.off("SIGINT", onSigint);
      };
    }

    const ctx: CommandContext = {
      json,
      args: rest,
      env,
      config,
      cwd: options.cwd ?? process.cwd(),
      io,
      signal,
    };

    try {
      const result = await command.run(ctx);
      writeSuccess(io, result, json);
      return ExitCode.OK;
    } finally {
      removeSigint?.();
    }
  } catch (err) {
    if (err instanceof CliError) {
      return writeFailure(io, err, json);
    }
    // Abort from SIGINT / test controller is a clean stop for watch.
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      return ExitCode.OK;
    }
    const wrapped = new CliError(
      err instanceof Error ? err.message : String(err),
      { code: "ERROR", cause: err },
    );
    return writeFailure(io, wrapped, json);
  }
}
