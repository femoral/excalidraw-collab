#!/usr/bin/env node
/**
 * excalicli — CLI shell for excalidraw-collab (agent-first).
 *
 * Later issues plug commands into the registry in commands.ts.
 * This package owns: dispatch, config, --json rendering, exit codes, apiFetch.
 */

import { run } from "./dispatch.js";

// Re-exports for tests and for commands added in later packages/issues.
export { run } from "./dispatch.js";
export { loadConfig, readConfigFile, writeConfigFile, configPath, configDir } from "./config.js";
export type { FileConfig, ResolvedConfig } from "./config.js";
export {
  CliError,
  UsageError,
  ExitCode,
  exitCodeForError,
  SERVER_ERROR_CODES,
  toErrorEnvelope,
} from "./errors.js";
export type { ServerErrorCode, ErrorEnvelope, ExitCodeValue } from "./errors.js";
export { apiFetch, apiFetchResult, apiFetchText } from "./api.js";
export type {
  ApiFetchOptions,
  ApiFetchResult,
  ServerErrorBody,
} from "./api.js";
export { formatTable, formatHuman, formatJson } from "./format.js";
export type { CommandResult } from "./format.js";
export {
  registerCommand,
  getCommand,
  listCommands,
  CLI_VERSION,
} from "./commands.js";
export type { Command, CommandContext, IoStreams } from "./commands.js";
export {
  getPulledVersion,
  setPulledVersion,
  readLocalState,
  writeLocalState,
  statePath,
  normalizeServerKey,
  emptyLocalState,
} from "./state.js";
export type { LocalState, SceneState, ServerState } from "./state.js";
export {
  formatConflictDiff,
  formatConflictMessage,
  resolutionCommands,
} from "./conflict.js";
export type { ConflictDetails, ConflictDiff } from "./conflict.js";
export type { SceneEventResponse, WatchEvent } from "./watch.js";

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith(`${"/"}index.js`) ||
    process.argv[1].endsWith(`${"\\"}index.js`) ||
    process.argv[1].endsWith("excalicli"));

if (isMain) {
  const code = await run({ argv: process.argv.slice(2) });
  process.exit(code);
}
