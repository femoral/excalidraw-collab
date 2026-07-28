/**
 * Named-token management routes: POST/GET/DELETE /api/tokens.
 * All routes require an admin bearer token.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createAuthPreHandler, generateTokenSecret, requireAdminPreHandler } from "./auth.js";
import { hashToken, type Database, type TokenRow } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Public token metadata — never includes the secret or hash. */
export type TokenInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
  /** Explicit privilege bit from `tokens.is_admin` (not a secret). */
  isAdmin: boolean;
};

/** POST /api/tokens response — secret is present only at creation. */
export type TokenCreated = TokenInfo & {
  /** Bearer secret; shown once and never stored in recoverable form. */
  token: string;
};

function toTokenInfo(row: TokenRow): TokenInfo {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsed: row.last_used_at,
    isAdmin: row.is_admin,
  };
}

const createTokenBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    /** When true, mint an admin token. Only an existing admin may request this. */
    isAdmin: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

/**
 * Register `/api/tokens` under a scoped plugin that enforces Bearer auth
 * and admin-only access.
 */
export async function registerTokenRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);
      api.addHook("preHandler", requireAdminPreHandler);

      api.post<{ Body: { name: string; isAdmin?: boolean } }>(
        "/tokens",
        {
          schema: {
            body: createTokenBodySchema,
          },
        },
        async (request, reply) => {
          const name = request.body.name.trim();
          if (name.length === 0) {
            throw new AppError(ErrorCode.VALIDATION, "name must not be empty", 400);
          }

          // Names are the public identity (author); keep them unique.
          const existing = db.listTokens().find((t) => t.name === name);
          if (existing) {
            throw new AppError(ErrorCode.CONFLICT, `token name already exists: ${name}`, 409);
          }

          // Default non-admin; only an admin caller (already enforced) may set
          // isAdmin: true explicitly.
          const isAdmin = request.body.isAdmin === true;

          const secret = generateTokenSecret();
          const row = db.insertToken({
            id: randomUUID(),
            name,
            token_hash: hashToken(secret),
            is_admin: isAdmin,
          });

          const body: TokenCreated = {
            ...toTokenInfo(row),
            token: secret,
          };
          return reply.status(201).send(body);
        },
      );

      api.get("/tokens", async () => {
        const tokens: TokenInfo[] = db.listTokens().map(toTokenInfo);
        return { tokens };
      });

      api.delete<{ Params: { id: string } }>("/tokens/:id", async (request, reply) => {
        const { id } = request.params;
        const row = db.getTokenById(id);
        if (!row) {
          throw new AppError(ErrorCode.NOT_FOUND, `token not found: ${id}`, 404);
        }
        db.deleteToken(id);
        return reply.status(204).send();
      });
    },
    { prefix: "/api" },
  );
}
