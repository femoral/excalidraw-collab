/**
 * Scene digest — text outline of a canvas for agents that cannot see one
 * (`excalicli describe`, PLAN.md §6).
 *
 * Zero runtime dependencies. Never mutates element internals.
 *
 * Label resolution (bound text → container label) is intentionally local
 * here; the same logic is needed by the diff engine (issue #12). Factor
 * into a shared helper once both land.
 */

import type {
  ElementBBox,
  ExcalidrawElement,
  GroupId,
  SceneDigest,
  SceneDocument,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Default cap on the flat element listing. Edges are never capped. */
export const DEFAULT_DIGEST_MAX_ELEMENTS = 200;

export type DigestOptions = {
  /**
   * Max listable elements in `digest.elements` (and thus in the text
   * body). Frames / groups / edges are always complete. Default 200.
   */
  maxElements?: number;
};

export type FormatDigestOptions = {
  /**
   * When true, append element ids (and edge/frame ids). Default false —
   * agents get a compact, human-readable outline.
   */
  verbose?: boolean;
};

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

type AnyEl = ExcalidrawElement;

function isDeleted(el: AnyEl): boolean {
  return el.isDeleted === true;
}

/** Text that labels a container (has `containerId`). */
function isBoundText(el: AnyEl): boolean {
  return (
    el.type === "text" &&
    "containerId" in el &&
    (el as { containerId: string | null }).containerId != null
  );
}

function isArrow(el: AnyEl): boolean {
  return el.type === "arrow";
}

/**
 * Listable in the flat element listing / frame children: non-deleted,
 * not an arrow (arrows are edges), not a container-bound text (shown as
 * the host's label).
 */
function isListable(el: AnyEl): boolean {
  return !isDeleted(el) && !isArrow(el) && !isBoundText(el);
}

function bboxOf(el: AnyEl): ElementBBox {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/**
 * Stable spatial order: top → bottom, then left → right, then id.
 * Independent of input array order.
 */
function compareSpatial(a: AnyEl, b: AnyEl): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.x !== b.x) return a.x - b.x;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function compareSpatialById(
  byId: Map<string, AnyEl>,
  aId: string,
  bId: string,
): number {
  const a = byId.get(aId);
  const b = byId.get(bId);
  if (a && b) return compareSpatial(a, b);
  if (a) return -1;
  if (b) return 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Label resolution (shared concern with the diff engine — see module doc)
// ---------------------------------------------------------------------------

/**
 * Resolve a human-readable label for an element:
 * - text → its own `text`
 * - frame → its `name`
 * - container with bound text → that text element's `text`
 * - otherwise null
 */
export function resolveElementLabel(
  el: AnyEl,
  byId: ReadonlyMap<string, AnyEl>,
): string | null {
  if (el.type === "text") {
    const t = (el as { text?: string }).text;
    return t && t.length > 0 ? t : null;
  }
  if (el.type === "frame") {
    const name = (el as { name?: string | null }).name;
    return name && name.length > 0 ? name : null;
  }
  const bounds = el.boundElements;
  if (bounds) {
    for (const b of bounds) {
      if (b.type === "text") {
        const textEl = byId.get(b.id);
        if (textEl && textEl.type === "text" && !isDeleted(textEl)) {
          const t = (textEl as { text?: string }).text;
          if (t && t.length > 0) return t;
        }
      }
    }
  }
  return null;
}

/**
 * Endpoint display for an edge: resolved label, else the element's type
 * (so an unlabeled box still reads as `rectangle → ellipse` rather than
 * a bare null). Returns null only when the binding itself is missing.
 */
function resolveEndpointLabel(
  binding: { elementId: string } | null | undefined,
  byId: ReadonlyMap<string, AnyEl>,
): string | null {
  if (!binding || !binding.elementId) return null;
  const target = byId.get(binding.elementId);
  if (!target || isDeleted(target)) return null;
  return resolveElementLabel(target, byId) ?? target.type;
}

// ---------------------------------------------------------------------------
// digestScene
// ---------------------------------------------------------------------------

/**
 * Build a structured scene digest from a document.
 *
 * - Ignores `isDeleted` elements.
 * - Orders listable content top-to-bottom, left-to-right (id tie-break).
 * - Caps the flat element listing at `maxElements` (default 200) but
 *   always emits the full edge list, full frame tree, and full groups.
 */
export function digestScene(
  doc: Pick<SceneDocument, "elements"> | readonly AnyEl[],
  options: DigestOptions = {},
): SceneDigest {
  const maxElements = options.maxElements ?? DEFAULT_DIGEST_MAX_ELEMENTS;
  const elements = Array.isArray(doc)
    ? doc
    : (doc as Pick<SceneDocument, "elements">).elements;

  const live = elements.filter((el) => !isDeleted(el));
  const byId = new Map<string, AnyEl>(live.map((el) => [el.id, el]));

  // --- counts & bbox -------------------------------------------------------
  const countsByType: { [type: string]: number } = {};
  for (const el of live) {
    countsByType[el.type] = (countsByType[el.type] ?? 0) + 1;
  }
  // Stable key order for deterministic JSON
  const sortedCountKeys = Object.keys(countsByType).sort();
  const stableCounts: { [type: string]: number } = {};
  for (const k of sortedCountKeys) {
    stableCounts[k] = countsByType[k]!;
  }

  let bbox: ElementBBox | null = null;
  if (live.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of live) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }
    bbox = {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  // --- frames --------------------------------------------------------------
  const frameEls = live
    .filter((el) => el.type === "frame")
    .slice()
    .sort(compareSpatial);

  const frames = frameEls.map((frame) => {
    const children = live
      .filter(
        (el) =>
          el.id !== frame.id &&
          el.frameId === frame.id &&
          isListable(el),
      )
      .slice()
      .sort(compareSpatial)
      .map((el) => el.id);
    const name = (frame as { name?: string | null }).name ?? null;
    return {
      id: frame.id,
      name: name && name.length > 0 ? name : null,
      children,
    };
  });

  // --- groups --------------------------------------------------------------
  const groupMembers = new Map<GroupId, string[]>();
  for (const el of live) {
    if (!el.groupIds || el.groupIds.length === 0) continue;
    // Bound text rides with its container's groups in fixtures; still list
    // listable members only so groups describe visible structure.
    if (!isListable(el) && !isArrow(el)) continue;
    for (const gid of el.groupIds) {
      let members = groupMembers.get(gid);
      if (!members) {
        members = [];
        groupMembers.set(gid, members);
      }
      members.push(el.id);
    }
  }
  const groups = [...groupMembers.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((groupId) => {
      const members = (groupMembers.get(groupId) ?? [])
        .slice()
        .sort((a, b) => compareSpatialById(byId, a, b));
      return { groupId, members };
    });

  // --- edges (always complete) ---------------------------------------------
  const arrows = live
    .filter((el) => isArrow(el))
    .slice()
    .sort(compareSpatial);

  const edges = arrows.map((arrow) => {
    const start = (
      arrow as {
        startBinding?: { elementId: string } | null;
      }
    ).startBinding;
    const end = (
      arrow as {
        endBinding?: { elementId: string } | null;
      }
    ).endBinding;
    return {
      id: arrow.id,
      from: resolveEndpointLabel(start, byId),
      to: resolveEndpointLabel(end, byId),
      label: resolveElementLabel(arrow, byId),
    };
  });

  // --- flat element listing (capped) ---------------------------------------
  const listable = live.filter(isListable).slice().sort(compareSpatial);
  const truncated = listable.length > maxElements;
  const omitted = truncated ? listable.length - maxElements : 0;
  const kept = truncated ? listable.slice(0, maxElements) : listable;

  const digestElements = kept.map((el) => ({
    id: el.id,
    type: el.type,
    label: resolveElementLabel(el, byId),
    bbox: bboxOf(el),
    frameId: el.frameId ?? null,
    groupIds: el.groupIds ?? [],
  }));

  return {
    elementCount: live.length,
    countsByType: stableCounts,
    bbox,
    frameCount: frameEls.length,
    truncated,
    omitted,
    frames,
    groups,
    edges,
    elements: digestElements,
  };
}

// ---------------------------------------------------------------------------
// formatDigest — text for an LLM context window
// ---------------------------------------------------------------------------

function fmtBBox(b: ElementBBox): string {
  // Compact integer-ish coords; keep one decimal if needed
  const n = (v: number) =>
    Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  return `(${n(b.x)},${n(b.y)} ${n(b.width)}x${n(b.height)})`;
}

function fmtCounts(counts: { [type: string]: number }): string {
  return Object.keys(counts)
    .sort()
    .map((t) => `${t}:${counts[t]}`)
    .join(" ");
}

function elementLine(
  type: string,
  label: string | null,
  bbox: ElementBBox,
  id: string,
  verbose: boolean,
  indent: string,
): string {
  const labelPart = label ? ` "${label}"` : "";
  const idPart = verbose ? `  id=${id}` : "";
  return `${indent}${type}${labelPart}  ${fmtBBox(bbox)}${idPart}`;
}

/**
 * Render a `SceneDigest` as compact, stable text for an agent context
 * window. No element ids unless `verbose` is true.
 *
 * Layout:
 * ```
 * N elements · type:count … · F frames · bbox (…)
 * [omitted notice if truncated]
 *
 * frames:
 *   frame "Name" (…)
 *     child …
 *
 * groups:
 *   group (N members): …
 *
 * elements:          # free elements not inside a frame (or all if flat)
 *   …
 *
 * edges:
 *   "A" → "B"
 * ```
 */
export function formatDigest(
  digest: SceneDigest,
  options: FormatDigestOptions = {},
): string {
  const verbose = options.verbose === true;
  const lines: string[] = [];

  // Summary line
  const countPart =
    digest.elementCount === 0
      ? "0 elements"
      : `${digest.elementCount} elements`;
  const typePart =
    digest.elementCount > 0 ? ` · ${fmtCounts(digest.countsByType)}` : "";
  const framePart =
    digest.frameCount > 0
      ? ` · ${digest.frameCount} frame${digest.frameCount === 1 ? "" : "s"}`
      : "";
  const bboxPart = digest.bbox ? ` · bbox ${fmtBBox(digest.bbox)}` : "";
  lines.push(`${countPart}${typePart}${framePart}${bboxPart}`);

  if (digest.truncated) {
    lines.push(
      `(listing capped: showing ${digest.elements.length}, omitted ${digest.omitted}; edges complete)`,
    );
  }

  // Index elements by id for frame/group rendering.
  // Children referenced by frames may have been truncated out of elements[].
  const elById = new Map(digest.elements.map((e) => [e.id, e]));
  const inFrame = new Set<string>();
  for (const f of digest.frames) {
    for (const c of f.children) inFrame.add(c);
  }

  // Frames with nested children
  if (digest.frames.length > 0) {
    lines.push("");
    lines.push("frames:");
    for (const frame of digest.frames) {
      const frameEl = elById.get(frame.id);
      const namePart = frame.name ? ` "${frame.name}"` : "";
      const bboxPart = frameEl ? `  ${fmtBBox(frameEl.bbox)}` : "";
      const idPart = verbose ? `  id=${frame.id}` : "";
      lines.push(`  frame${namePart}${bboxPart}${idPart}`);
      for (const childId of frame.children) {
        const child = elById.get(childId);
        if (child) {
          lines.push(
            elementLine(
              child.type,
              child.label,
              child.bbox,
              child.id,
              verbose,
              "    ",
            ),
          );
        } else if (verbose) {
          lines.push(`    (child id=${childId})`);
        } else {
          // Child was truncated from the listing; still acknowledge it.
          lines.push(`    (child omitted from listing)`);
        }
      }
    }
  }

  // Groups
  if (digest.groups.length > 0) {
    lines.push("");
    lines.push("groups:");
    for (const g of digest.groups) {
      const memberLabels = g.members.map((id) => {
        const el = elById.get(id);
        if (!el) return verbose ? id : "?";
        if (verbose) {
          return el.label ? `${el.type}:"${el.label}"(${el.id})` : `${el.type}(${el.id})`;
        }
        return el.label ? `${el.type}:"${el.label}"` : el.type;
      });
      const idPart = verbose ? ` id=${g.groupId}` : "";
      lines.push(
        `  group (${g.members.length})${idPart}: ${memberLabels.join(", ")}`,
      );
    }
  }

  // Free elements (not inside a frame). Frames themselves are listed under
  // frames: — skip them here to avoid double-printing.
  const free = digest.elements.filter(
    (e) => e.type !== "frame" && !inFrame.has(e.id),
  );
  // When there are no frames, print the full listing under "elements:".
  // When there are frames, only free (non-frame, non-child) elements.
  const toList =
    digest.frames.length === 0
      ? digest.elements.filter((e) => e.type !== "frame")
      : free;

  if (toList.length > 0) {
    lines.push("");
    lines.push("elements:");
    for (const el of toList) {
      lines.push(
        elementLine(el.type, el.label, el.bbox, el.id, verbose, "  "),
      );
    }
  } else if (digest.frames.length === 0 && digest.elementCount === 0) {
    // empty scene — summary line alone is enough
  }

  // Edges — always full
  if (digest.edges.length > 0) {
    lines.push("");
    lines.push("edges:");
    for (const edge of digest.edges) {
      const from = edge.from ?? "·";
      const to = edge.to ?? "·";
      const labelPart = edge.label ? `  "${edge.label}"` : "";
      const idPart = verbose ? `  id=${edge.id}` : "";
      // Type names stay bare; resolved labels (usually Capitalized / multi-word) quoted.
      const fmtEnd = (s: string) => {
        if (s === "·") return s;
        if (/^[a-z][a-z0-9_]*$/.test(s)) return s;
        return `"${s}"`;
      };
      lines.push(`  ${fmtEnd(from)} → ${fmtEnd(to)}${labelPart}${idPart}`);
    }
  }

  return lines.join("\n") + "\n";
}
