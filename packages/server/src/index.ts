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
  registerWhoamiRoute,
  seedBootstrapToken,
  tokenHashesEqual,
  type RequestIdentity,
  type WhoamiInfo,
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
  collectReferencedFileIds,
  deterministicVersionNonce,
  formatMergeCommitMessage,
  MERGE_WORKER_DISABLED_MESSAGE,
  parseMergeQuery,
  prepareLocalElementsForMerge,
  type MergePushExtras,
  type SceneMergeService,
} from "./merge.js";
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
  META_INSTANCE_THEME,
  type InstanceTheme,
  type SceneRow,
  type SceneListRow,
  type VersionRow,
  type DraftRow,
  type TokenRow,
  type MetaRow,
  type SchemaMigrationRow,
  type NewScene,
  type NewVersion,
  type CommitVersionResult,
  type UpsertDraft,
  type NewToken,
  type OpenDatabaseOptions,
} from "./db.js";
export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_README,
  COLLISION_POLICIES,
  RESTORE_BODY_LIMIT,
  buildBackupArchive,
  registerBackupRoutes,
  restoreBackupArchive,
  type BackupManifest,
  type CollisionPolicy,
  type RestoreReport,
  type SceneMetaJson,
  type VersionJson,
} from "./backup.js";
export {
  packTar,
  packTarGz,
  unpackTar,
  unpackTarGz,
  type TarEntry,
} from "./tar.js";
export {
  emptySceneDocument,
  rehydrateSceneFiles,
  resolveVersionRef,
  storeSceneFiles,
  toPushResponse,
  toVersionInfo,
  versionToDocument,
  VERSIONS_DEFAULT_LIMIT,
  VERSIONS_MAX_LIMIT,
  type ConflictDetails,
  type PushVersionResponse,
  type VersionInfo,
} from "./versions.js";
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
export type { SceneInfo } from "./scenes.js";
export {
  registerSettingsRoutes,
  type ThemeSettings,
} from "./settings.js";
export {
  allocateSlug,
  isSceneLockActive,
  isValidSlug,
  slugifyName,
  toLock,
  SLUG_MAX_LENGTH,
} from "./scenes.js";
export {
  DEFAULT_LOCK_TTL_SECONDS,
  MAX_LOCK_TTL_SECONDS,
  registerLockRoutes,
  type ClaimLockBody,
  type LockInfo,
} from "./locks.js";
export {
  DiffCache,
  DEFAULT_DIFF_CACHE_MAX,
  diffCacheKey,
  registerDiffRoutes,
  SceneDiffService,
  formatDiff,
  isEmptyDiff,
} from "./diff.js";
export {
  registerDraftRoutes,
  toDraftResponse,
  type DraftResponse,
  type PutDraftResponse,
} from "./drafts.js";
export {
  EVENTS_TIMEOUT_MS,
  GLOBAL_EVENT_BUFFER_LIMIT,
  registerEventRoutes,
  SceneEventHub,
  type GlobalSceneEvent,
  type MultiplexedEventsResponse,
  type PublishLockDetail,
  type PublishVersionDetail,
  type SceneEventResponse,
} from "./events.js";
export {
  registerSkeletonRoutes,
  validateSkeletonElements,
  validateSkeletonEntry,
  SKELETON_TYPES,
  SKELETON_WORKER_DISABLED_MESSAGE,
  type SkeletonConverter,
  type SkeletonConverterHolder,
  type SkeletonErrorDetails,
} from "./skeleton.js";
export {
  DEFAULT_RENDER_SCALE,
  MAX_RENDER_SCALE,
  etagMatches,
  isRenderNotInstalledError,
  mapWorkerRenderError,
  parseRenderDark,
  parseRenderScale,
  registerRenderRoutes,
  renderWorkerDisabledError,
  renderWorkerNotInstalledError,
  SceneRenderService,
  type RenderUnavailableReason,
  type SceneRenderResult,
  type SceneRenderWorker,
} from "./render.js";
export {
  RENDERS_SUBDIR,
  RenderCache,
  optionsFileStem,
  renderCacheEtag,
  renderCachePath,
  type RenderCacheKey,
  type RenderCacheOptions,
  type RenderFormat,
} from "./render-cache.js";
