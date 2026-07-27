/**
 * @excalidraw-collab/core — pure TypeScript types, scene normalization,
 * validation, the element diff engine, and the scene digest.
 * Zero runtime dependencies.
 */

export type {
  // Upstream re-exports
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  ExcalidrawImageElement,
  ExcalidrawFrameElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawArrowElement,
  ExcalidrawRectangleElement,
  ExcalidrawEllipseElement,
  ExcalidrawDiamondElement,
  ExcalidrawEmbeddableElement,
  ExcalidrawIframeElement,
  NonDeletedExcalidrawElement,
  NonDeleted,
  OrderedExcalidrawElement,
  ElementsMap,
  GroupId,
  FileId,
  AppState,
  BinaryFiles,
  BinaryFileData,
  DataURL,
  // Stored documents
  PersistedAppState,
  SceneDocument,
  SceneVersion,
  SceneMeta,
  // HTTP wire
  PushRequest,
  PushResponse,
  ConflictResponse,
  // Diff / digest
  ElementBBox,
  PropDelta,
  ElementChange,
  SceneDiff,
  SceneDigest,
  DigestElement,
} from "./types.js";

export {
  normalizeScene,
  pickAppState,
  SceneValidationError,
  PERSISTED_APP_STATE_KEYS,
} from "./normalize.js";

export { splitFiles, mergeFiles } from "./files.js";

export { sceneHash } from "./hash.js";

export {
  digestScene,
  formatDigest,
  resolveElementLabel,
  DEFAULT_DIGEST_MAX_ELEMENTS,
} from "./digest.js";
export type { DigestOptions, FormatDigestOptions } from "./digest.js";

export {
  diffScenes,
  formatDiff,
  formatAppStateValue,
  isEmptyDiff,
  elementHasMeaningfulChange,
  APP_STATE_DEFAULTS,
  type DiffScenesOptions,
} from "./diff.js";
