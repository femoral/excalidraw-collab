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
  DEFAULT_MAX_FILE_BYTES,
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
export {
  FileStore,
  gcUnreferencedFiles,
  hashFileContent,
  decodeDataURL,
  claimedFileIdMismatchError,
  registerFileRoutes,
  FILES_SUBDIR,
  SIDECAR_SUFFIX,
  FILE_ID_HEX_RE,
  FILE_ID_REASON_HASH_MISMATCH,
  FILE_ID_REASON_NON_SECURE_NANOID,
  IMMUTABLE_CACHE_CONTROL,
  type FileSidecar,
  type StoredFile,
  type PutFileResult,
  type GcOptions,
  type GcResult,
  type FileIdMismatchReason,
  type FileIdMismatchDetails,
} from "./files.js";
export type { TokenCreated, TokenInfo } from "./tokens.js";
