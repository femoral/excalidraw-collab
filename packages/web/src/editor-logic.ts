/**
 * Pure helpers for the scene editor — draft-vs-head selection, debounced
 * save coalescing, appState whitelisting on commit/draft payloads, file
 * extraction/upload sequencing, and dirty-state rules.
 *
 * Kept free of React so `node:test` can cover the turn-model logic without a
 * browser harness. The React component stays thin around these.
 */

import { pickAppState, sceneHash } from "@excalidraw-collab/core";
import type { BinaryFilePayload } from "./api.ts";

/** Default debounce for draft autosave (PLAN.md §10). */
export const DRAFT_AUTOSAVE_MS = 2000;

// ---------------------------------------------------------------------------
// Draft vs head selection
// ---------------------------------------------------------------------------

export type DraftMeta = {
  updatedAt: string;
  basedOnVersion: number;
  headVersion: number;
  stale: boolean;
};

export type HeadMeta = {
  headVersion: number;
  /** Scene.updatedAt — moves on each successful commit. */
  updatedAt: string;
};

export type InitialSource =
  | { source: "head" }
  | { source: "draft"; stale: boolean };

/**
 * Choose initial editor data: draft when it is the newer working copy,
 * otherwise head. A missing draft always yields head.
 *
 * "Newer" means the draft row exists and either:
 *   - is based on the current head (working copy of latest), or
 *   - has an updatedAt at or after the scene's updatedAt.
 *
 * Stale drafts (basedOnVersion < head) are still preferred so human work is
 * never discarded on reload; the `stale` flag is for UI warning only.
 */
export function selectInitialSource(
  draft: DraftMeta | null,
  head: HeadMeta,
): InitialSource {
  if (draft === null) {
    return { source: "head" };
  }

  const stale =
    draft.stale ||
    draft.basedOnVersion < head.headVersion ||
    draft.headVersion < head.headVersion;

  // Prefer draft whenever it exists — it is the autosaved working copy.
  // (Even a stale draft is the user's uncommitted strokes.)
  void head.updatedAt;
  void draft.updatedAt;
  return { source: "draft", stale };
}

/**
 * Same selection with an explicit "is draft newer than head" check used when
 * we want to fall back to head if the draft is both stale and older by clock.
 * Primary path ({@link selectInitialSource}) always keeps the draft.
 */
export function isDraftNewerThanHead(
  draft: DraftMeta,
  head: HeadMeta,
): boolean {
  if (draft.basedOnVersion >= head.headVersion) return true;
  if (draft.updatedAt >= head.updatedAt) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Save / dirty status
// ---------------------------------------------------------------------------

export type SaveIndicator =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error";

/**
 * Whether navigating away / closing the tab should prompt.
 * True only when local edits are not yet persisted as a draft (or a draft
 * save failed). After a successful draft PUT the server has the work, so
 * the guard stays silent.
 */
export function hasUnsavedChanges(indicator: SaveIndicator): boolean {
  return indicator === "dirty" || indicator === "saving" || indicator === "error";
}

/**
 * Process-wide flag so the app shell's `navigate` (header links, browser
 * back) can consult the editor without prop-drilling. SceneEditor owns writes.
 */
let editorUnsavedFlag = false;

export function setEditorUnsavedFlag(unsaved: boolean): void {
  editorUnsavedFlag = unsaved;
}

export function getEditorUnsavedFlag(): boolean {
  return editorUnsavedFlag;
}

export const UNSAVED_LEAVE_MESSAGE =
  "You have unsaved changes that have not been draft-saved yet. Leave anyway?";

export function saveIndicatorLabel(indicator: SaveIndicator): string {
  switch (indicator) {
    case "idle":
      return "";
    case "dirty":
      return "Unsaved changes…";
    case "saving":
      return "Saving draft…";
    case "saved":
      return "Draft saved";
    case "error":
      return "Draft save failed";
    default: {
      const _exhaustive: never = indicator;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Debounced coalescing (burst → one request; no race with in-flight)
// ---------------------------------------------------------------------------

export type CoalescerSnapshot<T> = {
  /** Latest value waiting to be flushed (null = nothing pending). */
  pending: T | null;
  /** True while a save is in flight. */
  inflight: boolean;
  /** True when a new pending value arrived while inflight. */
  retrigger: boolean;
};

export function initialCoalescerState<T>(): CoalescerSnapshot<T> {
  return { pending: null, inflight: false, retrigger: false };
}

/** Record a new edit. Always keeps only the latest value. */
export function coalescerSchedule<T>(
  state: CoalescerSnapshot<T>,
  value: T,
): CoalescerSnapshot<T> {
  if (state.inflight) {
    return { ...state, pending: value, retrigger: true };
  }
  return { ...state, pending: value, retrigger: false };
}

/**
 * After the debounce timer fires: start a save if we are not already in
 * flight and have a pending value. Returns the value to save, or null.
 */
export function coalescerBeginFlush<T>(
  state: CoalescerSnapshot<T>,
): { state: CoalescerSnapshot<T>; value: T | null } {
  if (state.inflight || state.pending === null) {
    return { state, value: null };
  }
  const value = state.pending;
  return {
    state: { pending: null, inflight: true, retrigger: false },
    value,
  };
}

/**
 * After a save settles. If edits arrived mid-flight (`retrigger` or a new
 * pending), the next flush should run immediately (caller re-schedules with
 * 0 delay or re-enters beginFlush).
 */
export function coalescerEndFlush<T>(
  state: CoalescerSnapshot<T>,
  opts: { ok: boolean },
): { state: CoalescerSnapshot<T>; shouldFlushAgain: boolean } {
  const next: CoalescerSnapshot<T> = {
    pending: state.pending,
    inflight: false,
    retrigger: false,
  };
  // Keep pending on failure so the next edit/timer can retry with latest.
  void opts.ok;
  const shouldFlushAgain = next.pending !== null;
  return { state: next, shouldFlushAgain };
}

/**
 * Clock-injectable debounced coalescer for production use. Tests exercise the
 * pure state transitions above; this class wires timers around them.
 */
export function createDebouncedCoalescer<T>(options: {
  delayMs: number;
  save: (value: T) => Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onStatus?: (status: "scheduled" | "saving" | "saved" | "error") => void;
}) {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let state = initialCoalescerState<T>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function scheduleTimer(delay: number) {
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      void flush();
    }, delay) as ReturnType<typeof setTimeout>;
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    const began = coalescerBeginFlush(state);
    state = began.state;
    if (began.value === null) return;

    const valueBeingSaved = began.value;
    options.onStatus?.("saving");
    try {
      await options.save(valueBeingSaved);
      if (disposed) return;
      const ended = coalescerEndFlush(state, { ok: true });
      state = ended.state;
      options.onStatus?.("saved");
      if (ended.shouldFlushAgain) {
        // Collapse any burst that landed mid-flight into one immediate follow-up.
        scheduleTimer(0);
      }
    } catch {
      if (disposed) return;
      // Keep a newer pending if edits arrived mid-flight; else re-queue the
      // failed value so dirty/error is honest and the next push/timer retries.
      state = {
        pending: state.pending ?? valueBeingSaved,
        inflight: false,
        retrigger: false,
      };
      options.onStatus?.("error");
    }
  }

  return {
    /** Push a new snapshot; debounce resets. */
    push(value: T) {
      if (disposed) return;
      state = coalescerSchedule(state, value);
      options.onStatus?.("scheduled");
      if (!state.inflight) {
        scheduleTimer(options.delayMs);
      }
      // When inflight, endFlush will re-trigger.
    },
    /**
     * Flush now (e.g. before commit). Waits out any in-flight save first.
     *
     * Both loops are bounded. A caller that keeps producing edits while we
     * drain — an editor whose own save-status re-render feeds back into
     * `push` — would otherwise spin here forever, and a commit that awaits
     * this would never issue its POST. Draining the latest snapshot is a
     * best-effort courtesy; the commit body is built from live editor state
     * anyway, so giving up after a few passes loses nothing.
     */
    async flushNow(maxPasses = 3) {
      clearTimer();
      for (let i = 0; i < maxPasses && state.inflight && !disposed; i++) {
        await new Promise<void>((resolve) => {
          setTimeoutFn(() => resolve(), 10);
        });
      }
      for (let i = 0; i < maxPasses && state.pending !== null && !disposed; i++) {
        await flush();
      }
      // A pass may have scheduled an immediate follow-up; commit does not wait.
      clearTimer();
    },
    getState(): CoalescerSnapshot<T> {
      return state;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

// ---------------------------------------------------------------------------
// Payload builders (appState whitelist + file handling)
// ---------------------------------------------------------------------------

export type EditorSnapshot = {
  elements: readonly unknown[];
  appState: unknown;
  files: Record<string, BinaryFilePayload | undefined>;
};

/** Collect non-empty file ids present in the editor files map. */
export function collectFileIds(
  files: Record<string, BinaryFilePayload | undefined>,
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of Object.entries(files)) {
    if (entry && typeof entry.dataURL === "string" && entry.dataURL.length > 0) {
      ids.push(id);
    } else if (entry && typeof entry.id === "string") {
      ids.push(entry.id || id);
    } else if (id.length > 0) {
      ids.push(id);
    }
  }
  // Stable order for tests / draft equality.
  return [...new Set(ids)].sort();
}

/**
 * Files that still need POST /api/files (not yet confirmed uploaded).
 * Order is stable (sorted by id) so sequencing is deterministic.
 */
export function filesNeedingUpload(
  files: Record<string, BinaryFilePayload | undefined>,
  alreadyUploaded: ReadonlySet<string>,
): BinaryFilePayload[] {
  const out: BinaryFilePayload[] = [];
  for (const id of collectFileIds(files)) {
    if (alreadyUploaded.has(id)) continue;
    const entry = files[id];
    if (!entry || typeof entry.dataURL !== "string" || entry.dataURL.length === 0) {
      continue;
    }
    out.push({
      id: entry.id || id,
      mimeType: entry.mimeType || "application/octet-stream",
      dataURL: entry.dataURL,
      created: entry.created,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Draft PUT body: whitelisted appState + file id list (no binary payloads).
 * Binaries ride through POST /api/files first.
 */
export function buildDraftPayload(
  snapshot: EditorSnapshot,
  basedOnVersion: number,
): {
  elements: unknown[];
  appState: Record<string, unknown>;
  fileIds: string[];
  basedOnVersion: number;
} {
  return {
    elements: [...snapshot.elements],
    appState: pickAppState(snapshot.appState) as Record<string, unknown>,
    fileIds: collectFileIds(snapshot.files),
    basedOnVersion,
  };
}

/**
 * Stable identity of everything a draft PUT would persist: element versions,
 * whitelisted appState, and referenced file ids.
 *
 * Excalidraw fires `onChange` for reasons that do not touch the persisted
 * document (re-renders, pointer/selection churn). Since a save flips the save
 * indicator, and that re-render can itself produce an `onChange`, pushing every
 * `onChange` unconditionally lets draft autosave feed itself an endless stream
 * of identical PUTs. Callers compare this fingerprint and skip the push when it
 * is unchanged, which breaks that cycle at the source.
 *
 * `sceneHash` mirrors upstream `hashElementsVersion` (djb2 over `versionNonce`,
 * order-sensitive), so any real edit — including a reorder — changes it. The
 * element count is included so hash collisions cannot silently drop a save.
 */
export function draftFingerprint(snapshot: EditorSnapshot): string {
  const elements = snapshot.elements as readonly {
    versionNonce: number;
  }[];
  // pickAppState walks a fixed key list, so its output order is deterministic.
  const appState = JSON.stringify(pickAppState(snapshot.appState));
  const fileIds = collectFileIds(snapshot.files).sort().join(",");
  return `${elements.length}:${sceneHash(elements)}:${appState}:${fileIds}`;
}

/**
 * Commit POST body. `files` includes only binaries that still have a dataURL
 * so the server can content-address them; callers should upload first and may
 * pass a stripped map. Elements keep only fileId references (never inline
 * base64) — Excalidraw already models images that way.
 */
export function buildCommitPayload(
  snapshot: EditorSnapshot,
  parentVersion: number,
  message: string,
  options?: { includeFiles?: boolean },
): {
  parentVersion: number;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, BinaryFilePayload>;
  message: string;
} {
  const includeFiles = options?.includeFiles !== false;
  const files: Record<string, BinaryFilePayload> = {};
  if (includeFiles) {
    for (const id of collectFileIds(snapshot.files)) {
      const entry = snapshot.files[id];
      if (!entry?.dataURL) continue;
      files[id] = {
        id: entry.id || id,
        mimeType: entry.mimeType || "application/octet-stream",
        dataURL: entry.dataURL,
        created: entry.created,
      };
    }
  }

  return {
    parentVersion,
    elements: [...snapshot.elements],
    appState: pickAppState(snapshot.appState) as Record<string, unknown>,
    files,
    message: message.trim(),
  };
}

/**
 * Validate commit message. Empty / whitespace-only is rejected (server does
 * the same); keep the check client-side for a faster UX.
 */
export function validateCommitMessage(
  raw: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const message = raw.trim();
  if (message.length === 0) {
    return { ok: false, error: "A commit message is required." };
  }
  if (message.length > 2000) {
    return { ok: false, error: "Message is too long." };
  }
  return { ok: true, message };
}

// ---------------------------------------------------------------------------
// File upload error surfacing (nanoid / non-secure context)
// ---------------------------------------------------------------------------

export const FILE_ID_REASON_NON_SECURE_NANOID =
  "non_secure_context_nanoid" as const;
export const FILE_ID_REASON_HASH_MISMATCH = "content_hash_mismatch" as const;

/**
 * Turn a failed /api/files upload into a legible user-facing string.
 * Never swallow the non-secure-context case — it is the #1 footgun on LAN HTTP.
 */
export function formatFileUploadError(err: {
  message?: string;
  details?: unknown;
}): string {
  const details =
    err.details && typeof err.details === "object"
      ? (err.details as Record<string, unknown>)
      : null;
  const reason = details && typeof details.reason === "string" ? details.reason : null;

  if (reason === FILE_ID_REASON_NON_SECURE_NANOID) {
    return (
      "Image upload failed: this page is not a secure context, so the browser " +
      "could not content-hash the file (crypto.subtle is unavailable). " +
      "Open the app over HTTPS or from localhost — plain HTTP on a LAN address " +
      "makes Excalidraw fall back to a random id the server correctly rejects."
    );
  }

  if (reason === FILE_ID_REASON_HASH_MISMATCH) {
    return (
      "Image upload failed: the file id does not match the content hash. " +
      "Try pasting the image again."
    );
  }

  if (err.message && /nanoid|crypto\.subtle|SubtleCrypto|secure context/i.test(err.message)) {
    return (
      "Image upload failed: the browser could not produce a content hash for " +
      "the file (often because the app is served over plain HTTP on a LAN IP). " +
      "Serve over HTTPS or localhost and try again. " +
      (err.message ? `(${err.message})` : "")
    );
  }

  return err.message && err.message.length > 0
    ? err.message
    : "Image upload failed.";
}

/**
 * Convert ArrayBuffer + mime into a BinaryFilePayload dataURL.
 * Pure (no DOM) — uses Buffer when available, else a manual base64 encode.
 */
export function arrayBufferToDataURL(
  bytes: ArrayBuffer,
  mimeType: string,
  fileId: string,
): BinaryFilePayload {
  const dataURL = `data:${mimeType};base64,${arrayBufferToBase64(bytes)}`;
  return {
    id: fileId,
    mimeType,
    dataURL,
    created: Date.now(),
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is present in browsers; tests run under Node (Buffer path above).
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

/**
 * After a successful commit the local dirty/draft state should clear.
 * Pure description of the post-commit editor bookkeeping.
 */
export function postCommitState(newHeadVersion: number): {
  headVersion: number;
  saveIndicator: SaveIndicator;
  uploadedFileIdsKeep: true;
} {
  return {
    headVersion: newHeadVersion,
    saveIndicator: "idle",
    uploadedFileIdsKeep: true,
  };
}

// ---------------------------------------------------------------------------
// Advisory turn lock display (issue #23)
// ---------------------------------------------------------------------------

export type EditorLock = {
  holder: string;
  expiresAt: string;
} | null;

/**
 * Whether the advisory lock should show as held. Expired locks are inactive
 * so a crashed agent never wedges the editor badge.
 */
export function isEditorLockActive(
  lock: EditorLock,
  nowMs: number = Date.now(),
): boolean {
  if (lock === null) return false;
  if (!lock.expiresAt) return true;
  const expires = Date.parse(lock.expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires > nowMs;
}

/**
 * Badge / menu copy for an active lock.
 * e.g. "🤖 claude-code holds the turn"
 */
export function formatLockBadge(lock: NonNullable<EditorLock>): string {
  return `🤖 ${lock.holder} holds the turn`;
}

/**
 * MainMenu label: "Release turn" when we hold it (or any active lock —
 * anyone may release), "Claim turn" when free. When another identity holds
 * it we still offer "Release turn" so a human can free a crashed agent.
 */
export function turnMenuLabel(
  lock: EditorLock,
  selfName: string | null,
  nowMs: number = Date.now(),
): "Claim turn" | "Release turn" {
  if (!isEditorLockActive(lock, nowMs)) return "Claim turn";
  if (selfName && lock && lock.holder === selfName) return "Release turn";
  // Active lock held by someone else — release is the recovery action.
  return "Release turn";
}

/** True when the menu action should claim rather than release. */
export function turnMenuShouldClaim(
  lock: EditorLock,
  nowMs: number = Date.now(),
): boolean {
  return !isEditorLockActive(lock, nowMs);
}

/**
 * Whether claim/release lock controls (MainMenu item + badge release) should
 * render. Past-version view is not an editing turn, so we **hide** (not
 * disable) the controls entirely — claiming while read-only would be
 * misleading and must not happen.
 */
export function shouldShowLockControls(readOnly: boolean): boolean {
  return !readOnly;
}

// ---------------------------------------------------------------------------
// Remote head toast (issue #29 — "Merge into mine")
// ---------------------------------------------------------------------------

export type RemoteUpdateToast = {
  version: number;
  author: string;
  message: string;
};

/** Banner copy when someone else pushed while the editor is open. */
export function formatRemoteUpdateToast(event: RemoteUpdateToast): string {
  const msg =
    event.message && event.message.length > 0
      ? event.message
      : "(no message)";
  return `${event.author} pushed v${event.version}: “${msg}”`;
}

/**
 * Whether a long-poll event should surface a remote-update toast.
 * Ignore our own commits (author === self) and events at or behind local head.
 */
export function shouldShowRemoteUpdateToast(
  event: { headVersion: number; author: string },
  opts: { localHead: number; selfName: string | null },
): boolean {
  if (event.headVersion <= opts.localHead) return false;
  if (opts.selfName && event.author === opts.selfName) return false;
  return true;
}
