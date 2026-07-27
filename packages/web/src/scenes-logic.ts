/**
 * Pure helpers for the scene list UI — sorting, lock display, formatting.
 * Kept free of React so `node:test` can cover them without a browser harness.
 */

import type { SceneInfo } from "./api.ts";

/** Max slug length (mirrors server SLUG_MAX_LENGTH). */
export const SLUG_MAX_LENGTH = 64;

/**
 * Scene list view-model status. After a 401 we reset to `idle` so the
 * authenticated shell is fully unmounted — no spinner, no stale error banner,
 * no half-rendered cards.
 */
export type SceneListStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; scenes: SceneInfo[] }
  | { kind: "error"; message: string };

export type SceneListAction =
  | { type: "load_start" }
  | { type: "load_success"; scenes: SceneInfo[] }
  | { type: "load_error"; message: string }
  | { type: "replace"; scenes: SceneInfo[] }
  | { type: "upsert"; scene: SceneInfo }
  | { type: "remove"; slug: string }
  | { type: "unauthorized" }
  | { type: "reset" };

export function initialSceneListStatus(): SceneListStatus {
  return { kind: "idle" };
}

/**
 * Reset list state after 401 / logout. Explicitly not an error — the login
 * screen owns the message surface.
 */
export function sceneListOnUnauthorized(): SceneListStatus {
  return { kind: "idle" };
}

export function reduceSceneList(
  state: SceneListStatus,
  action: SceneListAction,
): SceneListStatus {
  switch (action.type) {
    case "load_start":
      return { kind: "loading" };
    case "load_success":
      return { kind: "ready", scenes: sortScenesByUpdatedAt(action.scenes) };
    case "load_error":
      // Never keep a previous half-list under an error banner.
      return { kind: "error", message: action.message };
    case "replace":
      return { kind: "ready", scenes: sortScenesByUpdatedAt(action.scenes) };
    case "upsert": {
      if (state.kind !== "ready") {
        return { kind: "ready", scenes: [action.scene] };
      }
      const without = state.scenes.filter((s) => s.id !== action.scene.id);
      return {
        kind: "ready",
        scenes: sortScenesByUpdatedAt([action.scene, ...without]),
      };
    }
    case "remove": {
      if (state.kind !== "ready") return state;
      return {
        kind: "ready",
        scenes: state.scenes.filter((s) => s.slug !== action.slug),
      };
    }
    case "unauthorized":
    case "reset":
      return sceneListOnUnauthorized();
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** Newest first (ISO-8601 timestamps compare lexicographically). */
export function sortScenesByUpdatedAt(scenes: SceneInfo[]): SceneInfo[] {
  return [...scenes].sort((a, b) => {
    if (a.updatedAt === b.updatedAt) {
      return a.slug.localeCompare(b.slug);
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

/**
 * Whether the advisory lock should show as held. Expired locks are treated
 * as inactive (the server never hard-blocks on them).
 */
export function isLockActive(
  lock: SceneInfo["lock"],
  nowMs: number = Date.now(),
): boolean {
  if (lock === null) return false;
  if (!lock.expiresAt) return true;
  const expires = Date.parse(lock.expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires > nowMs;
}

/** Version count for display — linear history, so headVersion === count. */
export function versionCount(scene: SceneInfo): number {
  return scene.headVersion;
}

/**
 * Validate an optional explicit slug the way the server does:
 * 1..64 lowercase alphanumerics with single internal hyphens.
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 1 || slug.length > SLUG_MAX_LENGTH) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * Human-readable relative time. Falls back to the absolute ISO date when
 * the delta is large or parsing fails.
 */
export function formatUpdatedAt(
  iso: string,
  nowMs: number = Date.now(),
): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const deltaSec = Math.round((then - nowMs) / 1000);
  const abs = Math.abs(deltaSec);

  const rtf =
    typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
      ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
      : null;

  if (rtf) {
    if (abs < 60) return rtf.format(deltaSec, "second");
    const deltaMin = Math.round(deltaSec / 60);
    if (Math.abs(deltaMin) < 60) return rtf.format(deltaMin, "minute");
    const deltaHr = Math.round(deltaSec / 3600);
    if (Math.abs(deltaHr) < 48) return rtf.format(deltaHr, "hour");
    const deltaDay = Math.round(deltaSec / 86_400);
    if (Math.abs(deltaDay) < 30) return rtf.format(deltaDay, "day");
  }

  try {
    return new Date(then).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Author label for the card: head author, or a neutral placeholder. */
export function headAuthorLabel(scene: SceneInfo): string {
  if (scene.headAuthor && scene.headAuthor.length > 0) {
    return scene.headAuthor;
  }
  return "No commits yet";
}

/**
 * Derive a create payload from form fields. Empty optional slug is omitted
 * so the server auto-derives one.
 */
export function buildCreatePayload(
  nameRaw: string,
  slugRaw: string,
):
  | { ok: true; body: { name: string; slug?: string } }
  | { ok: false; error: string } {
  const name = nameRaw.trim();
  if (name.length === 0) {
    return { ok: false, error: "Name is required." };
  }
  if (name.length > 256) {
    return { ok: false, error: "Name is too long." };
  }

  const slug = slugRaw.trim().toLowerCase();
  if (slug.length === 0) {
    return { ok: true, body: { name } };
  }
  if (!isValidSlug(slug)) {
    return {
      ok: false,
      error:
        "Slug must be 1–64 lowercase letters, digits, or single hyphens.",
    };
  }
  return { ok: true, body: { name, slug } };
}

export function buildRenamePayload(
  nameRaw: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = nameRaw.trim();
  if (name.length === 0) {
    return { ok: false, error: "Name is required." };
  }
  if (name.length > 256) {
    return { ok: false, error: "Name is too long." };
  }
  return { ok: true, name };
}
