/**
 * Named-token auth: Bearer preHandler, identity plumbing, bootstrap seed.
 *
 * Tokens are stored as SHA-256 hashes and compared with timingSafeEqual.
 * The authenticated token's *name* is the request identity; version `author`
 * must be derived from that identity (see {@link authorFromIdentity}), never
 * from a client-supplied field.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { hashToken, nowIso, type Database } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Reserved name for the bootstrap admin token. */
export const ADMIN_TOKEN_NAME = "admin";

/** Marker file under DATA_DIR: bootstrap runs at most once per data dir. */
export const BOOTSTRAP_SEEDED_MARKER = ".bootstrap_seeded";

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
      isAdmin: row.name === ADMIN_TOKEN_NAME,
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
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "admin token required",
      403,
    );
  }
}

/**
 * Seed the bootstrap admin token on first boot only.
 *
 * - No-op when `bootstrapToken` is empty.
 * - No-op when the data dir has already been bootstrapped (marker file), so a
 *   revoked admin token is never resurrected on later boots.
 * - Inserts a token named {@link ADMIN_TOKEN_NAME} only when the tokens table
 *   is still empty.
 *
 * Returns true when a new admin row was inserted.
 */
export function seedBootstrapToken(
  db: Database,
  bootstrapToken: string,
): boolean {
  if (!bootstrapToken) return false;

  const markerPath = path.join(db.dataDir, BOOTSTRAP_SEEDED_MARKER);
  if (existsSync(markerPath)) {
    return false;
  }

  let seeded = false;
  if (db.listTokens().length === 0) {
    // Guard against a hash that somehow already exists (shouldn't on empty table).
    const token_hash = hashToken(bootstrapToken);
    if (!db.getTokenByHash(token_hash)) {
      db.insertToken({
        id: randomUUID(),
        name: ADMIN_TOKEN_NAME,
        token_hash,
      });
      seeded = true;
    }
  }

  // Mark bootstrap complete even when tokens already existed (restored DB),
  // so a later BOOTSTRAP_TOKEN never re-seeds or resurrects a revoked admin.
  mkdirSync(db.dataDir, { recursive: true });
  try {
    writeFileSync(markerPath, `${nowIso()}\n`, { flag: "wx" });
  } catch {
    // Another process won the race, or marker appeared concurrently.
  }

  return seeded;
}

// Augment FastifyRequest with optional auth identity (set by the preHandler).
declare module "fastify" {
  interface FastifyRequest {
    /** Set by the Bearer auth preHandler on protected routes. */
    auth?: RequestIdentity;
  }
}
