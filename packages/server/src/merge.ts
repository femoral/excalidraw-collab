/**
 * Server-side merge helpers (issue #29).
 *
 * Conflict resolution itself is **never** hand-rolled here. The actual
 * `restoreElements` + `reconcileElements` call runs in the render worker
 * (browser). This module owns:
 *   - query flag parsing
 *   - commit message annotation (both parents)
 *   - the injectable {@link SceneMergeService} contract
 *   - collecting file ids referenced by merged elements
 *   - preparing local (client) elements so hand-edits are visible to
 *     upstream's version / versionNonce rule (follow-up to #29 data-loss)
 */

import {
  elementHasMeaningfulChange,
  type ExcalidrawElement,
  type SceneDiff,
} from "@excalidraw-collab/core";

/**
 * Browser-backed (or test-injected) merge of two element arrays.
 * Implementations MUST delegate to upstream reconcileElements — never invent
 * a version-winner rule of their own.
 */
export type SceneMergeService = {
  merge(input: {
    localElements: readonly unknown[];
    remoteElements: readonly unknown[];
    /** Passed as reconcileElements' appState; prefer `{}` for pure version rules. */
    appState?: Record<string, unknown>;
  }): Promise<{ elements: unknown[] }>;
};

// ---------------------------------------------------------------------------
// Local-element preparation for reconcileElements
// ---------------------------------------------------------------------------

type VersionedElement = ExcalidrawElement & {
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
};

function asElement(el: unknown): VersionedElement | null {
  if (el === null || typeof el !== "object") return null;
  const rec = el as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id.length === 0) return null;
  return el as VersionedElement;
}

function elementVersion(el: VersionedElement): number {
  const v = el.version;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Deterministic 31-bit positive int from id + next version.
 * Same merge inputs must produce identical nonces (replay-stable).
 */
export function deterministicVersionNonce(id: string, version: number): number {
  // FNV-1a 32-bit, then mask to positive signed 31-bit range (matches
  // Excalidraw's typical versionNonce domain without using Math.random).
  let h = 2166136261;
  const s = `${id}\0${version}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = (h >>> 0) % 0x7fffffff;
  return n === 0 ? 1 : n;
}

/**
 * Bump `version` / `versionNonce` exactly as the real editor does on every
 * user mutation. Legitimate here because the agent (or any JSON hand-edit)
 * changed meaningful content without those fields — leaving them stale makes
 * `reconcileElements` discard the client's turn as "not newer".
 *
 * We only bump when the local version is still ≤ the parent's (dishonest /
 * stale). If the client already advanced version above the parent, the input
 * is already honest for upstream's rule and must not be rewritten (keeps
 * same-element LWW deterministic and preserves pre-bumped test fixtures).
 */
function bumpElementVersion(
  el: VersionedElement,
  parentVersion: number,
): VersionedElement {
  const localV = elementVersion(el);
  if (localV > parentVersion) {
    return el;
  }
  const nextVersion = parentVersion + 1;
  return {
    ...el,
    version: nextVersion,
    versionNonce: deterministicVersionNonce(el.id, nextVersion),
  };
}

function isLiveElement(el: VersionedElement): boolean {
  return el.isDeleted !== true;
}

/**
 * Prepare the pushing client's elements before `reconcileElements`.
 *
 * Compares each local element to the stored parent (`parentVersion` the
 * client declared). For every element whose meaningful content differs —
 * same detection as the diff engine — bumps `version`/`versionNonce` when
 * those fields are still at (or below) the parent so upstream can see the
 * client edit as newer. Untouched elements are returned byte-identical so
 * they never steal a win from a remote edit.
 *
 * Hard deletes (id present live on parent, absent from local) become
 * soft-deletes with a bumped version so they survive reconcile (which keeps
 * remote-only ids otherwise). Soft-deletes already on local are handled by
 * the same meaningful-change + bump path.
 *
 * Brand-new local ids (not on parent) are left as-is; reconcile keeps
 * local-only elements.
 */
export function prepareLocalElementsForMerge(
  localElements: readonly unknown[],
  parentElements: readonly unknown[],
): unknown[] {
  const parentById = new Map<string, VersionedElement>();
  for (const raw of parentElements) {
    const el = asElement(raw);
    if (el) parentById.set(el.id, el);
  }

  const seen = new Set<string>();
  const out: unknown[] = [];

  for (const raw of localElements) {
    const local = asElement(raw);
    if (!local) {
      out.push(raw);
      continue;
    }
    seen.add(local.id);
    const parent = parentById.get(local.id);
    if (!parent) {
      // Client addition — reconcile keeps local-only ids; no parent version
      // to be dishonest against. Leave as authored.
      out.push(local);
      continue;
    }

    if (!elementHasMeaningfulChange(parent, local)) {
      // Untouched: preserve exact object so remote edits to this id win.
      out.push(local);
      continue;
    }

    out.push(bumpElementVersion(local, elementVersion(parent)));
  }

  // Hard deletes: live on parent, completely absent from local → inject a
  // soft-delete so reconcileElements can prefer it over an untouched remote.
  for (const parent of parentById.values()) {
    if (seen.has(parent.id)) continue;
    if (!isLiveElement(parent)) continue;
    const parentV = elementVersion(parent);
    const nextVersion = parentV + 1;
    out.push({
      ...parent,
      isDeleted: true,
      version: nextVersion,
      versionNonce: deterministicVersionNonce(parent.id, nextVersion),
    });
  }

  return out;
}

/** Parse `?merge=true` (and common truthy aliases). */
export function parseMergeQuery(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return false;
}

/**
 * Annotate the user message so history records both merge parents.
 * Linear history only stores one `parent_version` column; the message is the
 * durable record of the second parent.
 */
export function formatMergeCommitMessage(
  userMessage: string,
  localParent: number,
  remoteHead: number,
): string {
  const base = userMessage.trim();
  return `${base} [merge: parents v${localParent}+v${remoteHead}]`;
}

/**
 * Collect image `fileId` values referenced by elements after a merge.
 * Does not invent ids — only reads the public `fileId` field.
 */
export function collectReferencedFileIds(
  elements: readonly unknown[],
): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el === null || typeof el !== "object") continue;
    const fid = (el as { fileId?: unknown }).fileId;
    if (typeof fid === "string" && fid.length > 0) {
      ids.add(fid);
    }
  }
  return [...ids].sort();
}

/** Clear, actionable error when `?merge=true` is asked without a render worker. */
export const MERGE_WORKER_DISABLED_MESSAGE =
  "Server-side merge is not available: RENDER_WORKER=off. " +
  "Set RENDER_WORKER=on and ensure Playwright/Chromium are installed " +
  "(optional dependency of @excalidraw-collab/render). " +
  "Without it, use pull + re-apply edits, or push --force to overwrite head. " +
  "Hand-rolled merge is intentionally not supported.";

/** Clear, actionable error when Playwright was not installed. */
export const MERGE_WORKER_NOT_INSTALLED_MESSAGE =
  "Server-side merge is not available: Playwright is not installed. " +
  "This deployment was built without render support (optional dependency skipped — " +
  "e.g. pnpm install --no-optional). Install optional dependencies or rebuild with " +
  "Playwright, then set RENDER_WORKER=on. " +
  "Without it, use pull + re-apply edits, or push --force to overwrite head.";

/** 201 body extras when a merge was performed. */
export type MergePushExtras = {
  merged: true;
  mergeParents: { local: number; remote: number };
  /** Diff of remote head → merge result — what the merge decided. */
  diff: SceneDiff;
};
