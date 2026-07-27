/**
 * Advisory turn locks — politeness, not enforcement.
 *
 *   POST   /api/scenes/:slug/lock   claim {ttl?} for the calling token
 *   DELETE /api/scenes/:slug/lock   release (any authenticated identity)
 *
 * Locks live in SQLite (`scenes.lock_holder` / `lock_expires_at`) so they
 * survive restarts. Expired locks never block a claim. A successful push by
 * the holder auto-releases inside `Database.commitVersion`. Push itself is
 * never refused for a held lock — the CLI may opt into `--respect-lock`.
 */
import type { FastifyInstance } from "fastify";
import { authorFromIdentity, createAuthPreHandler } from "./auth.js";
import type { Database } from "./db.js";
import type { SceneEventHub } from "./events.js";
import { AppError, ErrorCode } from "./errors.js";
import { isSceneLockActive, toLock, type SceneInfo } from "./scenes.js";

/** Default claim TTL when the body omits `ttl` (PLAN.md §5). */
export const DEFAULT_LOCK_TTL_SECONDS = 30 * 60;

/** Hard upper bound so a typo cannot pin a scene for years. */
export const MAX_LOCK_TTL_SECONDS = 24 * 60 * 60;

/** Wire shape for an active lock (POST response + LOCK_HELD details). */
export type LockInfo = {
  holder: string;
  expiresAt: string;
};

export type ClaimLockBody = {
  /** TTL in seconds. Defaults to {@link DEFAULT_LOCK_TTL_SECONDS}. */
  ttl?: number;
  /**
   * Ignored if present — holder is always the token identity
   * (PLAN.md §7 shows a client-supplied holder; we deliberately do not
   * honour it so history/lock attribution stays trustworthy).
   */
  holder?: unknown;
};

const claimLockBodySchema = {
  type: "object",
  properties: {
    ttl: { type: "integer", minimum: 1, maximum: MAX_LOCK_TTL_SECONDS },
    // Accepted for forward-compat with older clients; never honoured.
    holder: {},
  },
  additionalProperties: false,
} as const;

function lockInfoFromScene(
  lock: NonNullable<SceneInfo["lock"]>,
): LockInfo {
  return {
    holder: lock.holder,
    expiresAt: lock.expiresAt,
  };
}

/**
 * Register lock claim/release routes under `/api` with Bearer auth.
 * When `events` is provided, claim/release fan out on the multiplexed stream
 * so dashboard/open-scene lock badges stay live without a version commit.
 */
export async function registerLockRoutes(
  app: FastifyInstance,
  db: Database,
  events?: SceneEventHub,
): Promise<void> {
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      // -----------------------------------------------------------------
      // POST /scenes/:slug/lock  — claim (or refresh) the turn
      // -----------------------------------------------------------------
      api.post<{ Params: { slug: string }; Body: ClaimLockBody }>(
        "/scenes/:slug/lock",
        {
          schema: {
            body: claimLockBodySchema,
          },
        },
        async (request, reply) => {
          const { slug } = request.params;
          const scene = db.getSceneBySlug(slug);
          if (!scene) {
            throw new AppError(
              ErrorCode.NOT_FOUND,
              `scene not found: ${slug}`,
              404,
            );
          }

          const identity = request.auth;
          if (!identity) {
            throw new AppError(
              ErrorCode.UNAUTHORIZED,
              "authentication required",
              401,
            );
          }

          const holder = authorFromIdentity(identity);
          const nowMs = Date.now();

          // Active lock held by someone else → polite refusal (not a hard
          // wedge: client can still push without the lock, or DELETE first).
          if (
            isSceneLockActive(scene, nowMs) &&
            scene.lock_holder !== holder
          ) {
            const current = toLock(scene, nowMs)!;
            throw new AppError(
              ErrorCode.LOCK_HELD,
              `turn held by ${current.holder} until ${current.expiresAt}`,
              409,
              lockInfoFromScene(current),
            );
          }

          const body = request.body ?? {};
          let ttlSeconds = DEFAULT_LOCK_TTL_SECONDS;
          if (body.ttl !== undefined) {
            if (
              typeof body.ttl !== "number" ||
              !Number.isInteger(body.ttl) ||
              body.ttl < 1 ||
              body.ttl > MAX_LOCK_TTL_SECONDS
            ) {
              throw new AppError(
                ErrorCode.VALIDATION,
                `ttl must be an integer between 1 and ${MAX_LOCK_TTL_SECONDS} seconds`,
                400,
              );
            }
            ttlSeconds = body.ttl;
          }

          const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
          const updated = db.setSceneLock(scene.id, holder, expiresAt);
          if (!updated) {
            throw new AppError(
              ErrorCode.NOT_FOUND,
              `scene not found: ${slug}`,
              404,
            );
          }

          const lock = toLock(updated, nowMs)!;
          events?.publishLock({
            sceneId: scene.id,
            slug: scene.slug,
            headVersion: updated.head_version,
            lock: lockInfoFromScene(lock),
            actor: holder,
          });
          return reply.status(200).send(lockInfoFromScene(lock));
        },
      );

      // -----------------------------------------------------------------
      // DELETE /scenes/:slug/lock  — release (any auth'd identity)
      // -----------------------------------------------------------------
      // Anyone may release: a crashed agent must not wedge a human editor.
      // Idempotent when free or already expired.
      api.delete<{ Params: { slug: string } }>(
        "/scenes/:slug/lock",
        async (request, reply) => {
          const { slug } = request.params;
          const scene = db.getSceneBySlug(slug);
          if (!scene) {
            throw new AppError(
              ErrorCode.NOT_FOUND,
              `scene not found: ${slug}`,
              404,
            );
          }

          const identity = request.auth;
          const actor = identity
            ? authorFromIdentity(identity)
            : scene.lock_holder ?? "unknown";

          db.setSceneLock(scene.id, null, null);
          events?.publishLock({
            sceneId: scene.id,
            slug: scene.slug,
            headVersion: scene.head_version,
            lock: null,
            actor,
          });
          return reply.status(204).send();
        },
      );
    },
    { prefix: "/api" },
  );
}
