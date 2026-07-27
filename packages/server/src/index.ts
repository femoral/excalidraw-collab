/**
 * Public surface of `@excalidraw-collab/server`.
 * The CLI imports error codes from here to derive exit codes mechanically.
 */
export { buildApp, type BuildAppDeps, type ReadinessCheck } from "./app.js";
export {
  ADMIN_TOKEN_NAME,
  authorFromIdentity,
  generateTokenSecret,
  isAdminIdentity,
  seedBootstrapToken,
  tokenHashesEqual,
  type RequestIdentity,
} from "./auth.js";
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
export {
  Database,
  openDatabase,
  gzipJson,
  gunzipJson,
  hashToken,
  nowIso,
  DB_FILENAME,
  BUSY_TIMEOUT_MS,
  META_BOOTSTRAP_COMPLETED,
  type SceneRow,
  type VersionRow,
  type DraftRow,
  type TokenRow,
  type MetaRow,
  type SchemaMigrationRow,
  type NewScene,
  type NewVersion,
  type UpsertDraft,
  type NewToken,
  type OpenDatabaseOptions,
} from "./db.js";
export type { TokenCreated, TokenInfo } from "./tokens.js";
