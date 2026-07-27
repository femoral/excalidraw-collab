/**
 * Long-poll events for turn-based collaboration (PLAN.md §7; issues #24, #37).
 *
 *   GET /api/scenes/:slug/events?since=N   per-scene head advances (CLI watch)
 *   GET /api/events?since=N                multiplexed across all scenes
 *
 * Per-scene: returns immediately when head has already moved past `since`;
 * otherwise waits on an in-process subscriber registry until the next commit
 * notifies waiters, or until the timeout (~30 s) → 204.
 *
 * Multiplexed: `since` is a global monotonic event sequence (not a version
 * number). Version commits and lock claim/release both advance the cursor so
 * the dashboard can keep one connection for every scene.
 *
 * Shutdown drains every in-flight waiter so SIGTERM does not hang.
 */
import type { FastifyInstance } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Database, VersionRow } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";
import { toLock } from "./scenes.js";
import { toVersionInfo, type VersionInfo } from "./versions.js";

/** Default long-poll idle timeout (30 s). */
export const EVENTS_TIMEOUT_MS = 30_000;

/** How many recent global events to retain for catch-up after `since`. */
export const GLOBAL_EVENT_BUFFER_LIMIT = 256;

/** 200 body: the scene's new head after a commit past `since`. */
export type SceneEventResponse = VersionInfo & {
  headVersion: number;
  /** Current advisory lock after the event (null = free / expired). */
  lock?: { holder: string; expiresAt: string } | null;
};

/** One multiplexed event (version commit or lock change). */
export type GlobalSceneEvent = {
  /** Monotonic cursor; clients pass the max seen as the next `since`. */
  seq: number;
  sceneId: string;
  slug: string;
  kind: "version" | "lock";
  headVersion: number;
  /** Present when `kind === "version"`. */
  version?: number;
  parentVersion?: number | null;
  author?: string;
  message?: string;
  createdAt?: string;
  elementCount?: number;
  sceneHash?: string;
  thumbnailFileId?: string | null;
  /** Scene lock after this event (null = free). */
  lock: { holder: string; expiresAt: string } | null;
  /**
   * Identity that caused a lock change (`kind === "lock"`).
   * Used by clients to suppress self-authored claim/release echoes.
   */
  actor?: string;
};

/** 200 body for `GET /api/events?since=N`. */
export type MultiplexedEventsResponse = {
  /** Max `seq` delivered (or current hub cursor when `events` is empty). */
  cursor: number;
  events: GlobalSceneEvent[];
};

type SceneWaiter = {
  since: number;
  resolve: (headVersion: number | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
};

type GlobalWaiter = {
  since: number;
  resolve: (events: GlobalSceneEvent[] | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
};

/** Payload recorded when a version commit lands. */
export type PublishVersionDetail = {
  sceneId: string;
  slug: string;
  headVersion: number;
  version: VersionInfo;
  lock: { holder: string; expiresAt: string } | null;
};

/** Payload recorded when a lock is claimed or released. */
export type PublishLockDetail = {
  sceneId: string;
  slug: string;
  headVersion: number;
  lock: { holder: string; expiresAt: string } | null;
  /** Token name that performed the claim/release. */
  actor: string;
};

/**
 * In-process pub/sub for scene head and lock changes.
 *
 * Waiters park on a Promise + single `setTimeout` (no intervals, no DB
 * polls). `publish` / `publishLock` after a successful mutation wakes matching
 * waiters and appends to the global ring buffer.
 */
export class SceneEventHub {
  private readonly waiters = new Map<string, Set<SceneWaiter>>();
  private readonly globalWaiters = new Set<GlobalWaiter>();
  private readonly buffer: GlobalSceneEvent[] = [];
  private latestSeq = 0;
  private closed = false;

  /** Number of currently registered per-scene waiters (tests / diagnostics). */
  get waiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  /** Number of currently registered multiplexed waiters. */
  get globalWaiterCount(): number {
    return this.globalWaiters.size;
  }

  /** Highest event sequence assigned (0 when none yet). */
  get latestCursor(): number {
    return this.latestSeq;
  }

  /**
   * Wait until `headVersion > since` for `sceneId`, or until timeout / abort /
   * close. Returns the new head version, or `null` when nothing changed.
   *
   * Callers must re-check the DB head after registration (done inside) via
   * `getHead` so a commit between the outer check and subscribe is not missed.
   */
  wait(
    sceneId: string,
    since: number,
    options: {
      timeoutMs: number;
      getHead: () => number;
      signal?: AbortSignal | null;
    },
  ): Promise<number | null> {
    if (this.closed) {
      return Promise.resolve(null);
    }

    // Already past since before we even register.
    const current = options.getHead();
    if (current > since) {
      return Promise.resolve(current);
    }

    if (options.signal?.aborted) {
      return Promise.resolve(null);
    }

    return new Promise<number | null>((resolve) => {
      const waiter: SceneWaiter = {
        since,
        resolve: () => {
          // overwritten below after cleanup is defined
        },
        timer: null,
        onAbort: null,
        signal: options.signal ?? null,
      };

      const cleanup = (): void => {
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          waiter.onAbort = null;
        }
        const set = this.waiters.get(sceneId);
        if (set) {
          set.delete(waiter);
          if (set.size === 0) this.waiters.delete(sceneId);
        }
      };

      let settled = false;
      const settle = (head: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(head);
      };

      waiter.resolve = settle;

      let set = this.waiters.get(sceneId);
      if (!set) {
        set = new Set();
        this.waiters.set(sceneId, set);
      }
      set.add(waiter);

      // Race: a commit may have landed between the outer check and register.
      const headNow = options.getHead();
      if (headNow > since) {
        settle(headNow);
        return;
      }

      if (this.closed) {
        settle(null);
        return;
      }

      const timeoutMs = Math.max(0, options.timeoutMs);
      if (timeoutMs === 0) {
        settle(null);
        return;
      }

      waiter.timer = setTimeout(() => {
        settle(null);
      }, timeoutMs);
      // Do not keep the process alive solely for idle long-polls.
      unrefTimer(waiter.timer);

      if (waiter.signal) {
        waiter.onAbort = () => {
          settle(null);
        };
        waiter.signal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      }
    });
  }

  /**
   * Wait until at least one global event with `seq > since` exists, or until
   * timeout / abort / close. Returns the batch (possibly empty on cursor
   * resync), or `null` when the wait timed out with nothing new.
   *
   * Cursor resync: when `since > latestSeq` (e.g. after a server restart),
   * returns immediately with an empty batch and the caller should adopt
   * `latestCursor` so subsequent polls are not stuck forever.
   */
  waitGlobal(
    since: number,
    options: {
      timeoutMs: number;
      signal?: AbortSignal | null;
    },
  ): Promise<GlobalSceneEvent[] | null> {
    if (this.closed) {
      return Promise.resolve(null);
    }

    // Client cursor is ahead of this process (restart) — resync immediately.
    if (since > this.latestSeq) {
      return Promise.resolve([]);
    }

    const buffered = this.eventsSince(since);
    if (buffered.length > 0) {
      return Promise.resolve(buffered);
    }

    if (options.signal?.aborted) {
      return Promise.resolve(null);
    }

    return new Promise<GlobalSceneEvent[] | null>((resolve) => {
      const waiter: GlobalWaiter = {
        since,
        resolve: () => {
          // overwritten below
        },
        timer: null,
        onAbort: null,
        signal: options.signal ?? null,
      };

      const cleanup = (): void => {
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          waiter.onAbort = null;
        }
        this.globalWaiters.delete(waiter);
      };

      let settled = false;
      const settle = (events: GlobalSceneEvent[] | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(events);
      };

      waiter.resolve = settle;
      this.globalWaiters.add(waiter);

      // Race: event may have landed between the outer buffer check and register.
      const again = this.eventsSince(since);
      if (again.length > 0) {
        settle(again);
        return;
      }

      if (this.closed) {
        settle(null);
        return;
      }

      const timeoutMs = Math.max(0, options.timeoutMs);
      if (timeoutMs === 0) {
        settle(null);
        return;
      }

      waiter.timer = setTimeout(() => {
        settle(null);
      }, timeoutMs);
      unrefTimer(waiter.timer);

      if (waiter.signal) {
        waiter.onAbort = () => {
          settle(null);
        };
        waiter.signal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      }
    });
  }

  /** Buffered global events with `seq > since`, in ascending seq order. */
  eventsSince(since: number): GlobalSceneEvent[] {
    if (since >= this.latestSeq) return [];
    return this.buffer.filter((e) => e.seq > since);
  }

  /**
   * Wake every per-scene waiter on `sceneId` whose `since` is behind
   * `headVersion`, and append a multiplexed version event.
   *
   * Prefer {@link publishVersion} when slug/version/lock are known so the
   * multiplexed buffer is populated without a follow-up DB read. The two-arg
   * form remains for unit tests and backwards compatibility.
   */
  publish(sceneId: string, headVersion: number): void {
    if (this.closed) return;
    this.wakeSceneWaiters(sceneId, headVersion);
    // Without detail the multiplexed stream still needs a wake so waiters
    // re-check; record a minimal version event (route may enrich from DB).
    this.appendGlobal({
      sceneId,
      slug: "",
      kind: "version",
      headVersion,
      lock: null,
    });
  }

  /**
   * Record a version commit: wake per-scene waiters and fan out to the
   * multiplexed stream with full payload for dashboard rows.
   */
  publishVersion(detail: PublishVersionDetail): void {
    if (this.closed) return;
    this.wakeSceneWaiters(detail.sceneId, detail.headVersion);
    this.appendGlobal({
      sceneId: detail.sceneId,
      slug: detail.slug,
      kind: "version",
      headVersion: detail.headVersion,
      version: detail.version.version,
      parentVersion: detail.version.parentVersion,
      author: detail.version.author,
      message: detail.version.message,
      createdAt: detail.version.createdAt,
      elementCount: detail.version.elementCount,
      sceneHash: detail.version.sceneHash,
      thumbnailFileId: detail.version.thumbnailFileId,
      lock: detail.lock,
    });
  }

  /**
   * Record a lock claim/release. Does not wake per-scene version waiters
   * (head did not move) so CLI `watch` is unaffected. Multiplexed waiters
   * receive a `kind: "lock"` event.
   */
  publishLock(detail: PublishLockDetail): void {
    if (this.closed) return;
    this.appendGlobal({
      sceneId: detail.sceneId,
      slug: detail.slug,
      kind: "lock",
      headVersion: detail.headVersion,
      lock: detail.lock,
      actor: detail.actor,
    });
  }

  /**
   * Resolve every in-flight waiter with `null` (timeout-equivalent).
   * Used on process shutdown so long-polls do not hang SIGTERM.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const set of this.waiters.values()) {
      for (const waiter of [...set]) {
        waiter.resolve(null);
      }
    }
    this.waiters.clear();
    for (const waiter of [...this.globalWaiters]) {
      waiter.resolve(null);
    }
    this.globalWaiters.clear();
  }

  private wakeSceneWaiters(sceneId: string, headVersion: number): void {
    const set = this.waiters.get(sceneId);
    if (!set || set.size === 0) return;
    for (const waiter of [...set]) {
      if (headVersion > waiter.since) {
        waiter.resolve(headVersion);
      }
    }
  }

  private appendGlobal(
    partial: Omit<GlobalSceneEvent, "seq">,
  ): GlobalSceneEvent {
    this.latestSeq += 1;
    const event: GlobalSceneEvent = { ...partial, seq: this.latestSeq };
    this.buffer.push(event);
    while (this.buffer.length > GLOBAL_EVENT_BUFFER_LIMIT) {
      this.buffer.shift();
    }
    for (const waiter of [...this.globalWaiters]) {
      if (event.seq > waiter.since) {
        const batch = this.eventsSince(waiter.since);
        waiter.resolve(batch.length > 0 ? batch : [event]);
      }
    }
    return event;
  }
}

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

function parseSince(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    throw new AppError(
      ErrorCode.VALIDATION,
      'query parameter "since" is required',
      400,
    );
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `since must be a non-negative integer, got ${JSON.stringify(raw)}`,
      400,
    );
  }
  return n;
}

function eventBody(
  row: VersionRow,
  headVersion: number,
  lock?: { holder: string; expiresAt: string } | null,
): SceneEventResponse {
  const body: SceneEventResponse = {
    ...toVersionInfo(row),
    headVersion,
  };
  if (lock !== undefined) {
    body.lock = lock;
  }
  return body;
}

/**
 * Enrich a buffered multiplexed event from the live DB when the publisher
 * left slug empty (two-arg `publish`) or when we want current lock truth.
 */
function enrichGlobalEvent(
  db: Database,
  event: GlobalSceneEvent,
): GlobalSceneEvent | null {
  const scene =
    event.slug.length > 0
      ? db.getSceneBySlug(event.slug) ?? db.getSceneById(event.sceneId)
      : db.getSceneById(event.sceneId);
  if (!scene) return null;

  const lock = toLock(scene);
  const headVersion = scene.head_version;

  if (event.kind === "lock") {
    return {
      ...event,
      slug: scene.slug,
      headVersion,
      lock,
    };
  }

  // Version event: prefer buffered payload; fill gaps from DB.
  if (
    event.version !== undefined &&
    event.author !== undefined &&
    event.slug.length > 0
  ) {
    return {
      ...event,
      slug: scene.slug,
      headVersion: event.headVersion || headVersion,
      lock: event.lock ?? lock,
    };
  }

  const ver = event.headVersion > 0 ? event.headVersion : headVersion;
  if (ver <= 0) {
    return {
      ...event,
      slug: scene.slug,
      headVersion,
      lock,
    };
  }
  const row = db.getVersion(scene.id, ver);
  if (!row) {
    return {
      ...event,
      slug: scene.slug,
      headVersion,
      lock,
    };
  }
  const info = toVersionInfo(row);
  return {
    ...event,
    slug: scene.slug,
    headVersion: ver,
    version: info.version,
    parentVersion: info.parentVersion,
    author: info.author,
    message: info.message,
    createdAt: info.createdAt,
    elementCount: info.elementCount,
    sceneHash: info.sceneHash,
    thumbnailFileId: info.thumbnailFileId,
    lock: event.lock ?? lock,
  };
}

/**
 * Register event routes under Bearer auth:
 *   - `GET /api/scenes/:slug/events?since=N` (per-scene, unchanged semantics)
 *   - `GET /api/events?since=N` (multiplexed, issue #37)
 *
 * Also installs an `onClose` hook that drains the hub.
 */
export async function registerEventRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    /** Shared hub; created when omitted. */
    events?: SceneEventHub;
    /** Long-poll timeout; default {@link EVENTS_TIMEOUT_MS}. Overridable in tests. */
    timeoutMs?: number;
  },
): Promise<SceneEventHub> {
  const { db } = deps;
  const events = deps.events ?? new SceneEventHub();
  const timeoutMs = deps.timeoutMs ?? EVENTS_TIMEOUT_MS;
  const authPreHandler = createAuthPreHandler(db);

  app.addHook("onClose", async () => {
    events.close();
  });

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      // -----------------------------------------------------------------
      // GET /events?since=N  — multiplexed across all scenes (issue #37)
      // -----------------------------------------------------------------
      api.get<{
        Querystring: { since?: string };
      }>("/events", async (request, reply) => {
        const since = parseSince(request.query.since);

        // Fast path: buffered events already past since.
        const ready = events.eventsSince(since);
        if (ready.length > 0 || since > events.latestCursor) {
          const raw =
            ready.length > 0
              ? ready
              : // Cursor resync after restart: empty batch, adopt latest.
                [];
          const enriched = raw
            .map((e) => enrichGlobalEvent(db, e))
            .filter((e): e is GlobalSceneEvent => e !== null);
          const cursor =
            enriched.length > 0
              ? enriched[enriched.length - 1]!.seq
              : events.latestCursor;
          const body: MultiplexedEventsResponse = { cursor, events: enriched };
          return body;
        }

        const ac = new AbortController();
        const onRequestClose = (): void => {
          ac.abort();
        };
        request.raw.on("close", onRequestClose);

        let batch: GlobalSceneEvent[] | null;
        try {
          batch = await events.waitGlobal(since, {
            timeoutMs,
            signal: ac.signal,
          });
        } finally {
          request.raw.off("close", onRequestClose);
        }

        if (batch === null) {
          return reply.status(204).send();
        }

        // Empty batch = cursor resync (since was ahead of hub).
        const enriched = batch
          .map((e) => enrichGlobalEvent(db, e))
          .filter((e): e is GlobalSceneEvent => e !== null);
        const cursor =
          enriched.length > 0
            ? enriched[enriched.length - 1]!.seq
            : events.latestCursor;
        const body: MultiplexedEventsResponse = { cursor, events: enriched };
        return body;
      });

      // -----------------------------------------------------------------
      // GET /scenes/:slug/events?since=N
      // -----------------------------------------------------------------
      api.get<{
        Params: { slug: string };
        Querystring: { since?: string };
      }>("/scenes/:slug/events", async (request, reply) => {
        const { slug } = request.params;
        const scene = db.getSceneBySlug(slug);
        if (!scene) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `scene not found: ${slug}`,
            404,
          );
        }

        const since = parseSince(request.query.since);
        const sceneId = scene.id;

        const loadHeadEvent = (
          head: number,
        ): SceneEventResponse | null => {
          if (head <= 0) return null;
          const row = db.getVersion(sceneId, head);
          if (!row) return null;
          const fresh = db.getSceneById(sceneId) ?? scene;
          return eventBody(row, head, toLock(fresh));
        };

        // Fast path: head already past since — no wait.
        if (scene.head_version > since) {
          const body = loadHeadEvent(scene.head_version);
          if (body) return body;
          // Head claims a version with no row — treat as nothing to report.
          return reply.status(204).send();
        }

        // Abort when the client disconnects or the server is closing.
        const ac = new AbortController();
        const onRequestClose = (): void => {
          ac.abort();
        };
        request.raw.on("close", onRequestClose);

        let head: number | null;
        try {
          head = await events.wait(sceneId, since, {
            timeoutMs,
            getHead: () => {
              const row = db.getSceneBySlug(slug);
              return row?.head_version ?? 0;
            },
            signal: ac.signal,
          });
        } finally {
          request.raw.off("close", onRequestClose);
        }

        if (head === null || head <= since) {
          return reply.status(204).send();
        }

        const body = loadHeadEvent(head);
        if (!body) {
          return reply.status(204).send();
        }
        return body;
      });
    },
    { prefix: "/api" },
  );

  return events;
}
