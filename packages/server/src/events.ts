/**
 * Long-poll events for turn-based collaboration (PLAN.md §7; issue #24).
 *
 *   GET /api/scenes/:slug/events?since=N
 *
 * Returns immediately when head has already moved past `since`; otherwise
 * waits on an in-process subscriber registry until the next commit notifies
 * waiters, or until the timeout (~30 s) → 204. No database polling loop.
 *
 * Shutdown drains every in-flight waiter so SIGTERM does not hang.
 */
import type { FastifyInstance } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Database, VersionRow } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";
import { toVersionInfo, type VersionInfo } from "./versions.js";

/** Default long-poll idle timeout (30 s). */
export const EVENTS_TIMEOUT_MS = 30_000;

/** 200 body: the scene's new head after a commit past `since`. */
export type SceneEventResponse = VersionInfo & {
  headVersion: number;
};

type Waiter = {
  since: number;
  resolve: (headVersion: number | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
};

/**
 * In-process pub/sub for scene head changes.
 *
 * Waiters park on a Promise + single `setTimeout` (no intervals, no DB
 * polls). `publish` after a successful commit wakes matching waiters.
 */
export class SceneEventHub {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private closed = false;
  /** Number of currently registered waiters (tests / diagnostics). */
  get waiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
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
      const waiter: Waiter = {
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
      if (
        typeof waiter.timer === "object" &&
        waiter.timer !== null &&
        "unref" in waiter.timer &&
        typeof waiter.timer.unref === "function"
      ) {
        waiter.timer.unref();
      }

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
   * Wake every waiter on `sceneId` whose `since` is behind `headVersion`.
   * Called from the successful commit path — not from a DB poll.
   */
  publish(sceneId: string, headVersion: number): void {
    if (this.closed) return;
    const set = this.waiters.get(sceneId);
    if (!set || set.size === 0) return;

    for (const waiter of [...set]) {
      if (headVersion > waiter.since) {
        waiter.resolve(headVersion);
      }
    }
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

function eventBody(row: VersionRow, headVersion: number): SceneEventResponse {
  return {
    ...toVersionInfo(row),
    headVersion,
  };
}

/**
 * Register `GET /api/scenes/:slug/events?since=N` under Bearer auth.
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
          return eventBody(row, head);
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
