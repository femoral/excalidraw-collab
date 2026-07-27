/**
 * Instance settings stored in the `meta` key/value table (no migration).
 *
 * Theme (issue #38): house-style default for this deployment. Readable without
 * auth so the login screen can theme itself before a token exists. Writes are
 * admin-only — a non-admin token (including an agent) must not change what
 * everyone else sees.
 */
import type { FastifyInstance } from "fastify";
import {
  createAuthPreHandler,
  requireAdminPreHandler,
} from "./auth.js";
import {
  META_INSTANCE_THEME,
  type Database,
  type InstanceTheme,
} from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Wire shape for GET/PUT /api/settings/theme. */
export type ThemeSettings = {
  /**
   * Instance default: `"light"`, `"dark"`, or `null` when unset (viewers
   * fall through to prefers-color-scheme).
   */
  theme: InstanceTheme | null;
};

function parseStoredTheme(raw: string | undefined): InstanceTheme | null {
  if (raw === "light" || raw === "dark") return raw;
  return null;
}

function themeSettingsFromDb(db: Database): ThemeSettings {
  return { theme: parseStoredTheme(db.getMeta(META_INSTANCE_THEME)) };
}

const putThemeBodySchema = {
  type: "object",
  required: ["theme"],
  properties: {
    /**
     * `"light"` / `"dark"` set the instance default; `null` clears it so
     * viewers without a local choice follow prefers-color-scheme.
     */
    theme: {
      anyOf: [
        { type: "string", enum: ["light", "dark"] },
        { type: "null" },
      ],
    },
  },
  additionalProperties: false,
} as const;

/**
 * Register theme settings routes:
 *   - GET  /api/settings/theme — unauthenticated (login screen needs it)
 *   - PUT  /api/settings/theme — admin only
 */
export async function registerSettingsRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  // Public read: no auth preHandler. Cheap, cacheable in principle; always
  // fresh from meta so an admin flip is visible on the next page load.
  await app.register(
    async (api) => {
      api.get("/settings/theme", async (): Promise<ThemeSettings> => {
        return themeSettingsFromDb(db);
      });
    },
    { prefix: "/api" },
  );

  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);
      api.addHook("preHandler", requireAdminPreHandler);

      api.put<{ Body: { theme: InstanceTheme | null } }>(
        "/settings/theme",
        {
          schema: {
            body: putThemeBodySchema,
          },
        },
        async (request): Promise<ThemeSettings> => {
          const theme = request.body.theme;
          if (theme === null) {
            db.deleteMeta(META_INSTANCE_THEME);
          } else if (theme === "light" || theme === "dark") {
            db.setMeta(META_INSTANCE_THEME, theme);
          } else {
            throw new AppError(
              ErrorCode.VALIDATION,
              'theme must be "light", "dark", or null',
              400,
            );
          }
          return themeSettingsFromDb(db);
        },
      );
    },
    { prefix: "/api" },
  );
}
