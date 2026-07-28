/**
 * Server-side advisory-lock TTL expiry that wakes event waiters.
 *
 * Locks already expire passively for claim/list (isSceneLockActive), but a
 * parked long-poll has no version change to observe. This scheduler fires
 * `publishLock({ lock: null })` when a claim's expiresAt is reached so
 * multiplexed / turn waiters wake without a client poll loop (issue #39).
 */
import type { Database, SceneRow } from "./db.js";
import type { SceneEventHub } from "./events.js";
import { isSceneLockActive } from "./scenes.js";

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

/**
 * One timer per scene. Claim arms/reschedules; release, push auto-release,
 * and close disarm. Expiry clears the DB row only when the claim still
 * matches (holder + expiresAt), then fans out a lock event.
 */
export class LockExpiryScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly events: SceneEventHub,
  ) {}

  /** Number of armed timers (tests / diagnostics). */
  get armedCount(): number {
    return this.timers.size;
  }

  /**
   * Arm (or reschedule) expiry for a live claim.
   * `expiresAt` is the ISO string stored in the DB.
   */
  arm(sceneId: string, slug: string, holder: string, expiresAt: string): void {
    this.disarm(sceneId);
    if (this.closed) return;

    const expiresMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresMs)) return;

    const delay = Math.max(0, expiresMs - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(sceneId);
      this.expireIfDue(sceneId, slug, holder, expiresAt);
    }, delay);
    unrefTimer(timer);
    this.timers.set(sceneId, timer);
  }

  /** Cancel a pending expiry timer for `sceneId` (no-op when none). */
  disarm(sceneId: string): void {
    const timer = this.timers.get(sceneId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sceneId);
    }
  }

  /**
   * After a mutation that may have freed the lock, drop the timer when the
   * scene is free so we do not publish a spurious expiry later.
   */
  disarmIfFree(sceneId: string): void {
    const scene = this.db.getSceneById(sceneId);
    if (!scene || !isSceneLockActive(scene)) {
      this.disarm(sceneId);
    }
  }

  /** Schedule timers for every currently active lock (process start). */
  armAllActive(): void {
    if (this.closed) return;
    for (const scene of this.db.listAllScenes()) {
      this.armFromRow(scene);
    }
  }

  /** Drain timers on shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sceneId of [...this.timers.keys()]) {
      this.disarm(sceneId);
    }
  }

  private armFromRow(scene: SceneRow): void {
    if (!isSceneLockActive(scene)) return;
    if (!scene.lock_holder || !scene.lock_expires_at) return;
    this.arm(scene.id, scene.slug, scene.lock_holder, scene.lock_expires_at);
  }

  private expireIfDue(sceneId: string, slug: string, holder: string, expiresAt: string): void {
    if (this.closed) return;

    const scene = this.db.getSceneById(sceneId);
    if (!scene) return;

    // Claim was released, refreshed, or taken by someone else — leave alone.
    if (scene.lock_holder !== holder) return;
    if (scene.lock_expires_at !== expiresAt) return;

    // Still active according to the clock? (timer fired early) — re-arm.
    if (isSceneLockActive(scene)) {
      this.arm(sceneId, scene.slug || slug, holder, expiresAt);
      return;
    }

    // Clear DB claim and wake waiters. actor = expired holder so clients can
    // attribute the free-up; not a live identity performing a release.
    this.db.setSceneLock(sceneId, null, null);
    this.events.publishLock({
      sceneId,
      slug: scene.slug || slug,
      headVersion: scene.head_version,
      lock: null,
      actor: holder,
    });
  }
}
