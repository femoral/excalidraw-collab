/**
 * Pure helpers for the version history UI: timeline ordering, two-version
 * selection, diff grouping/prioritisation for large scenes, and restore
 * payloads.
 *
 * Kept free of React so `node:test` covers the decision logic without a
 * browser harness. HistoryView stays thin around these.
 */

import { pickAppState } from "@excalidraw-collab/core";
import type {
  BinaryFilePayload,
  CommitSceneBody,
  DiffElementChange,
  DiffPropDelta,
  DiffSummary,
  SceneDiffResponse,
  VersionInfo,
} from "./api.ts";

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** Newest-first ordering (server default). Stable for equal versions. */
export function orderVersionsNewestFirst(versions: readonly VersionInfo[]): VersionInfo[] {
  return [...versions].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return 0;
  });
}

/** Parent ref used when computing per-commit change counts. */
export function parentRefForVersion(v: VersionInfo): number {
  if (v.parentVersion != null && v.parentVersion >= 0) return v.parentVersion;
  // First commit's parent is the empty base.
  return Math.max(0, v.version - 1);
}

export function formatChangeCounts(summary: DiffSummary): string {
  const parts: string[] = [];
  if (summary.added) parts.push(`+${summary.added}`);
  if (summary.deleted) parts.push(`−${summary.deleted}`);
  if (summary.updated) parts.push(`~${summary.updated}`);
  if (summary.reordered) parts.push(`↻${summary.reordered}`);
  if (parts.length === 0) return "no changes";
  return parts.join(" ");
}

export function totalChangeCount(summary: DiffSummary): number {
  return summary.added + summary.deleted + summary.updated + summary.reordered;
}

export function emptyDiffSummary(): DiffSummary {
  return { added: 0, deleted: 0, updated: 0, reordered: 0 };
}

/**
 * Format an ISO timestamp for the timeline.
 * Uses a compact locale string; clock-injectable for tests.
 */
export function formatVersionTimestamp(
  iso: string,
  nowMs: number = Date.now(),
): { absolute: string; relative: string } {
  const t = Date.parse(iso);
  const absolute = Number.isFinite(t)
    ? new Date(t).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : iso;

  if (!Number.isFinite(t)) {
    return { absolute, relative: "" };
  }

  const deltaSec = Math.round((nowMs - t) / 1000);
  let relative: string;
  if (deltaSec < 0) relative = absolute;
  else if (deltaSec < 60) relative = "just now";
  else if (deltaSec < 3600) {
    const m = Math.floor(deltaSec / 60);
    relative = `${m}m ago`;
  } else if (deltaSec < 86400) {
    const h = Math.floor(deltaSec / 3600);
    relative = `${h}h ago`;
  } else if (deltaSec < 86400 * 14) {
    const d = Math.floor(deltaSec / 86400);
    relative = `${d}d ago`;
  } else {
    relative = absolute;
  }

  return { absolute, relative };
}

// ---------------------------------------------------------------------------
// Version pair selection
// ---------------------------------------------------------------------------

/**
 * Toggle a version into a max-2 selection list (insertion order preserved).
 * - Already selected → deselect.
 * - Fewer than 2 → append.
 * - Already 2 → drop the oldest selection and append (FIFO).
 */
export function toggleVersionSelection(selected: readonly number[], version: number): number[] {
  if (selected.includes(version)) {
    return selected.filter((v) => v !== version);
  }
  if (selected.length < 2) {
    return [...selected, version];
  }
  return [selected[1]!, version];
}

/**
 * Resolve two selected versions into a directed older→newer diff range.
 * Returns null until exactly two distinct versions are selected.
 */
export function resolveDiffRange(selected: readonly number[]): { from: number; to: number } | null {
  if (selected.length !== 2) return null;
  const a = selected[0]!;
  const b = selected[1]!;
  if (a === b) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** True when a version number is one of the (up to) two selected. */
export function isVersionSelected(selected: readonly number[], version: number): boolean {
  return selected.includes(version);
}

/** Role of a selected version in the current pair (for UI badges). */
export function selectionRole(
  selected: readonly number[],
  version: number,
): "from" | "to" | "only" | null {
  if (!selected.includes(version)) return null;
  if (selected.length === 1) return "only";
  const range = resolveDiffRange(selected);
  if (!range) return "only";
  if (version === range.from) return "from";
  if (version === range.to) return "to";
  return null;
}

// ---------------------------------------------------------------------------
// Diff prioritisation / grouping (100-element readability)
// ---------------------------------------------------------------------------

/** Prop groups used to rank update importance. */
const TEXT_PROPS = new Set([
  "text",
  "originalText",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "containerId",
  "autoResize",
  "lineHeight",
]);
const BINDING_PROPS = new Set(["startBinding", "endBinding"]);
const GROUP_PROPS = new Set(["groupIds"]);
const LOCK_PROPS = new Set(["locked"]);
const MOVE_PROPS = new Set(["x", "y", "angle", "points", "lastCommittedPoint"]);
const RESIZE_PROPS = new Set(["width", "height"]);
const STYLE_PROPS = new Set([
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
]);

/**
 * Priority tiers — lower rank surfaces first.
 * Reviewers care about structure/content before style noise and z-order.
 */
export type DiffPriority =
  | "structural" // add / delete
  | "content" // text, bindings, grouping
  | "geometry" // move / resize
  | "style" // colours, stroke
  | "reorder" // z-order only
  | "other";

export type DiffSectionKey =
  "added" | "deleted" | "content" | "geometry" | "style" | "other" | "reordered" | "appState";

export type DiffListItem = {
  kind: "element";
  change: DiffElementChange;
  priority: DiffPriority;
  section: DiffSectionKey;
  /** Display line: label-first, never raw id as the primary text. */
  headline: string;
  detail: string;
};

export type DiffAppStateItem = {
  kind: "appState";
  delta: DiffPropDelta;
  headline: string;
  detail: string;
};

export type DiffViewItem = DiffListItem | DiffAppStateItem;

export type DiffSection = {
  key: DiffSectionKey;
  title: string;
  priority: DiffPriority;
  items: DiffViewItem[];
  /**
   * When true, the section starts collapsed. Style-only and pure reorders
   * collapse once they exceed {@link COLLAPSE_THRESHOLD} so a long tail of
   * minor moves does not bury adds/deletes.
   */
  defaultCollapsed: boolean;
  /** How many items to show before an in-section "show more" control. */
  previewCount: number;
};

export type PrioritizedDiffView = {
  summary: DiffSummary;
  appStateCount: number;
  totalItems: number;
  isEmpty: boolean;
  sections: DiffSection[];
  /**
   * Flat list of high-signal items for a compact "top changes" strip.
   * Capped so a 100-element scene still fits above the fold.
   */
  topChanges: DiffViewItem[];
};

/** Collapse style/reorder sections once they exceed this many items. */
export const COLLAPSE_THRESHOLD = 5;

/** Always-expanded preview length for large sections. */
export const SECTION_PREVIEW_COUNT = 12;

/** Cap on the sticky "top changes" strip. */
export const TOP_CHANGES_CAP = 8;

const PRIORITY_RANK: Record<DiffPriority, number> = {
  structural: 0,
  content: 1,
  geometry: 2,
  style: 3,
  other: 4,
  reorder: 5,
};

function hasAny(keys: ReadonlySet<string>, group: ReadonlySet<string>): boolean {
  for (const k of group) {
    if (keys.has(k)) return true;
  }
  return false;
}

/**
 * Classify an update by the props that changed. Content beats geometry
 * beats style so a text edit that also nudged position still ranks high.
 */
export function classifyUpdatePriority(props: readonly DiffPropDelta[]): DiffPriority {
  const keys = new Set(props.map((p) => p.key));
  if (
    hasAny(keys, TEXT_PROPS) ||
    hasAny(keys, BINDING_PROPS) ||
    hasAny(keys, GROUP_PROPS) ||
    hasAny(keys, LOCK_PROPS)
  ) {
    return "content";
  }
  if (hasAny(keys, MOVE_PROPS) || hasAny(keys, RESIZE_PROPS)) {
    return "geometry";
  }
  if (hasAny(keys, STYLE_PROPS)) {
    return "style";
  }
  return "other";
}

/**
 * Human-facing primary label for a change. Prefer the resolved label over
 * the element id — ids are secondary (shown in detail / title attr).
 */
export function elementHeadline(change: DiffElementChange): string {
  const type = change.type || "element";
  if (change.label && change.label.trim().length > 0) {
    // Arrow labels already look like `"A" → "B"`.
    if (change.type === "arrow" || change.type === "line") {
      if (change.label.includes("→")) return `${type} ${change.label}`;
      return `${type} “${change.label}”`;
    }
    return `${type} “${change.label}”`;
  }
  return type;
}

export function elementDetail(change: DiffElementChange): string {
  if (change.op === "update") {
    // Prefer the engine's describe, stripped of the leading "~ subject".
    const d = change.describe ?? "";
    const stripped = d.replace(/^~\s+\S+(?:\s+"[^"]*")?(?:\s+→\s+"[^"]*")?\s+/, "");
    if (stripped && stripped !== d) return stripped.trim();
    if (d.startsWith("~ ")) {
      // Fall back: everything after the first two tokens-ish.
      const m = /^~\s+.+?\s{2,}(.+)$/.exec(d);
      if (m) return m[1]!.trim();
    }
    const verbs = classifyUpdatePriority(change.props);
    if (verbs === "content") return "content changed";
    if (verbs === "geometry") return "moved / resized";
    if (verbs === "style") return "restyled";
    return change.props.map((p) => p.key).join(", ") || "updated";
  }
  if (change.op === "reorder") {
    return `z-order ${change.from} → ${change.to}`;
  }
  if (change.op === "add" && "bbox" in change && change.bbox) {
    const b = change.bbox;
    return `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)})`;
  }
  if (change.op === "delete") {
    return "removed";
  }
  return "";
}

function sectionFor(change: DiffElementChange, priority: DiffPriority): DiffSectionKey {
  if (change.op === "add") return "added";
  if (change.op === "delete") return "deleted";
  if (change.op === "reorder") return "reordered";
  if (priority === "content") return "content";
  if (priority === "geometry") return "geometry";
  if (priority === "style") return "style";
  return "other";
}

function sectionMeta(key: DiffSectionKey): {
  title: string;
  priority: DiffPriority;
} {
  switch (key) {
    case "added":
      return { title: "Added", priority: "structural" };
    case "deleted":
      return { title: "Deleted", priority: "structural" };
    case "content":
      return { title: "Content changes", priority: "content" };
    case "geometry":
      return { title: "Moved / resized", priority: "geometry" };
    case "style":
      return { title: "Style-only", priority: "style" };
    case "other":
      return { title: "Other updates", priority: "other" };
    case "reordered":
      return { title: "Reordered", priority: "reorder" };
    case "appState":
      return { title: "Canvas settings", priority: "other" };
  }
}

/**
 * Build a prioritised, sectioned view of a SceneDiff.
 *
 * Design goals for a ~100-element scene:
 * 1. Summary + top structural/content changes sit above the fold.
 * 2. Adds and deletes always expand first.
 * 3. Style-only and pure reorders collapse when long.
 * 4. Geometry updates preview a fixed number, rest behind "show more".
 * 5. Labels, not ids, carry the meaning in every headline.
 */
export function prioritizeDiff(diff: SceneDiffResponse): PrioritizedDiffView {
  const buckets = new Map<DiffSectionKey, DiffViewItem[]>();
  const ensure = (key: DiffSectionKey) => {
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    return list;
  };

  for (const change of diff.elements) {
    let priority: DiffPriority;
    if (change.op === "add" || change.op === "delete") {
      priority = "structural";
    } else if (change.op === "reorder") {
      priority = "reorder";
    } else {
      priority = classifyUpdatePriority(change.props);
    }
    const section = sectionFor(change, priority);
    ensure(section).push({
      kind: "element",
      change,
      priority,
      section,
      headline: elementHeadline(change),
      detail: elementDetail(change),
    });
  }

  for (const delta of diff.appState) {
    ensure("appState").push({
      kind: "appState",
      delta,
      headline: delta.key,
      detail: formatAppStateDelta(delta),
    });
  }

  const sectionOrder: DiffSectionKey[] = [
    "added",
    "deleted",
    "content",
    "geometry",
    "style",
    "other",
    "reordered",
    "appState",
  ];

  const sections: DiffSection[] = [];
  for (const key of sectionOrder) {
    const items = buckets.get(key);
    if (!items || items.length === 0) continue;
    const meta = sectionMeta(key);
    const defaultCollapsed =
      (key === "style" || key === "reordered" || key === "other") &&
      items.length > COLLAPSE_THRESHOLD;
    sections.push({
      key,
      title: meta.title,
      priority: meta.priority,
      items,
      defaultCollapsed,
      previewCount: SECTION_PREVIEW_COUNT,
    });
  }

  // Top changes: structural + content first, then geometry, capped.
  const topPool: DiffViewItem[] = [];
  for (const key of ["added", "deleted", "content", "geometry"] as const) {
    const items = buckets.get(key);
    if (items) topPool.push(...items);
  }
  topPool.sort((a, b) => {
    const pa = a.kind === "element" ? PRIORITY_RANK[a.priority] : 4;
    const pb = b.kind === "element" ? PRIORITY_RANK[b.priority] : 4;
    return pa - pb;
  });

  const totalItems = diff.elements.length + (diff.appState?.length ?? 0);
  const isEmpty = totalChangeCount(diff.summary) === 0 && (diff.appState?.length ?? 0) === 0;

  return {
    summary: diff.summary,
    appStateCount: diff.appState?.length ?? 0,
    totalItems,
    isEmpty,
    sections,
    topChanges: topPool.slice(0, TOP_CHANGES_CAP),
  };
}

export function formatAppStateDelta(delta: DiffPropDelta): string {
  return `${stringifyBrief(delta.from)} → ${stringifyBrief(delta.to)}`;
}

function stringifyBrief(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > 40 ? `${s.slice(0, 37)}…` : s;
  } catch {
    return String(value);
  }
}

/**
 * Op badge character / short label for list rows.
 */
export function opBadge(op: DiffElementChange["op"] | "appState"): {
  symbol: string;
  className: string;
  label: string;
} {
  switch (op) {
    case "add":
      return { symbol: "+", className: "diff-op-add", label: "added" };
    case "delete":
      return { symbol: "−", className: "diff-op-delete", label: "deleted" };
    case "update":
      return { symbol: "~", className: "diff-op-update", label: "updated" };
    case "reorder":
      return { symbol: "↻", className: "diff-op-reorder", label: "reordered" };
    case "appState":
      return { symbol: "⚙", className: "diff-op-appstate", label: "settings" };
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestoreSourceDocument = {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, BinaryFilePayload | undefined>;
};

/**
 * Build the POST /scene body that restores a past version as a **new** head.
 * History is never rewritten — parent is current head, content is the past
 * version's document, message names the restored version.
 */
export function buildRestorePayload(
  source: RestoreSourceDocument,
  headVersion: number,
  restoredVersion: number,
  messageOverride?: string,
): CommitSceneBody {
  const files: Record<string, BinaryFilePayload> = {};
  if (source.files) {
    for (const [id, entry] of Object.entries(source.files)) {
      if (!entry?.dataURL) continue;
      files[id] = {
        id: entry.id || id,
        mimeType: entry.mimeType || "application/octet-stream",
        dataURL: entry.dataURL,
        created: entry.created,
      };
    }
  }

  const message = messageOverride?.trim() || defaultRestoreMessage(restoredVersion);

  return {
    parentVersion: headVersion,
    elements: [...source.elements],
    appState: pickAppState(source.appState ?? {}) as Record<string, unknown>,
    files,
    message,
  };
}

export function defaultRestoreMessage(restoredVersion: number): string {
  return `Restore v${restoredVersion}`;
}

/**
 * Assert restore semantics for tests: new parent is head, message names the
 * source version, elements/files are copied (not mutated).
 */
export function restoreCreatesForwardCommit(
  payload: CommitSceneBody,
  headVersion: number,
  restoredVersion: number,
): boolean {
  return (
    payload.parentVersion === headVersion &&
    payload.message.includes(`v${restoredVersion}`) &&
    Array.isArray(payload.elements)
  );
}

// ---------------------------------------------------------------------------
// Read-only editor query helpers
// ---------------------------------------------------------------------------

/**
 * Parse `?v=N` from a search string. Returns null when absent or "head".
 * Absolute positive integers only (past versions).
 */
export function parseVersionQuery(search: string): number | null {
  const q = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(q);
  const raw = params.get("v");
  if (raw == null || raw === "" || raw === "head") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** Build the editor path for a past version (read-only). */
export function versionEditorPath(slug: string, version: number): string {
  return `/s/${encodeURIComponent(slug)}?v=${version}`;
}

/** Build the live editor path (head). */
export function headEditorPath(slug: string): string {
  return `/s/${encodeURIComponent(slug)}`;
}

export function historyPath(slug: string): string {
  return `/s/${encodeURIComponent(slug)}/history`;
}

/**
 * Whether the editor should be locked (view mode). True when a past version
 * is open and it is not the current head (head is editable).
 */
export function isReadOnlyVersion(viewingVersion: number | null, headVersion: number): boolean {
  if (viewingVersion == null) return false;
  if (headVersion <= 0) return false;
  return viewingVersion !== headVersion;
}

// ---------------------------------------------------------------------------
// Live history refresh (issue #37)
// ---------------------------------------------------------------------------

/**
 * Whether a scene event should append to the open history timeline.
 * Suppress self-authored commits (restore/commit already refreshed locally).
 */
export function shouldAppendRemoteVersion(
  event: { author: string; headVersion: number },
  opts: { selfName: string | null; currentHead: number },
): boolean {
  if (!Number.isInteger(event.headVersion) || event.headVersion <= 0) {
    return false;
  }
  if (event.headVersion <= opts.currentHead) return false;
  if (opts.selfName && event.author === opts.selfName) return false;
  return true;
}

/**
 * Prepend a newly arrived version to a newest-first timeline without
 * touching the caller's selection/diff state.
 * Idempotent when the version is already present.
 */
export function appendRemoteVersion(
  versions: readonly VersionInfo[],
  incoming: VersionInfo,
): {
  versions: VersionInfo[];
  headVersion: number;
  total: number;
  added: boolean;
} {
  const existing = versions.find((v) => v.version === incoming.version);
  if (existing) {
    const headVersion = versions.reduce((max, v) => Math.max(max, v.version), incoming.version);
    return {
      versions: [...versions],
      headVersion,
      total: versions.length,
      added: false,
    };
  }
  const next = orderVersionsNewestFirst([...versions, incoming]);
  const headVersion = next.reduce((max, v) => Math.max(max, v.version), 0);
  return {
    versions: next,
    headVersion,
    total: next.length,
    added: true,
  };
}

/** Build a VersionInfo from a scene event response (per-scene long-poll). */
export function versionInfoFromSceneEvent(event: {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  thumbnailFileId?: string | null;
  headVersion?: number;
}): VersionInfo {
  return {
    version: event.version,
    parentVersion: event.parentVersion,
    author: event.author,
    message: event.message,
    createdAt: event.createdAt,
    elementCount: event.elementCount,
    sceneHash: event.sceneHash,
    thumbnailFileId: event.thumbnailFileId ?? null,
  };
}
