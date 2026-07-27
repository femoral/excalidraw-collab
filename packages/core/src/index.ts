/**
 * @excalidraw-collab/core — pure TypeScript types, (future) diff engine,
 * scene digest, and validation. Zero runtime dependencies.
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
  // Diff / digest (declarations only)
  ElementBBox,
  PropDelta,
  ElementChange,
  SceneDiff,
  SceneDigest,
} from "./types.js";
