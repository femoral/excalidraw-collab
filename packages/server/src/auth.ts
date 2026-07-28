/**
 * Named-token auth: Bearer preHandler, identity plumbing, bootstrap seed.
 *
 * Tokens are stored as SHA-256 hashes and compared with timingSafeEqual.
 * The authenticated token's *name* is the request identity; version `author`
 * must be derived from that identity (see {@link authorFromIdentity}), never
 * from a client-supplied field. Admin privilege is an explicit `is_admin`
 * column, never inferred from the name.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { hashToken, META_BOOTSTRAP_COMPLETED, type Database } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Default name for the bootstrap admin token (not load-bearing for privilege). */
export const ADMIN_TOKEN_NAME = "admin";

/**
 * Authenticated request identity. Later route handlers should read the author
 * only via {@link authorFromIdentity} so a client-supplied author cannot
 * override history attribution.
 */
export type RequestIdentity = {
  readonly tokenId: string;
  readonly name: string;
  readonly isAdmin: boolean;
};

/** Derive the version/draft author string from the authenticated identity. */
export function authorFromIdentity(identity: RequestIdentity): string {
  return identity.name;
}

export function isAdminIdentity(identity: RequestIdentity): boolean {
  return identity.isAdmin;
}

/** Cryptographically random bearer secret (shown once at mint time). */
export function generateTokenSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time equality for SHA-256 hex digests.
 * Never compare token secrets or hashes with `===`.
 */
export function tokenHashesEqual(a: string, b: string): boolean {
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function unauthorized(message: string): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, message, 401);
}

function parseBearerSecret(header: string | undefined): string | undefined {
  if (header === undefined || header === "") return undefined;
  // RFC 6750: scheme is case-insensitive; require a single space separator.
  const match = /^Bearer[ \t]+(\S+)\s*$/i.exec(header);
  if (!match) return undefined;
  const secret = match[1];
  return secret && secret.length > 0 ? secret : undefined;
}

/**
 * Build a Fastify preHandler that authenticates `Authorization: Bearer …`,
 * attaches {@link RequestIdentity} to the request, and schedules an async
 * `last_used_at` update (never on the critical path).
 */
export function createAuthPreHandler(db: Database): preHandlerHookHandler {
  return async function authPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const secret = parseBearerSecret(request.headers.authorization);
    if (secret === undefined) {
      throw unauthorized("missing or malformed authorization header");
    }

    const computedHash = hashToken(secret);
    const row = db.getTokenByHash(computedHash);

    // Always perform a constant-time compare. When the row is missing, compare
    // against a dummy digest so the missing-vs-invalid path stays uniform.
    const storedHash = row?.token_hash ?? "0".repeat(64);
    const hashesMatch = tokenHashesEqual(computedHash, storedHash);

    if (!row || !hashesMatch) {
      throw unauthorized("invalid or revoked token");
    }

    const identity: RequestIdentity = {
      tokenId: row.id,
      name: row.name,
      isAdmin: row.is_admin,
    };
    request.auth = identity;

    // lastUsed: fire-and-forget; never await on the request path.
    const tokenId = row.id;
    setImmediate(() => {
      try {
        db.touchToken(tokenId);
      } catch {
        // best-effort; auth already succeeded
      }
    });
  };
}

/**
 * preHandler that requires the authenticated identity to be admin.
 * Must be `async` so Fastify treats it as a promise-style hook (a sync
 * two-arg preHandler can stall the request lifecycle under Fastify 5).
 */
export async function requireAdminPreHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const identity = request.auth;
  if (!identity) {
    throw unauthorized("authentication required");
  }
  if (!identity.isAdmin) {
    throw new AppError(ErrorCode.FORBIDDEN, "admin token required", 403);
  }
}

/**
 * Seed the bootstrap admin token on first boot only.
 *
 * - No-op when `bootstrapToken` is empty (does not mark bootstrap complete).
 * - No-op when `meta.bootstrap_completed` is already set, so a revoked admin
 *   is never resurrected on later boots — even after a DB-only restore.
 * - Inserts an admin token (`is_admin = 1`) named {@link ADMIN_TOKEN_NAME}
 *   only when the tokens table is still empty.
 * - Admin insert and the meta flag run in one DB transaction.
 *
 * Returns true when a new admin row was inserted.
 */
export function seedBootstrapToken(db: Database, bootstrapToken: string): boolean {
  if (!bootstrapToken) return false;
  if (db.getMeta(META_BOOTSTRAP_COMPLETED) === "1") return false;

  return db.runBootstrapSeed({
    id: randomUUID(),
    name: ADMIN_TOKEN_NAME,
    token_hash: hashToken(bootstrapToken),
  });
}

/** Public identity for the authenticated bearer token (`GET /api/whoami`). */
export type WhoamiInfo = {
  id: string;
  /** Token name — recorded as `author` on versions. */
  name: string;
  isAdmin: boolean;
};

/**
 * Register `GET /api/whoami` — any valid bearer token may read its own identity
 * (the name that appears as author in history). Not admin-gated.
 */
export async function registerWhoamiRoute(app: FastifyInstance, db: Database): Promise<void> {
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      api.get("/whoami", async (request) => {
        const identity = request.auth;
        if (!identity) {
          throw unauthorized("authentication required");
        }
        const body: WhoamiInfo = {
          id: identity.tokenId,
          name: identity.name,
          isAdmin: identity.isAdmin,
        };
        return body;
      });
    },
    { prefix: "/api" },
  );
}

// Augment FastifyRequest with optional auth identity (set by the preHandler).
declare module "fastify" {
  interface FastifyRequest {
    /** Set by the Bearer auth preHandler on protected routes. */
    auth?: RequestIdentity;
  }
}
