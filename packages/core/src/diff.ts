/**
 * Element diff engine — the feature the whole project exists for.
 *
 * `diffScenes(a, b)` produces a structured `SceneDiff` keyed on element `id`.
 * `formatDiff(diff)` is a pure renderer of that structure for terminals and
 * LLM context windows — never a second implementation of the diff logic.
 *
 * Design notes (PLAN.md §6):
 *  - Identity is `id`. Array order is authoritative for reorder.
 *  - Ignore interaction churn: version, versionNonce, updated, seed.
 *    Also ignore fractional `index` (mirrors array order; reorder is its own op).
 *  - Deletion = absent OR isDeleted flipped true (Excalidraw tombstones).
 *  - Labels resolve via bound text so diffs read "Auth Service", not "8fJ2k".
 *  - Arrows render as edges with bindings resolved to labels.
 */

import { pickAppState } from "./normalize.js";
import type {
  ElementBBox,
  ElementChange,
  ExcalidrawElement,
  PropDelta,
  SceneDiff,
  SceneDocument,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export type DiffScenesOptions = {
  /** Version number of scene `a` (shown in the diff header). Default 0. */
  from?: number;
  /** Version number of scene `b`. Default 0. */
  to?: number;
};

// ---------------------------------------------------------------------------
// Ignored props — churn on every interaction / mirror array order
// ---------------------------------------------------------------------------

/**
 * Props that must never surface in an update. Without this filter every
 * idle re-save looks like a full rewrite.
 *
 * - `version` / `versionNonce` / `updated` / `seed`: PLAN.md §6
 * - `index`: fractional z-order repaired by restore(); array order is
 *   authoritative and reorder is reported as its own op
 */
const IGNORED_PROPS = new Set([
  "version",
  "versionNonce",
  "updated",
  "seed",
  "index",
]);

// Property groups → readable verbs
const MOVE_PROPS = new Set(["x", "y", "angle"]);
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
/** Geometry of linear elements — treated as move/resize, not a separate verb. */
const GEOMETRY_PROPS = new Set(["points", "lastCommittedPoint"]);

// ---------------------------------------------------------------------------
// deep equality (no deps)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, key)) return false;
    if (!deepEqual(aRec[key], bRec[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

/** Live = present and not tombstoned. Plain boolean (not a type predicate)
 * so a false result does not narrow `ExcalidrawElement` to `never`. */
function isLive(el: ExcalidrawElement | undefined | null): boolean {
  return el != null && el.isDeleted !== true;
}

function bboxOf(el: ExcalidrawElement): ElementBBox {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function asRecord(el: ExcalidrawElement): Record<string, unknown> {
  return el as unknown as Record<string, unknown>;
}

function textOf(el: ExcalidrawElement): string | null {
  if (el.type !== "text") return null;
  const t = asRecord(el).text;
  return typeof t === "string" && t.length > 0 ? t : null;
}

/**
 * Resolve a human-readable label for an element.
 * - text → its own `text`
 * - frame → `name`
 * - container → bound text element's `text` (via boundElements or containerId)
 * - arrow → edge form `"A" → "B"` (bindings resolved to labels)
 */
function resolveLabel(
  el: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): string | null {
  if (el.type === "text") {
    return textOf(el);
  }

  if (el.type === "frame") {
    const name = asRecord(el).name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  if (el.type === "arrow" || el.type === "line") {
    return formatEdgeLabel(el, byId);
  }

  // Container: prefer boundElements text binding, then reverse containerId lookup.
  const bounds = el.boundElements;
  if (Array.isArray(bounds)) {
    for (const b of bounds) {
      if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
        const tid = (b as { id?: string }).id;
        if (typeof tid === "string") {
          const textEl = byId.get(tid);
          if (textEl && isLive(textEl)) {
            const t = textOf(textEl);
            if (t) return t;
          }
        }
      }
    }
  }

  for (const other of byId.values()) {
    if (!isLive(other) || other.type !== "text") continue;
    if (asRecord(other).containerId === el.id) {
      const t = textOf(other);
      if (t) return t;
    }
  }

  return null;
}

function bindingTargetId(binding: unknown): string | null {
  if (binding == null || typeof binding !== "object") return null;
  const id = (binding as { elementId?: unknown }).elementId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function labelForId(
  id: string | null,
  byId: Map<string, ExcalidrawElement>,
): string | null {
  if (id == null) return null;
  const el = byId.get(id);
  if (!el) return id; // dangling ref — fall back to raw id
  // Avoid recursing through arrows: resolve the target as a non-edge label.
  if (el.type === "arrow" || el.type === "line") return id;
  return resolveLabel(el, byId) ?? id;
}

function formatEdgeLabel(
  el: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): string | null {
  const startId = bindingTargetId(asRecord(el).startBinding);
  const endId = bindingTargetId(asRecord(el).endBinding);
  if (startId == null && endId == null) return null;
  const from = quoteLabel(labelForId(startId, byId));
  const to = quoteLabel(labelForId(endId, byId));
  return `${from} → ${to}`;
}

function quoteLabel(label: string | null): string {
  if (label == null) return "?";
  return `"${label}"`;
}

// ---------------------------------------------------------------------------
// Prop diffs + classification
// ---------------------------------------------------------------------------

function collectPropDeltas(
  before: ExcalidrawElement,
  after: ExcalidrawElement,
): PropDelta[] {
  const a = asRecord(before);
  const b = asRecord(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const deltas: PropDelta[] = [];
  // Stable key order for deterministic props arrays.
  for (const key of [...keys].sort()) {
    if (IGNORED_PROPS.has(key)) continue;
    // isDeleted transitions are handled as add/delete ops, not prop updates.
    if (key === "isDeleted") continue;
    if (!deepEqual(a[key], b[key])) {
      deltas.push({ key, from: a[key], to: b[key] });
    }
  }
  return deltas;
}

type Verb =
  | "moved"
  | "resized"
  | "restyled"
  | "text edited"
  | "rebound"
  | "grouped"
  | "locked";

function hasAny(keys: Set<string>, group: Set<string>): boolean {
  for (const k of group) {
    if (keys.has(k)) return true;
  }
  return false;
}

function classifyVerbs(props: readonly PropDelta[]): Verb[] {
  const keys = new Set(props.map((p) => p.key));
  const verbs: Verb[] = [];

  // Geometry (`points`) on its own is a move when no binding change; width/height → resized.
  if (hasAny(keys, MOVE_PROPS) || (hasAny(keys, GEOMETRY_PROPS) && !hasAny(keys, BINDING_PROPS))) {
    verbs.push("moved");
  }
  if (hasAny(keys, RESIZE_PROPS)) verbs.push("resized");
  if (hasAny(keys, STYLE_PROPS)) verbs.push("restyled");
  if (hasAny(keys, TEXT_PROPS)) verbs.push("text edited");
  if (hasAny(keys, BINDING_PROPS)) verbs.push("rebound");
  if (hasAny(keys, GROUP_PROPS)) verbs.push("grouped");
  if (hasAny(keys, LOCK_PROPS)) verbs.push("locked");

  return verbs;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  // One decimal is enough for agent readability; keep exact if already short.
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

function fmtPoint(x: number, y: number): string {
  return `(${fmtNum(x)},${fmtNum(y)})`;
}

function fmtBBox(b: ElementBBox): string {
  return `(${fmtNum(b.x)},${fmtNum(b.y)} ${fmtNum(b.width)}x${fmtNum(b.height)})`;
}

function fmtColorish(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Build the human-readable `describe` clause for an update.
 * Readable first; props array remains the machine-readable source of truth.
 */
function describeUpdate(
  el: ExcalidrawElement,
  label: string | null,
  props: readonly PropDelta[],
  verbs: readonly Verb[],
  before: ExcalidrawElement,
  beforeById: Map<string, ExcalidrawElement>,
  afterById: Map<string, ExcalidrawElement>,
): string {
  const type = el.type;
  const subject = formatSubject(type, label);
  const clauses: string[] = [];

  // Rebound leads for arrows — the PLAN example:
  //   ~ arrow "API" → "Cache"  (was "API" → "DB")
  // Geometry that only follows a rebind is omitted from the prose (still in props).
  const isEdge = type === "arrow" || type === "line";
  const reboundPrimary = verbs.includes("rebound") && isEdge;

  if (reboundPrimary) {
    const was = formatEdgeLabel(before, beforeById);
    const now = formatEdgeLabel(el, afterById);
    if (was && now && was !== now) {
      clauses.push(`rebound: was ${was}`);
    } else {
      clauses.push("rebound");
    }
  } else if (verbs.includes("rebound")) {
    clauses.push("rebound");
  }

  if (!reboundPrimary && verbs.includes("moved")) {
    const from = fmtPoint(before.x, before.y);
    const to = fmtPoint(el.x, el.y);
    if (from !== to) {
      clauses.push(`moved ${from} → ${to}`);
    } else if (asRecord(before).angle !== asRecord(el).angle) {
      clauses.push(
        `rotated ${fmtNum(Number(asRecord(before).angle) || 0)} → ${fmtNum(Number(asRecord(el).angle) || 0)}`,
      );
    } else {
      clauses.push("moved");
    }
  }

  if (!reboundPrimary && verbs.includes("resized")) {
    clauses.push(
      `resized ${fmtNum(before.width)}x${fmtNum(before.height)} → ${fmtNum(el.width)}x${fmtNum(el.height)}`,
    );
  }

  if (verbs.includes("restyled")) {
    const bits: string[] = [];
    for (const p of props) {
      if (!STYLE_PROPS.has(p.key)) continue;
      if (p.key === "backgroundColor") bits.push(`fill ${fmtColorish(p.to)}`);
      else if (p.key === "strokeColor") bits.push(`stroke ${fmtColorish(p.to)}`);
      else if (p.key === "strokeWidth") bits.push(`strokeWidth ${fmtColorish(p.to)}`);
      else if (p.key === "fillStyle") bits.push(`fillStyle ${fmtColorish(p.to)}`);
      else bits.push(`${p.key} ${fmtColorish(p.to)}`);
    }
    clauses.push(bits.length > 0 ? `restyled ${bits.join(", ")}` : "restyled");
  }

  if (verbs.includes("text edited")) {
    const fromText = props.find((p) => p.key === "text");
    if (fromText && typeof fromText.from === "string" && typeof fromText.to === "string") {
      clauses.push(`text edited "${fromText.from}" → "${fromText.to}"`);
    } else {
      clauses.push("text edited");
    }
  }

  if (verbs.includes("grouped")) {
    const g = props.find((p) => p.key === "groupIds");
    if (g) {
      const toIds = Array.isArray(g.to) ? (g.to as unknown[]) : [];
      const fromIds = Array.isArray(g.from) ? (g.from as unknown[]) : [];
      if (toIds.length > fromIds.length) {
        clauses.push(`grouped ${JSON.stringify(toIds)}`);
      } else if (toIds.length < fromIds.length) {
        clauses.push(`ungrouped (was ${JSON.stringify(fromIds)})`);
      } else {
        clauses.push(`grouped ${JSON.stringify(toIds)}`);
      }
    } else {
      clauses.push("grouped");
    }
  }

  if (verbs.includes("locked")) {
    const p = props.find((d) => d.key === "locked");
    if (p?.to === true) clauses.push("locked");
    else if (p?.to === false) clauses.push("unlocked");
    else clauses.push("locked");
  }

  // Fallback when props changed but no known verb matched (e.g. boundElements).
  if (clauses.length === 0 && props.length > 0) {
    clauses.push(props.map((p) => p.key).join(", ") + " changed");
  }

  const body = clauses.join("; ");
  return body ? `~ ${subject}  ${body}` : `~ ${subject}`;
}

function formatSubject(
  type: ExcalidrawElement["type"] | string,
  label: string | null,
): string {
  if (label == null) return String(type);
  // Arrow labels already include the quoted edge form.
  if (type === "arrow" || type === "line") {
    // label is either `"A" → "B"` or a plain string
    if (label.includes("→")) return `${type} ${label}`;
    return `${type} ${quoteLabel(label)}`;
  }
  return `${type} ${quoteLabel(label)}`;
}

function describeAdd(
  el: ExcalidrawElement,
  label: string | null,
): string {
  const subject = formatSubject(el.type, label);
  return `+ ${subject}  ${fmtBBox(bboxOf(el))}`;
}

function describeDelete(
  el: ExcalidrawElement,
  label: string | null,
): string {
  const subject = formatSubject(el.type, label);
  return `- ${subject}`;
}

// ---------------------------------------------------------------------------
// Reorder detection
// ---------------------------------------------------------------------------

/**
 * Among elements live in both scenes, emit a reorder for every id whose
 * position in the shared sequence changed. Index shifts caused solely by
 * inserts/deletes (shared relative order preserved) produce no reorders.
 *
 * `from` / `to` are absolute indices in the full element arrays.
 */
function detectReorders(
  beforeEls: readonly ExcalidrawElement[],
  afterEls: readonly ExcalidrawElement[],
  beforeById: Map<string, ExcalidrawElement>,
  afterById: Map<string, ExcalidrawElement>,
): Extract<ElementChange, { op: "reorder" }>[] {
  const beforeShared = beforeEls.filter(
    (el) => isLive(el) && isLive(afterById.get(el.id)),
  );
  const afterShared = afterEls.filter(
    (el) => isLive(el) && isLive(beforeById.get(el.id)),
  );

  const beforeOrder = beforeShared.map((el) => el.id);
  const afterOrder = afterShared.map((el) => el.id);
  if (deepEqual(beforeOrder, afterOrder)) return [];

  const beforePos = new Map(beforeOrder.map((id, i) => [id, i]));
  const afterPos = new Map(afterOrder.map((id, i) => [id, i]));
  const beforeAbs = new Map(beforeEls.map((el, i) => [el.id, i]));
  const afterAbs = new Map(afterEls.map((el, i) => [el.id, i]));

  const changes: Extract<ElementChange, { op: "reorder" }>[] = [];
  // Emit in after-order so output is stable and readable top-to-bottom.
  for (const id of afterOrder) {
    const bp = beforePos.get(id);
    const ap = afterPos.get(id);
    if (bp === undefined || ap === undefined || bp === ap) continue;
    // Only report if absolute index also changed (always true if shared pos changed
    // unless padding, but keep the guard).
    const from = beforeAbs.get(id);
    const to = afterAbs.get(id);
    if (from === undefined || to === undefined || from === to) continue;

    const el = afterById.get(id)!;
    const label = resolveLabel(el, afterById);
    changes.push({
      op: "reorder",
      id,
      type: el.type,
      label,
      from,
      to,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// appState diff
// ---------------------------------------------------------------------------

function diffAppState(
  a: SceneDocument["appState"],
  b: SceneDocument["appState"],
): PropDelta[] {
  const left = pickAppState(a) as Record<string, unknown>;
  const right = pickAppState(b) as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const deltas: PropDelta[] = [];
  for (const key of [...keys].sort()) {
    const from = left[key];
    const to = right[key];
    if (!deepEqual(from, to)) {
      deltas.push({ key, from, to });
    }
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// diffScenes
// ---------------------------------------------------------------------------

/**
 * Diff two scene documents. Returns a structured `SceneDiff`.
 *
 * Pass the older scene as `a` and the newer as `b`. Version numbers for the
 * summary header default to 0; supply `options.from` / `options.to` when
 * known (e.g. conflict responses).
 */
export function diffScenes(
  a: SceneDocument,
  b: SceneDocument,
  options?: DiffScenesOptions,
): SceneDiff {
  const beforeEls = a.elements;
  const afterEls = b.elements;
  const beforeById = new Map(beforeEls.map((el) => [el.id, el]));
  const afterById = new Map(afterEls.map((el) => [el.id, el]));

  const elements: ElementChange[] = [];

  // --- add / delete / update ------------------------------------------------
  // Process in a deterministic order: after-array order for live-in-after,
  // then before-array order for pure deletes.
  const seen = new Set<string>();

  for (const el of afterEls) {
    seen.add(el.id);
    const prev = beforeById.get(el.id);
    const nowLive = isLive(el);
    const wasLive = isLive(prev);

    if (!wasLive && nowLive) {
      // Fresh add, or undelete.
      const label = resolveLabel(el, afterById);
      elements.push({
        op: "add",
        id: el.id,
        type: el.type,
        label,
        bbox: bboxOf(el),
        describe: describeAdd(el, label),
      });
      continue;
    }

    if (wasLive && !nowLive) {
      // Soft-deleted (isDeleted flipped true) while still present.
      const label = resolveLabel(prev!, beforeById);
      elements.push({
        op: "delete",
        id: el.id,
        type: prev!.type,
        label,
        describe: describeDelete(prev!, label),
      });
      continue;
    }

    if (!wasLive && !nowLive) {
      // Still dead (tombstone ↔ tombstone or absent handled below). Skip.
      continue;
    }

    // Both live: property update?
    const props = collectPropDeltas(prev!, el);
    // `boundElements` is the inverse index of arrow/text bindings. When it is
    // the *only* change, the meaningful signal lives on the arrow/text itself
    // (rebound / text edit). Dropping the mirror update keeps diffs readable.
    const meaningful = props.filter((p) => p.key !== "boundElements");
    if (meaningful.length > 0) {
      const label = resolveLabel(el, afterById);
      const verbs = classifyVerbs(meaningful);
      elements.push({
        op: "update",
        id: el.id,
        type: el.type,
        label,
        props: meaningful,
        describe: describeUpdate(
          el,
          label,
          meaningful,
          verbs,
          prev!,
          beforeById,
          afterById,
        ),
      });
    }
  }

  // Hard deletes: present in before (live), absent from after entirely.
  for (const el of beforeEls) {
    if (seen.has(el.id)) continue;
    if (!isLive(el)) continue;
    const label = resolveLabel(el, beforeById);
    elements.push({
      op: "delete",
      id: el.id,
      type: el.type,
      label,
      describe: describeDelete(el, label),
    });
  }

  // --- reorder --------------------------------------------------------------
  const reorders = detectReorders(beforeEls, afterEls, beforeById, afterById);
  elements.push(...reorders);

  // --- appState -------------------------------------------------------------
  const appState = diffAppState(a.appState, b.appState);

  const summary = {
    added: elements.filter((c) => c.op === "add").length,
    deleted: elements.filter((c) => c.op === "delete").length,
    updated: elements.filter((c) => c.op === "update").length,
    reordered: elements.filter((c) => c.op === "reorder").length,
  };

  return {
    from: options?.from ?? 0,
    to: options?.to ?? 0,
    summary,
    elements,
    appState,
  };
}

// ---------------------------------------------------------------------------
// formatDiff — pure renderer of SceneDiff
// ---------------------------------------------------------------------------

/**
 * Render a `SceneDiff` as deterministic plain text for terminals and LLM
 * context windows. Never re-derives the diff — only formats fields already
 * present on the structure.
 */
export function formatDiff(diff: SceneDiff): string {
  const { summary } = diff;
  const counts: string[] = [];
  if (summary.added) counts.push(`+${summary.added}`);
  if (summary.deleted) counts.push(`-${summary.deleted}`);
  if (summary.updated) counts.push(`~${summary.updated}`);
  if (summary.reordered) counts.push(`↕${summary.reordered}`);
  const countStr = counts.length > 0 ? counts.join(" ") : "(empty)";

  const lines: string[] = [
    `v${diff.from} → v${diff.to}   ${countStr}`,
  ];

  for (const change of diff.elements) {
    lines.push(formatChangeLine(change));
  }

  if (diff.appState.length > 0) {
    lines.push("appState:");
    for (const p of diff.appState) {
      lines.push(`  ${p.key}: ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}`);
    }
  }

  // Trailing newline keeps shell `cat` and golden-file tests tidy.
  return lines.join("\n") + "\n";
}

function formatChangeLine(change: ElementChange): string {
  switch (change.op) {
    case "add":
    case "delete":
    case "update":
      return change.describe;
    case "reorder": {
      const subject = formatSubject(change.type, change.label);
      return `↕ ${subject}  ${change.from} → ${change.to}`;
    }
    default: {
      const _exhaustive: never = change;
      return String(_exhaustive);
    }
  }
}

/** True when a SceneDiff carries no element or appState changes. */
export function isEmptyDiff(diff: SceneDiff): boolean {
  return (
    diff.elements.length === 0 &&
    diff.appState.length === 0 &&
    diff.summary.added === 0 &&
    diff.summary.deleted === 0 &&
    diff.summary.updated === 0 &&
    diff.summary.reordered === 0
  );
}
