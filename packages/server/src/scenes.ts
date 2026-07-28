/**
 * Scene CRUD and listing routes: POST/GET/DELETE /api/scenes[/:slug].
 *
 * All routes require a valid Bearer token. Identity comes from `request.auth`;
 * clients never supply an author for these endpoints.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Database, SceneListRow, SceneRow } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Max length for a stored slug (after derivation / validation). */
export const SLUG_MAX_LENGTH = 64;

/** Wire shape for scene list items and get-by-slug (camelCase API). */
export type SceneInfo = {
  id: string;
  slug: string;
  name: string;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  lock: {
    holder: string;
    expiresAt: string;
  } | null;
  /** Element count of the head version; 0 when head_version is 0. */
  elementCount: number;
  /**
   * Author of the head version (token name). Null when the scene has no
   * versions yet (`headVersion === 0`).
   */
  headAuthor: string | null;
  /**
   * Content-addressed file id of the head version's uploaded thumbnail PNG
   * (`GET /api/files/:fileId`). Null when none was uploaded — clients fall
   * back to the render worker, then a neutral placeholder.
   */
  thumbnailFileId: string | null;
};

/**
 * Wire lock from a scene row. Expired locks are treated as free so list/get
 * never present a stale claim as active (advisory locks must not wedge).
 */
export function toLock(
  row: SceneRow | SceneListRow,
  nowMs: number = Date.now(),
): SceneInfo["lock"] {
  if (row.lock_holder === null || row.lock_holder === undefined) {
    return null;
  }
  if (row.lock_expires_at) {
    const expires = Date.parse(row.lock_expires_at);
    if (!Number.isNaN(expires) && expires <= nowMs) {
      return null;
    }
  }
  return {
    holder: row.lock_holder,
    expiresAt: row.lock_expires_at ?? "",
  };
}

/**
 * Whether a raw DB lock is still active (not missing, not past TTL).
 * Shared by scene listing and the lock claim route.
 */
export function isSceneLockActive(
  row: Pick<SceneRow, "lock_holder" | "lock_expires_at">,
  nowMs: number = Date.now(),
): boolean {
  return toLock(row as SceneRow, nowMs) !== null;
}

export function toSceneInfo(row: SceneListRow): SceneInfo {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    headVersion: row.head_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lock: toLock(row),
    elementCount: row.element_count,
    headAuthor: row.head_author ?? null,
    thumbnailFileId: row.thumbnail_file_id ?? null,
  };
}

/**
 * Derive a URL-safe slug from a human-readable scene name.
 * Lowercases, strips diacritics, replaces non-alphanumerics with hyphens,
 * collapses/trims hyphens, and caps length. Empty results become `"scene"`.
 */
export function slugifyName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "scene";
}

/**
 * Validate an explicit client-supplied slug: lowercase alphanumerics and
 * single internal hyphens only, 1..SLUG_MAX_LENGTH chars.
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 1 || slug.length > SLUG_MAX_LENGTH) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * Pick an unused slug. Soft-deleted scenes still occupy their slug (UNIQUE
 * across all rows), so {@link Database.slugExists} must consider them.
 *
 * First try is the base; on collision suffix `-2`, `-3`, … until free.
 * Suffixing is layered on top of the DB UNIQUE constraint — never a
 * substitute for it.
 */
export function allocateSlug(db: Database, base: string): string {
  const clipped = base.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "") || "scene";
  if (!db.slugExists(clipped)) return clipped;

  let n = 2;
  for (;;) {
    const suffix = `-${n}`;
    const maxBase = SLUG_MAX_LENGTH - suffix.length;
    const candidate =
      (clipped.slice(0, Math.max(1, maxBase)).replace(/-+$/g, "") || "scene") + suffix;
    if (!db.slugExists(candidate)) return candidate;
    n += 1;
    if (n > 10_000) {
      // Pathological; surface as conflict rather than hang.
      throw new AppError(
        ErrorCode.CONFLICT,
        `could not allocate a free slug for base: ${clipped}`,
        409,
      );
    }
  }
}

const createSceneBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    slug: { type: "string", minLength: 1, maxLength: SLUG_MAX_LENGTH },
  },
  additionalProperties: false,
} as const;

const renameSceneBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
  },
  additionalProperties: false,
} as const;

/**
 * Register `/api/scenes` under a scoped plugin that enforces Bearer auth.
 * Any valid token may create, list, get, and soft-delete scenes.
 */
export async function registerSceneRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      api.post<{ Body: { name: string; slug?: string } }>(
        "/scenes",
        {
          schema: {
            body: createSceneBodySchema,
          },
        },
        async (request, reply) => {
          const name = request.body.name.trim();
          if (name.length === 0) {
            throw new AppError(ErrorCode.VALIDATION, "name must not be empty", 400);
          }

          let slug: string;
          if (request.body.slug !== undefined) {
            const explicit = request.body.slug.trim().toLowerCase();
            if (!isValidSlug(explicit)) {
              throw new AppError(
                ErrorCode.VALIDATION,
                "slug must be 1–64 lowercase alphanumeric characters with optional single hyphens",
                400,
              );
            }
            // Explicit slug: do not auto-suffix; uniqueness is the DB's job
            // and a collision is a client error.
            if (db.slugExists(explicit)) {
              throw new AppError(ErrorCode.CONFLICT, `slug already exists: ${explicit}`, 409);
            }
            slug = explicit;
          } else {
            slug = allocateSlug(db, slugifyName(name));
          }

          // Insert may still fail if a concurrent create won the race — the
          // UNIQUE constraint is the source of truth.
          let row: SceneRow;
          try {
            row = db.insertScene({
              id: randomUUID(),
              slug,
              name,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/UNIQUE constraint failed/i.test(message)) {
              throw new AppError(ErrorCode.CONFLICT, `slug already exists: ${slug}`, 409);
            }
            throw err;
          }

          const info = toSceneInfo({
            ...row,
            element_count: 0,
            head_author: null,
            thumbnail_file_id: null,
          });
          return reply.status(201).send(info);
        },
      );

      api.get("/scenes", async () => {
        const scenes: SceneInfo[] = db.listScenes().map(toSceneInfo);
        return { scenes };
      });

      api.get<{ Params: { slug: string } }>("/scenes/:slug", async (request) => {
        const { slug } = request.params;
        const row = db.getSceneListRowBySlug(slug);
        if (!row) {
          throw new AppError(ErrorCode.NOT_FOUND, `scene not found: ${slug}`, 404);
        }
        return toSceneInfo(row);
      });

      /**
       * Rename a scene (display name only; slug is stable).
       * Body: `{ name }` — same validation as create.
       */
      api.patch<{ Params: { slug: string }; Body: { name: string } }>(
        "/scenes/:slug",
        {
          schema: {
            body: renameSceneBodySchema,
          },
        },
        async (request) => {
          const { slug } = request.params;
          const existing = db.getSceneListRowBySlug(slug);
          if (!existing) {
            throw new AppError(ErrorCode.NOT_FOUND, `scene not found: ${slug}`, 404);
          }

          const name = request.body.name.trim();
          if (name.length === 0) {
            throw new AppError(ErrorCode.VALIDATION, "name must not be empty", 400);
          }

          const updated = db.updateSceneName(existing.id, name);
          if (!updated) {
            throw new AppError(ErrorCode.NOT_FOUND, `scene not found: ${slug}`, 404);
          }

          // Re-read list row so head_author / element_count stay accurate.
          const listRow = db.getSceneListRowBySlug(slug);
          if (!listRow) {
            throw new AppError(ErrorCode.NOT_FOUND, `scene not found: ${slug}`, 404);
          }
          return toSceneInfo(listRow);
        },
      );

      api.delete<{ Params: { slug: string } }>("/scenes/:slug", async (request, reply) => {
        const { slug } = request.params;
        // Resolve live scene only; soft-deleted already look like 404.
        const row = db.getSceneBySlug(slug);
        if (!row) {
          throw new AppError(ErrorCode.NOT_FOUND, `scene not found: ${slug}`, 404);
        }
        db.softDeleteScene(row.id);
        return reply.status(204).send();
      });
    },
    { prefix: "/api" },
  );
}
