/**
 * Public surface of `@excalidraw-collab/server`.
 * The CLI imports error codes from here to derive exit codes mechanically.
 */
export { buildApp, type BuildAppDeps, type ReadinessCheck } from "./app.js";
export {
  loadConfig,
  ConfigError,
  type Config,
  type LogLevel,
  type RenderWorkerMode,
} from "./config.js";
export {
  AppError,
  ErrorCode,
  ExitCode,
  errorEnvelope,
  exitCodeForError,
  type ErrorEnvelope,
} from "./errors.js";
