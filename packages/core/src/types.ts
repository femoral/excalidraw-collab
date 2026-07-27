/**
 * Shared vocabulary for excalidraw-collab.
 *
 * Runtime dependencies: none. Upstream element types are re-exported via
 * `import type` from `@excalidraw/excalidraw` (devDependency only) so we never
 * drift from the editor's schema.
 */

import type {
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
} from "@excalidraw/excalidraw/element/types";

import type {
  AppState,
  BinaryFiles,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";

// ---------------------------------------------------------------------------
// Upstream element / file types (re-exported, never redeclared)
// ---------------------------------------------------------------------------

export type {
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
};

/** Subset of AppState that is safe to persist (see PLAN.md §4). */
export type PersistedAppState = Pick<
  AppState,
  | "viewBackgroundColor"
  | "gridSize"
  | "gridModeEnabled"
  | "gridStep"
  | "exportBackground"
  | "exportWithDarkMode"
  | "exportScale"
  | "exportEmbedScene"
  | "frameRendering"
  | "theme"
  | "name"
>;

// ---------------------------------------------------------------------------
// Stored-document types
// ---------------------------------------------------------------------------

/**
 * The document payload of a scene version — the three fields that make up
 * an Excalidraw scene blob (elements array, appState whitelist, binary files).
 */
export type SceneDocument = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<PersistedAppState>;
  files: BinaryFiles;
};

/**
 * One committed version in a scene's linear history (PLAN.md §4).
 * The document payload is stored separately (gzipped blobs); this is metadata.
 */
export type SceneVersion = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string; // ISO-8601
};

/**
 * Scene listing / detail metadata (GET /api/scenes, GET /api/scenes/:slug).
 */
export type SceneMeta = {
  id: string;
  slug: string;
  name: string;
  headVersion: number;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  lock: {
    holder: string;
    expiresAt: string; // ISO-8601
  } | null;
};

// ---------------------------------------------------------------------------
// HTTP wire shapes (PLAN.md §7)
// ---------------------------------------------------------------------------

/**
 * POST /api/scenes/:slug/scene body.
 * `author` is derived from the bearer token server-side; clients may still
 * send it for local draft attribution, but the server overwrites it.
 */
export type PushRequest = {
  parentVersion: number;
  elements: readonly ExcalidrawElement[];
  appState?: Partial<PersistedAppState>;
  files?: BinaryFiles;
  author: string;
  message: string;
};

/** 201 response after a successful push. */
export type PushResponse = {
  version: number;
  parentVersion: number;
  author: string;
  message: string;
  createdAt: string; // ISO-8601
};

/**
 * 409 Conflict body: the push's parentVersion does not equal head.
 * Carries the structured diff from parentVersion → head so the client
 * can reconcile in one round trip (PLAN.md §5, §7).
 */
export type ConflictResponse = {
  parentVersion: number;
  headVersion: number;
  diff: SceneDiff;
};

// ---------------------------------------------------------------------------
// Diff / digest declarations only — implementations land in later issues
// ---------------------------------------------------------------------------

export type ElementBBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PropDelta = {
  key: string;
  from: unknown;
  to: unknown;
};

/**
 * One element-level change between two scene versions (PLAN.md §6).
 * Declarations only; the diff engine is a later issue.
 */
export type ElementChange =
  | {
      op: "add";
      id: string;
      type: ExcalidrawElement["type"];
      label: string | null;
      bbox: ElementBBox;
      describe: string;
    }
  | {
      op: "delete";
      id: string;
      type: ExcalidrawElement["type"];
      label: string | null;
      describe: string;
    }
  | {
      op: "update";
      id: string;
      type: ExcalidrawElement["type"];
      label: string | null;
      props: PropDelta[];
      describe: string;
    }
  | {
      op: "reorder";
      id: string;
      type: ExcalidrawElement["type"];
      label: string | null;
      from: number;
      to: number;
    };

/**
 * Structured diff between two scene versions (PLAN.md §6).
 * Declarations only; the diff engine is a later issue.
 */
export type SceneDiff = {
  from: number;
  to: number;
  summary: {
    added: number;
    deleted: number;
    updated: number;
    reordered: number;
  };
  elements: ElementChange[];
  appState: PropDelta[];
};

/**
 * One row in a scene digest's element listing (PLAN.md §6 `describe`).
 * Spatial order is top-to-bottom, then left-to-right (tie-break by id).
 */
export type DigestElement = {
  id: string;
  type: ExcalidrawElement["type"];
  /** Resolved display label (bound text, own text, or frame name). */
  label: string | null;
  bbox: ElementBBox;
  frameId: string | null;
  groupIds: readonly GroupId[];
};

/**
 * Text outline of a scene for agents that cannot see a canvas
 * (`excalicli describe` — PLAN.md §6).
 *
 * Produced by `digestScene`. The structured form keeps ids for tooling;
 * `formatDigest` omits them unless `verbose` is set.
 */
export type SceneDigest = {
  /** Non-deleted element count (includes bound text and arrows). */
  elementCount: number;
  /**
   * Counts by `type` over non-deleted elements. Key order is alphabetical
   * so `JSON.stringify` is stable.
   */
  countsByType: { [type: string]: number };
  /** Axis-aligned bounds of all non-deleted elements; null if empty. */
  bbox: ElementBBox | null;
  /** Non-deleted frame count. */
  frameCount: number;
  /**
   * True when the element listing was capped by `maxElements`. The edge
   * list is never truncated — graph structure always ships complete.
   */
  truncated: boolean;
  /** How many listable elements were dropped by the cap (0 if not truncated). */
  omitted: number;
  frames: Array<{
    id: string;
    name: string | null;
    /** Child element ids (non-deleted), spatial order. */
    children: string[];
  }>;
  groups: Array<{
    groupId: GroupId;
    /** Member element ids (non-deleted), spatial order. */
    members: string[];
  }>;
  /**
   * Arrows as an edge list. `from` / `to` are **resolved endpoint labels**
   * (bound-text label, else type name); null means unbound.
   * Always complete — never subject to the element-listing cap.
   */
  edges: Array<{
    id: string;
    from: string | null;
    to: string | null;
    label: string | null;
  }>;
  /**
   * Flat element listing (listable elements only — excludes arrows and
   * container-bound text, which appear as edges / labels). May be capped.
   */
  elements: DigestElement[];
};
