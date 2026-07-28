/**
 * Pure helpers for the "what changed" review panel and remote-version toast.
 *
 * Covers: last-seen version tracking, panel open rules, navigability of diff
 * entries, long-poll backoff state, toast state, and remote scene update
 * payloads that must NOT enter the human undo stack.
 *
 * Kept free of React so `node:test` can cover the review UX without a browser.
 */

import type { DiffElementChange, DiffSummary, SceneDiffResponse, VersionInfo } from "./api.ts";
import {
  formatChangeCounts,
  prioritizeDiff,
  totalChangeCount,
  type DiffListItem,
  type PrioritizedDiffView,
} from "./history-logic.ts";

// ---------------------------------------------------------------------------
// Last-seen version (localStorage)
// ---------------------------------------------------------------------------

/** Storage key prefix — one entry per scene slug. */
export const LAST_SEEN_KEY_PREFIX = "excalidraw-collab.lastSeen.";

/** Build the localStorage key for a scene's last-seen head version. */
export function lastSeenStorageKey(slug: string): string {
  return `${LAST_SEEN_KEY_PREFIX}${slug}`;
}

/** Minimal Storage surface so tests inject an in-memory map. */
export type VersionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Read the last-seen version for a scene, or `null` if never recorded
 * (first visit — no panel; there is nothing "changed since last visit").
 */
export function getLastSeenVersion(storage: VersionStorage, slug: string): number | null {
  const raw = storage.getItem(lastSeenStorageKey(slug));
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Persist the last-seen head version for a scene. */
export function setLastSeenVersion(storage: VersionStorage, slug: string, version: number): void {
  if (!Number.isInteger(version) || version < 0) return;
  storage.setItem(lastSeenStorageKey(slug), String(version));
}

/**
 * Whether the what-changed panel should open on load.
 * True when we have a prior visit and head has advanced since then.
 */
export function shouldShowWhatChangedOnOpen(lastSeen: number | null, headVersion: number): boolean {
  if (lastSeen === null) return false;
  if (!Number.isInteger(headVersion) || headVersion <= 0) return false;
  return headVersion > lastSeen;
}

/**
 * After first visit or successful review, mark head as seen so the next
 * open only surfaces newer work.
 */
export function markSceneSeen(storage: VersionStorage, slug: string, headVersion: number): void {
  if (!Number.isInteger(headVersion) || headVersion < 0) return;
  const prev = getLastSeenVersion(storage, slug);
  // Never move last-seen backwards (stale race / out-of-order apply).
  if (prev !== null && headVersion < prev) return;
  setLastSeenVersion(storage, slug, headVersion);
}

// ---------------------------------------------------------------------------
// Navigability — deleted elements have nothing to fly to
// ---------------------------------------------------------------------------

/**
 * Whether a diff entry can be scrolled-to on the live canvas.
 * Deletes are listed for review but are not navigable.
 * App-state-only rows have no element target either.
 */
export function isChangeNavigable(change: DiffElementChange | { op: "appState" }): boolean {
  if (change.op === "delete" || change.op === "appState") return false;
  return true;
}

/** True when a prioritised list item can be clicked to scroll. */
export function isDiffItemNavigable(item: { kind: string; change?: DiffElementChange }): boolean {
  if (item.kind !== "element" || !item.change) return false;
  return isChangeNavigable(item.change);
}

/**
 * Resolve an element id against the current scene for scrollToContent.
 * Returns null when the element is missing or tombstoned (`isDeleted`).
 */
export function findScrollTarget(
  elements: readonly { id?: string; isDeleted?: boolean }[],
  elementId: string,
): { id: string; isDeleted?: boolean } | null {
  for (const el of elements) {
    if (el && el.id === elementId) {
      if (el.isDeleted) return null;
      return el as { id: string; isDeleted?: boolean };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Review panel model
// ---------------------------------------------------------------------------

export type WhatChangedRange = {
  from: number;
  to: number;
};

export type WhatChangedPanelModel = {
  range: WhatChangedRange;
  view: PrioritizedDiffView;
  summaryLabel: string;
  /** High-signal clickable rows first; deletes included but flagged. */
  reviewItems: Array<DiffListItem & { navigable: boolean }>;
};

/**
 * Build the review model from a structured diff between last-seen and head.
 * Reuses history prioritisation so labels, grouping, and ranking stay consistent.
 */
export function buildWhatChangedModel(
  diff: SceneDiffResponse,
  range: WhatChangedRange,
): WhatChangedPanelModel {
  const view = prioritizeDiff(diff);
  const summaryLabel = formatChangeCounts(view.summary);

  // Flatten sections in priority order; attach navigability per row.
  const reviewItems: Array<DiffListItem & { navigable: boolean }> = [];
  for (const section of view.sections) {
    for (const item of section.items) {
      if (item.kind !== "element") continue;
      reviewItems.push({
        ...item,
        navigable: isChangeNavigable(item.change),
      });
    }
  }

  return {
    range,
    view,
    summaryLabel,
    reviewItems,
  };
}

export function isEmptyWhatChanged(model: WhatChangedPanelModel): boolean {
  return model.view.isEmpty;
}

export function formatWhatChangedTitle(range: WhatChangedRange): string {
  return `What changed · v${range.from} → v${range.to}`;
}

export function formatWhatChangedSubtitle(
  summary: DiffSummary,
  author?: string | null,
  message?: string | null,
): string {
  const counts = formatChangeCounts(summary);
  const who = author?.trim() ? author.trim() : null;
  const msg = message?.trim() ? message.trim() : null;
  if (who && msg) return `${who}: “${msg}” · ${counts}`;
  if (who) return `${who} · ${counts}`;
  if (msg) return `“${msg}” · ${counts}`;
  return counts;
}

// ---------------------------------------------------------------------------
// Remote toast (new version while tab is open)
// ---------------------------------------------------------------------------

export type RemoteVersionToast = {
  /** Version we were on when the remote advance was noticed. */
  fromVersion: number;
  /** New head reported by the events endpoint. */
  toVersion: number;
  author: string;
  message: string;
  createdAt: string;
};

export function toastFromSceneEvent(
  fromVersion: number,
  event: Pick<VersionInfo, "version" | "author" | "message" | "createdAt"> & {
    headVersion?: number;
  },
): RemoteVersionToast {
  const toVersion =
    typeof event.headVersion === "number" && event.headVersion > 0
      ? event.headVersion
      : event.version;
  return {
    fromVersion,
    toVersion,
    author: event.author,
    message: event.message,
    createdAt: event.createdAt,
  };
}

export function formatRemoteToastMessage(toast: RemoteVersionToast): string {
  const msg = toast.message.trim();
  if (msg.length > 0) {
    return `${toast.author} pushed v${toast.toVersion}: “${msg}”`;
  }
  return `${toast.author} pushed v${toast.toVersion}`;
}

/**
 * Toast state machine: at most one active toast. A newer remote version
 * replaces an older one still waiting for action.
 */
export type ToastState =
  | { kind: "hidden" }
  | { kind: "visible"; toast: RemoteVersionToast }
  | { kind: "applying"; toast: RemoteVersionToast; action: "load" | "merge" }
  | { kind: "error"; toast: RemoteVersionToast; message: string };

export function toastShow(_state: ToastState, toast: RemoteVersionToast): ToastState {
  return { kind: "visible", toast };
}

export function toastDismiss(_state: ToastState): ToastState {
  return { kind: "hidden" };
}

export function toastBeginApply(state: ToastState, action: "load" | "merge"): ToastState {
  if (state.kind !== "visible" && state.kind !== "error") return state;
  return { kind: "applying", toast: state.toast, action };
}

export function toastApplyFailed(state: ToastState, message: string): ToastState {
  if (state.kind !== "applying") return state;
  return { kind: "error", toast: state.toast, message };
}

export function toastApplySucceeded(_state: ToastState): ToastState {
  return { kind: "hidden" };
}

// ---------------------------------------------------------------------------
// Long-poll / backoff state machine
// ---------------------------------------------------------------------------

/** Initial delay after a transport error before the next poll. */
export const POLL_BACKOFF_INITIAL_MS = 1_000;
/** Cap so a dead server does not wait forever between retries. */
export const POLL_BACKOFF_MAX_MS = 30_000;
/** Multiplier applied after each consecutive failure. */
export const POLL_BACKOFF_FACTOR = 2;

export type PollPhase = "idle" | "waiting" | "backoff" | "stopped";

export type PollState = {
  phase: PollPhase;
  /** Version the client has already observed (events?since=N). */
  since: number;
  /** Consecutive transport failures (reset on success / 204). */
  failures: number;
  /** Delay to use before the next attempt when in backoff. */
  backoffMs: number;
};

export function initialPollState(since: number): PollState {
  return {
    phase: "idle",
    since: Math.max(0, since),
    failures: 0,
    backoffMs: POLL_BACKOFF_INITIAL_MS,
  };
}

/** Begin a long-poll request. */
export function pollBeginWait(state: PollState): PollState {
  if (state.phase === "stopped") return state;
  return { ...state, phase: "waiting" };
}

/**
 * Long-poll returned 204 (timeout, no change) — re-enter immediately.
 * Resets failure/backoff counters.
 */
export function pollOnTimeout(state: PollState): PollState {
  if (state.phase === "stopped") return state;
  return {
    ...state,
    phase: "idle",
    failures: 0,
    backoffMs: POLL_BACKOFF_INITIAL_MS,
  };
}

/**
 * Long-poll returned a new head. Advance `since` and reset backoff.
 * Caller surfaces a toast from the event body.
 */
export function pollOnEvent(state: PollState, newHead: number): PollState {
  if (state.phase === "stopped") return state;
  const nextSince = Number.isInteger(newHead) && newHead > state.since ? newHead : state.since;
  return {
    phase: "idle",
    since: nextSince,
    failures: 0,
    backoffMs: POLL_BACKOFF_INITIAL_MS,
  };
}

/**
 * Transport / server error. Enter backoff with exponential delay.
 * Does not advance `since`.
 */
export function pollOnError(state: PollState): PollState {
  if (state.phase === "stopped") return state;
  const failures = state.failures + 1;
  const backoffMs = Math.min(
    POLL_BACKOFF_MAX_MS,
    Math.round(POLL_BACKOFF_INITIAL_MS * Math.pow(POLL_BACKOFF_FACTOR, failures - 1)),
  );
  return {
    ...state,
    phase: "backoff",
    failures,
    backoffMs,
  };
}

/** Bump `since` when the local client commits or loads a remote head. */
export function pollAdvanceSince(state: PollState, head: number): PollState {
  if (!Number.isInteger(head) || head < state.since) return state;
  return { ...state, since: head };
}

export function pollStop(state: PollState): PollState {
  return { ...state, phase: "stopped" };
}

/** Delay before the next poll attempt (0 = immediate re-enter). */
export function pollNextDelayMs(state: PollState): number {
  if (state.phase === "stopped") return Number.POSITIVE_INFINITY;
  if (state.phase === "backoff") return state.backoffMs;
  return 0;
}

// ---------------------------------------------------------------------------
// Remote load — must not enter the human undo stack
// ---------------------------------------------------------------------------

/**
 * CaptureUpdateAction.NEVER as a bare string so pure tests need no Excalidraw
 * import. Runtime wiring uses the public `CaptureUpdateAction.NEVER` export,
 * which is this same value.
 */
export const REMOTE_CAPTURE_UPDATE = "NEVER" as const;

/**
 * Build the `updateScene` argument for applying a remote document.
 *
 * Critical: `captureUpdate: "NEVER"` so Ctrl+Z undoes the human's last local
 * edit, not the remote load. Matches the issue #22 acceptance criteria.
 *
 * Note: upstream 0.18 takes `captureUpdate` on the scene data object (not as a
 * second options arg). Callers pass the return value straight to updateScene.
 */
export function buildRemoteSceneUpdate(data: {
  elements: readonly unknown[];
  appState?: Record<string, unknown> | null;
}): {
  elements: unknown[];
  appState?: Record<string, unknown>;
  captureUpdate: typeof REMOTE_CAPTURE_UPDATE;
} {
  const out: {
    elements: unknown[];
    appState?: Record<string, unknown>;
    captureUpdate: typeof REMOTE_CAPTURE_UPDATE;
  } = {
    elements: [...data.elements],
    captureUpdate: REMOTE_CAPTURE_UPDATE,
  };
  if (data.appState != null) {
    out.appState = { ...data.appState };
  }
  return out;
}

/**
 * Assert the remote-load payload will not land in undo history.
 * Used by tests as a tripwire if the constant ever drifts.
 */
export function remoteUpdateSkipsUndoHistory(payload: { captureUpdate?: string }): boolean {
  return payload.captureUpdate === REMOTE_CAPTURE_UPDATE;
}

// ---------------------------------------------------------------------------
// Panel visibility (dismiss without destroying review data)
// ---------------------------------------------------------------------------

export type WhatChangedPanelState =
  | { kind: "hidden" }
  /** Diff is loading for from→to. */
  | { kind: "loading"; range: WhatChangedRange }
  | { kind: "error"; range: WhatChangedRange; message: string }
  | {
      kind: "ready";
      model: WhatChangedPanelModel;
      /** User dismissed the panel chrome; model is kept for re-open. */
      dismissed: boolean;
    };

export function panelBeginLoad(from: number, to: number): WhatChangedPanelState {
  return { kind: "loading", range: { from, to } };
}

export function panelLoadSucceeded(model: WhatChangedPanelModel): WhatChangedPanelState {
  // Empty diffs still succeed; UI can choose not to surface the panel.
  return { kind: "ready", model, dismissed: false };
}

export function panelLoadFailed(range: WhatChangedRange, message: string): WhatChangedPanelState {
  return { kind: "error", range, message };
}

export function panelDismiss(state: WhatChangedPanelState): WhatChangedPanelState {
  if (state.kind === "ready") {
    return { ...state, dismissed: true };
  }
  // Loading/error dismiss → fully hide so chrome can re-trigger.
  return { kind: "hidden" };
}

export function panelReopen(state: WhatChangedPanelState): WhatChangedPanelState {
  if (state.kind === "ready" && state.dismissed) {
    return { ...state, dismissed: false };
  }
  return state;
}

/** Whether the floating panel should render (ready and not dismissed). */
export function isPanelVisible(state: WhatChangedPanelState): boolean {
  return state.kind === "ready" && !state.dismissed;
}

/** Whether chrome should offer a "What changed" re-open affordance. */
export function canReopenPanel(state: WhatChangedPanelState): boolean {
  return state.kind === "ready" && state.dismissed && !state.model.view.isEmpty;
}

/**
 * After applying a remote version (Load), open the panel for from→to so the
 * reviewer can still walk the agent's changes.
 */
export function panelAfterRemoteLoad(model: WhatChangedPanelModel): WhatChangedPanelState {
  if (model.view.isEmpty || totalChangeCount(model.view.summary) === 0) {
    return { kind: "hidden" };
  }
  return { kind: "ready", model, dismissed: false };
}
