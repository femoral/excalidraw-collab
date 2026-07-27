/**
 * Draft autosave routes — the "never lose work" mechanism.
 *
 *   PUT    /api/scenes/:slug/draft
 *   GET    /api/scenes/:slug/draft
 *   DELETE /api/scenes/:slug/draft
 *
 * Deliberately separate from the turn model: a draft is one overwritten
 * working-copy row per scene, never a version. Commits clear the draft
 * inside `Database.commitVersion` (same transaction).
 *
 * `updatedBy` always comes from the bearer token identity.
 */
import {
  normalizeScene,
  SceneValidationError,
  type SceneDocument,
} from "@excalidraw-collab/core";
import type { FastifyInstance } from "fastify";
import { authorFromIdentity, createAuthPreHandler } from "./auth.js";
import {
  gunzipJson,
  gzipJson,
  type Database,
  type DraftRow,
} from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Wire shape returned by GET/PUT draft endpoints. */
export type DraftResponse = {
  elements: SceneDocument["elements"];
  appState: SceneDocument["appState"];
  fileIds: string[];
  updatedAt: string;
  updatedBy: string;
  /** Head version the draft content was based on (client-supplied or defaulted). */
  basedOnVersion: number;
  /** Current scene head at response time. */
  headVersion: number;
  /**
   * True when the draft is based on an older head than the scene currently
   * has. Explicit and machine-readable — clients must not re-derive this by
   * comparing numbers themselves.
   */
  stale: boolean;
};

/** 200 body after a successful PUT (same fields as GET). */
export type PutDraftResponse = DraftResponse;

type PutDraftBody = {
  elements: unknown;
  appState?: unknown;
  fileIds?: unknown;
  basedOnVersion?: unknown;
  /** Ignored if present — author is always the token identity. */
  updatedBy?: unknown;
  author?: unknown;
};

const putDraftBodySchema = {
  type: "object",
  required: ["elements"],
  properties: {
    elements: { type: "array" },
    appState: { type: "object" },
    fileIds: {
      type: "array",
      items: { type: "string" },
    },
    basedOnVersion: { type: "integer", minimum: 0 },
    // Accepted so clients may echo local identity fields, but never honoured.
    updatedBy: {},
    author: {},
  },
  additionalProperties: true,
} as const;

function parseFileIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      "fileIds must be an array of strings",
      400,
    );
  }
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const id = raw[i];
    if (typeof id !== "string" || id.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `fileIds[${i}] must be a non-empty string`,
        400,
      );
    }
    ids.push(id);
  }
  return ids;
}

function parseBasedOnVersion(
  raw: unknown,
  defaultHead: number,
): number {
  if (raw === undefined || raw === null || raw === "") {
    return defaultHead;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      "basedOnVersion must be a non-negative integer",
      400,
    );
  }
  return raw;
}

function parseStoredFileIds(fileIdsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fileIdsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Build the draft wire response, computing `stale` from based_on vs current head.
 * A draft is stale when it was based on an older head than the scene has now.
 */
export function toDraftResponse(
  row: DraftRow,
  headVersion: number,
): DraftResponse {
  const basedOnVersion = row.based_on_version;
  return {
    elements: gunzipJson<SceneDocument["elements"]>(row.elements),
    appState: gunzipJson<SceneDocument["appState"]>(row.app_state),
    fileIds: parseStoredFileIds(row.file_ids),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    basedOnVersion,
    headVersion,
    stale: basedOnVersion < headVersion,
  };
}

/**
 * Register draft autosave routes under `/api` with Bearer auth.
 */
export async function registerDraftRoutes(
  app: FastifyInstance,
  deps: { db: Database },
): Promise<void> {
  const { db } = deps;
  const authPreHandler = createAuthPreHandler(db);

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      // -----------------------------------------------------------------
      // PUT /scenes/:slug/draft — overwrite working copy (one row)
      // -----------------------------------------------------------------
      api.put<{
        Params: { slug: string };
        Body: PutDraftBody;
      }>(
        "/scenes/:slug/draft",
        {
          schema: {
            body: putDraftBodySchema,
          },
        },
        async (request) => {
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

          let doc: SceneDocument;
          try {
            doc = normalizeScene({
              elements: request.body.elements,
              appState: request.body.appState,
            });
          } catch (err) {
            if (err instanceof SceneValidationError) {
              throw new AppError(
                ErrorCode.VALIDATION,
                err.message,
                400,
                { problems: err.problems },
              );
            }
            throw err;
          }

          const fileIds = parseFileIds(request.body.fileIds);
          const basedOnVersion = parseBasedOnVersion(
            request.body.basedOnVersion,
            scene.head_version,
          );
          // Identity only — body.updatedBy / body.author are ignored.
          const updatedBy = authorFromIdentity(identity);

          const row = db.upsertDraft({
            scene_id: scene.id,
            elements: gzipJson(doc.elements),
            app_state: gzipJson(doc.appState),
            file_ids: fileIds,
            updated_by: updatedBy,
            based_on_version: basedOnVersion,
          });

          // Re-read head in case a concurrent commit moved it during the put.
          const headNow =
            db.getSceneById(scene.id)?.head_version ?? scene.head_version;
          return toDraftResponse(row, headNow);
        },
      );

      // -----------------------------------------------------------------
      // GET /scenes/:slug/draft
      // -----------------------------------------------------------------
      api.get<{
        Params: { slug: string };
      }>("/scenes/:slug/draft", async (request) => {
        const { slug } = request.params;
        const scene = db.getSceneBySlug(slug);
        if (!scene) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `scene not found: ${slug}`,
            404,
          );
        }

        const row = db.getDraft(scene.id);
        if (!row) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `no draft for scene: ${slug}`,
            404,
          );
        }

        return toDraftResponse(row, scene.head_version);
      });

      // -----------------------------------------------------------------
      // DELETE /scenes/:slug/draft — explicit discard
      // -----------------------------------------------------------------
      api.delete<{
        Params: { slug: string };
      }>("/scenes/:slug/draft", async (request, reply) => {
        const { slug } = request.params;
        const scene = db.getSceneBySlug(slug);
        if (!scene) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `scene not found: ${slug}`,
            404,
          );
        }

        const deleted = db.deleteDraft(scene.id);
        if (!deleted) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            `no draft for scene: ${slug}`,
            404,
          );
        }

        return reply.status(204).send();
      });
    },
    { prefix: "/api" },
  );
}
