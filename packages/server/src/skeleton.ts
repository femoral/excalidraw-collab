/**
 * Skeleton conversion — agents author ~5 fields per shape; upstream
 * `convertToExcalidrawElements` (run inside the render worker) expands them
 * to full elements with real bindings and bound text.
 *
 *   POST /api/skeleton/convert  { elements, regenerateIds? } → { elements }
 *
 * Requires RENDER_WORKER=on. Structural validation reports the offending
 * index and reason so an agent can fix a single bad entry without guessing.
 */
import type { FastifyInstance } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Database } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Duck-type RenderError NOT_INSTALLED without importing render.ts. */
function isRenderNotInstalledError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "RenderError" && e.code === "NOT_INSTALLED";
}

/** Message when the render worker is disabled or not wired. */
export const SKELETON_WORKER_DISABLED_MESSAGE =
  "Skeleton conversion is not available: RENDER_WORKER=off. " +
  "Set RENDER_WORKER=on and ensure the web app is served (SERVE_STATIC=on) " +
  "so Chromium can load /render. Install browsers with: " +
  "pnpm exec playwright install chromium";

/** Message when Playwright was not installed (optionalDependency skipped). */
export const SKELETON_WORKER_NOT_INSTALLED_MESSAGE =
  "Skeleton conversion is not available: Playwright is not installed. " +
  "This deployment was built without render support (optional dependency skipped — " +
  "e.g. pnpm install --no-optional). Install optional dependencies or rebuild with " +
  "Playwright, then set RENDER_WORKER=on.";

/** Upstream skeleton element types we accept. */
export const SKELETON_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "text",
  "image",
  "frame",
  "magicframe",
  "freedraw",
  "iframe",
  "embeddable",
]);

/** Types that need numeric x/y on the skeleton. */
const POSITIONED_TYPES = new Set(["rectangle", "ellipse", "diamond", "text", "image", "line"]);

export type SkeletonErrorDetails = {
  index: number;
  reason: string;
};

/**
 * Convert skeleton elements to full Excalidraw elements.
 * Implemented by the Playwright render worker (or a test mock).
 */
export type SkeletonConverter = {
  convert(request: {
    elements: readonly unknown[];
    regenerateIds?: boolean;
  }): Promise<{ elements: unknown[] }>;
};

/**
 * Validate one skeleton entry. Throws AppError VALIDATION with
 * details `{ index, reason }` on failure.
 */
export function validateSkeletonEntry(entry: unknown, index: number): void {
  const fail = (reason: string): never => {
    throw new AppError(ErrorCode.VALIDATION, `skeleton[${index}]: ${reason}`, 400, {
      index,
      reason,
    } satisfies SkeletonErrorDetails);
  };

  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail("expected a plain object");
  }

  const el = entry as Record<string, unknown>;

  if (typeof el.type !== "string" || el.type.length === 0) {
    fail('missing or invalid "type" (string required)');
  }
  // Indexed Record access is not narrowed by control-flow; re-bind after guard.
  const type: string = el.type as string;
  if (!SKELETON_TYPES.has(type)) {
    fail(`unknown type ${JSON.stringify(type)}; expected one of ${[...SKELETON_TYPES].join(", ")}`);
  }

  if (el.id !== undefined && typeof el.id !== "string") {
    fail('"id" must be a string when provided');
  }

  if (POSITIONED_TYPES.has(type)) {
    if (typeof el.x !== "number" || !Number.isFinite(el.x)) {
      fail('"x" must be a finite number');
    }
    if (typeof el.y !== "number" || !Number.isFinite(el.y)) {
      fail('"y" must be a finite number');
    }
  }

  if (type === "text") {
    if (typeof el.text !== "string") {
      fail('text skeleton requires string "text"');
    }
  }

  if (type === "image") {
    if (typeof el.fileId !== "string" || el.fileId.length === 0) {
      fail('image skeleton requires non-empty string "fileId"');
    }
  }

  if (type === "frame" || type === "magicframe") {
    if (!Array.isArray(el.children)) {
      fail('frame skeleton requires "children" array of element ids');
    }
    const children = el.children as unknown[];
    for (let i = 0; i < children.length; i++) {
      if (typeof children[i] !== "string") {
        fail(`children[${i}] must be a string id`);
      }
    }
  }

  if (type === "arrow" || type === "line") {
    // start/end are optional; when present as id refs they must be objects.
    for (const end of ["start", "end"] as const) {
      const ref = el[end];
      if (ref === undefined || ref === null) continue;
      if (typeof ref !== "object" || Array.isArray(ref)) {
        fail(`"${end}" must be an object ({ id } or inline shape)`);
      }
      const r = ref as Record<string, unknown>;
      if (r.id !== undefined && typeof r.id !== "string") {
        fail(`"${end}.id" must be a string when provided`);
      }
    }
  }

  if (el.label !== undefined) {
    if (el.label === null || typeof el.label !== "object" || Array.isArray(el.label)) {
      fail('"label" must be an object with "text"');
    }
    const label = el.label as Record<string, unknown>;
    if (typeof label.text !== "string") {
      fail('"label.text" must be a string');
    }
  }
}

/**
 * Validate a full skeleton array. Also checks duplicate ids and that arrow
 * start/end id refs resolve to another skeleton entry.
 */
export function validateSkeletonElements(elements: unknown[]): void {
  if (!Array.isArray(elements)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      "body.elements must be an array of skeleton entries",
      400,
    );
  }

  const ids = new Map<string, number>();
  for (let i = 0; i < elements.length; i++) {
    validateSkeletonEntry(elements[i], i);
    const el = elements[i] as Record<string, unknown>;
    if (typeof el.id === "string" && el.id.length > 0) {
      const prev = ids.get(el.id);
      if (prev !== undefined) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `skeleton[${i}]: duplicate id ${JSON.stringify(el.id)} (also at index ${prev})`,
          400,
          {
            index: i,
            reason: `duplicate id ${JSON.stringify(el.id)} (also at index ${prev})`,
          } satisfies SkeletonErrorDetails,
        );
      }
      ids.set(el.id, i);
    }
  }

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as Record<string, unknown>;
    if (el.type !== "arrow" && el.type !== "line") continue;
    for (const end of ["start", "end"] as const) {
      const ref = el[end];
      if (ref === null || typeof ref !== "object" || Array.isArray(ref)) continue;
      const id = (ref as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) continue;
      // Inline shapes may carry type+id of a not-yet-listed element; only
      // fail pure id refs that point nowhere.
      const hasInlineType = typeof (ref as Record<string, unknown>).type === "string";
      if (!hasInlineType && !ids.has(id)) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `skeleton[${i}]: ${end}.id ${JSON.stringify(id)} does not match any skeleton entry id`,
          400,
          {
            index: i,
            reason: `${end}.id ${JSON.stringify(id)} does not match any skeleton entry id`,
          } satisfies SkeletonErrorDetails,
        );
      }
    }
  }

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as Record<string, unknown>;
    if (el.type !== "frame" && el.type !== "magicframe") continue;
    const children = el.children as string[];
    for (const childId of children) {
      if (!ids.has(childId)) {
        throw new AppError(
          ErrorCode.VALIDATION,
          `skeleton[${i}]: children id ${JSON.stringify(childId)} does not match any skeleton entry id`,
          400,
          {
            index: i,
            reason: `children id ${JSON.stringify(childId)} does not match any skeleton entry id`,
          } satisfies SkeletonErrorDetails,
        );
      }
    }
  }
}

/**
 * Mutable holder so main can attach the Playwright worker after listen
 * without re-registering routes. Tests inject a fixed converter.
 */
export type SkeletonConverterHolder = {
  current: SkeletonConverter | null;
};

export type RegisterSkeletonRoutesOpts = {
  db: Database;
  /**
   * Converter backed by the render worker. When `current` is null the endpoint
   * replies 501 with a clear, actionable message. Prefer a holder so production
   * can late-bind the worker after the HTTP port is known.
   */
  converter: SkeletonConverter | SkeletonConverterHolder | null | undefined;
};

function resolveConverter(
  converter: RegisterSkeletonRoutesOpts["converter"],
): SkeletonConverter | null {
  if (converter === null || converter === undefined) return null;
  if (typeof (converter as SkeletonConverter).convert === "function") {
    return converter as SkeletonConverter;
  }
  return (converter as SkeletonConverterHolder).current;
}

export async function registerSkeletonRoutes(
  app: FastifyInstance,
  opts: RegisterSkeletonRoutesOpts,
): Promise<void> {
  const requireAuth = createAuthPreHandler(opts.db);

  app.post(
    "/api/skeleton/convert",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["elements"],
          additionalProperties: false,
          properties: {
            elements: {
              type: "array",
              // Per-entry validation is custom (index + reason); schema only
              // enforces the array shape.
              items: {},
            },
            regenerateIds: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const converter = resolveConverter(opts.converter);
      if (!converter) {
        throw new AppError(ErrorCode.NOT_IMPLEMENTED, SKELETON_WORKER_DISABLED_MESSAGE, 501, {
          reason: "disabled",
        });
      }

      const body = request.body as {
        elements: unknown[];
        regenerateIds?: boolean;
      };

      validateSkeletonElements(body.elements);

      try {
        const result = await converter.convert({
          elements: body.elements,
          regenerateIds: body.regenerateIds === true,
        });
        return { elements: result.elements };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (isRenderNotInstalledError(err)) {
          const cause = err instanceof Error ? err.message : undefined;
          throw new AppError(
            ErrorCode.NOT_IMPLEMENTED,
            SKELETON_WORKER_NOT_INSTALLED_MESSAGE,
            501,
            {
              reason: "not_installed",
              ...(cause ? { cause } : {}),
            },
          );
        }
        const message = err instanceof Error ? err.message : "skeleton conversion failed";
        // Surface worker-reported skeleton[i]: reason when present.
        const match = /^skeleton\[(\d+)\]:\s*(.*)$/.exec(message);
        if (match) {
          const index = Number(match[1]);
          const reason = match[2] || message;
          throw new AppError(ErrorCode.VALIDATION, `skeleton[${index}]: ${reason}`, 400, {
            index,
            reason,
          } satisfies SkeletonErrorDetails);
        }
        throw new AppError(ErrorCode.INTERNAL, `skeleton conversion failed: ${message}`, 500);
      }
    },
  );
}
