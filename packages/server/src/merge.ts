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
 */

import type { SceneDiff } from "@excalidraw-collab/core";

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
  "Server-side merge requires the render worker " +
  "(set RENDER_WORKER=on and ensure Chromium is available). " +
  "Without it, use pull + re-apply edits, or push --force to overwrite head. " +
  "Hand-rolled merge is intentionally not supported.";

/** 201 body extras when a merge was performed. */
export type MergePushExtras = {
  merged: true;
  mergeParents: { local: number; remote: number };
  /** Diff of remote head → merge result — what the merge decided. */
  diff: SceneDiff;
};
