/**
 * Scene envelope normalization and appState whitelist.
 *
 * Hard rule (PLAN.md): never author or mutate element internals. Array order
 * is authoritative; fractional `index` is optional and is left alone.
 */

import type { BinaryFiles, ExcalidrawElement, PersistedAppState, SceneDocument } from "./types.js";

// ---------------------------------------------------------------------------
// Persistable appState allowlist (never a denylist)
// ---------------------------------------------------------------------------

/**
 * Keys of AppState that are safe to store server-side. Mirrors
 * `PersistedAppState` in types.ts. Everything else (collaborators,
 * selectedElementIds, scroll/zoom, open dialogs, cursor, …) is per-viewer
 * noise and must never be persisted — it would pollute every diff.
 *
 * `theme` remains listed for wire compatibility (historical versions may
 * carry it), but is a per-viewer preference and is stripped by
 * {@link pickAppState} so it is never written back or diffed (issue #38).
 */
export const PERSISTED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridModeEnabled",
  "gridStep",
  "exportBackground",
  "exportWithDarkMode",
  "exportScale",
  "exportEmbedScene",
  "frameRendering",
  "theme",
  "name",
] as const satisfies readonly (keyof PersistedAppState)[];

/**
 * Keys present in {@link PERSISTED_APP_STATE_KEYS} for wire / historical
 * compatibility that must never be the source of truth on load or written
 * on commit. Resolved at view time (localStorage → instance default →
 * prefers-color-scheme).
 */
export const VIEWER_ONLY_APP_STATE_KEYS = [
  "theme",
] as const satisfies readonly (keyof PersistedAppState)[];

const VIEWER_ONLY_APP_STATE_KEY_SET: ReadonlySet<string> = new Set(VIEWER_ONLY_APP_STATE_KEYS);

// ---------------------------------------------------------------------------
// Validation error — reports every problem found, not just the first
// ---------------------------------------------------------------------------

/**
 * Thrown by `normalizeScene` when input is malformed. `problems` lists every
 * issue discovered so callers (server, CLI) can surface actionable feedback
 * without a second round trip.
 */
export class SceneValidationError extends Error {
  override readonly name = "SceneValidationError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const list = [...problems];
    super(
      list.length === 1
        ? `Invalid scene: ${list[0]}`
        : `Invalid scene (${list.length} problems):\n- ${list.join("\n- ")}`,
    );
    this.problems = list;
  }
}

// ---------------------------------------------------------------------------
// pickAppState
// ---------------------------------------------------------------------------

/**
 * Whitelist only persistable appState keys. Unknown / non-persistable keys
 * are dropped. Input may be any partial object (or nullish → `{}`).
 *
 * This is an allowlist, never a denylist. Viewer-only keys (currently
 * `theme`) are dropped even when listed in {@link PERSISTED_APP_STATE_KEYS},
 * so toggling dark mode never enters a scene document or its diffs.
 */
export function pickAppState(appState: unknown): Partial<PersistedAppState> {
  if (appState == null || typeof appState !== "object" || Array.isArray(appState)) {
    return {};
  }
  const src = appState as Record<string, unknown>;
  const out: Partial<PersistedAppState> = {};
  for (const key of PERSISTED_APP_STATE_KEYS) {
    if (VIEWER_ONLY_APP_STATE_KEY_SET.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
      // Value type is trusted as-is; we do not coerce or rewrite.
      (out as Record<string, unknown>)[key] = src[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// normalizeScene
// ---------------------------------------------------------------------------

/**
 * Accept any of:
 *  - a full `.excalidraw` file (`{ type, version, source, elements, appState, files }`)
 *  - a bare element array
 *  - a partial document (`{ elements?, appState?, files? }`)
 *
 * Return a canonical `SceneDocument`. Element objects pass through untouched
 * (same references, same order). Non-persistable appState is dropped.
 * Envelope metadata (`type`, `version`, `source`) is discarded.
 *
 * On invalid input, throws `SceneValidationError` listing every problem.
 */
export function normalizeScene(input: unknown): SceneDocument {
  const problems: string[] = [];

  // Bare element array is a valid shorthand for a document.
  if (Array.isArray(input)) {
    return normalizeFromParts(input, undefined, undefined, problems);
  }

  if (input == null || typeof input !== "object") {
    throw new SceneValidationError([
      `expected an object, a partial SceneDocument, or an element array; got ${describeType(input)}`,
    ]);
  }

  const obj = input as Record<string, unknown>;

  // If `elements` is present it must be an array; if absent, treat as empty
  // only when the object looks like a document envelope (has appState/files
  // or known .excalidraw keys). A completely empty `{}` is a valid empty scene.
  const hasElementsKey = Object.prototype.hasOwnProperty.call(obj, "elements");
  if (hasElementsKey && !Array.isArray(obj.elements)) {
    problems.push(`elements must be an array; got ${describeType(obj.elements)}`);
  }

  if (
    Object.prototype.hasOwnProperty.call(obj, "files") &&
    obj.files != null &&
    (typeof obj.files !== "object" || Array.isArray(obj.files))
  ) {
    problems.push(`files must be an object map; got ${describeType(obj.files)}`);
  }

  if (
    Object.prototype.hasOwnProperty.call(obj, "appState") &&
    obj.appState != null &&
    (typeof obj.appState !== "object" || Array.isArray(obj.appState))
  ) {
    problems.push(`appState must be an object; got ${describeType(obj.appState)}`);
  }

  const elements = hasElementsKey && Array.isArray(obj.elements) ? obj.elements : [];
  const files =
    obj.files != null && typeof obj.files === "object" && !Array.isArray(obj.files)
      ? (obj.files as BinaryFiles)
      : undefined;
  const appState =
    obj.appState != null && typeof obj.appState === "object" && !Array.isArray(obj.appState)
      ? obj.appState
      : undefined;

  // If elements key was present but not an array we already recorded a problem;
  // still run further validation on whatever we can so the error is complete.
  const elementsForValidation = hasElementsKey && !Array.isArray(obj.elements) ? [] : elements;

  return normalizeFromParts(elementsForValidation, appState, files, problems);
}

function normalizeFromParts(
  elements: unknown[],
  appState: unknown,
  files: BinaryFiles | undefined,
  problems: string[],
): SceneDocument {
  const seenIds = new Map<string, number>();
  const fileIdsReferenced = new Set<string>();

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el == null || typeof el !== "object" || Array.isArray(el)) {
      problems.push(`elements[${i}] must be an object; got ${describeType(el)}`);
      continue;
    }
    const rec = el as Record<string, unknown>;

    if (!Object.prototype.hasOwnProperty.call(rec, "id") || rec.id === undefined) {
      problems.push(`elements[${i}] is missing required field "id"`);
    } else if (typeof rec.id !== "string") {
      problems.push(`elements[${i}].id must be a string; got ${describeType(rec.id)}`);
    } else if (rec.id.length === 0) {
      problems.push(`elements[${i}].id must be a non-empty string`);
    } else {
      const prev = seenIds.get(rec.id);
      if (prev !== undefined) {
        problems.push(
          `duplicate element id "${rec.id}" at elements[${i}] (first seen at elements[${prev}])`,
        );
      } else {
        seenIds.set(rec.id, i);
      }
    }

    if (!Object.prototype.hasOwnProperty.call(rec, "type") || rec.type === undefined) {
      problems.push(`elements[${i}] is missing required field "type"`);
    } else if (typeof rec.type !== "string") {
      problems.push(`elements[${i}].type must be a string; got ${describeType(rec.type)}`);
    } else if (rec.type.length === 0) {
      problems.push(`elements[${i}].type must be a non-empty string`);
    }

    // Track file references from image-like elements (fileId present).
    if (typeof rec.fileId === "string" && rec.fileId.length > 0 && rec.isDeleted !== true) {
      fileIdsReferenced.add(rec.fileId);
    }
  }

  const filesMap: BinaryFiles = files ?? ({} as BinaryFiles);
  if (files != null) {
    for (const [fileId, entry] of Object.entries(filesMap)) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push(
          `files["${fileId}"] must be a BinaryFileData object; got ${describeType(entry)}`,
        );
        continue;
      }
      const f = entry as Record<string, unknown>;
      if (typeof f.dataURL !== "string") {
        problems.push(
          `files["${fileId}"].dataURL must be a string; got ${describeType(f.dataURL)}`,
        );
      }
      if (typeof f.mimeType !== "string") {
        problems.push(
          `files["${fileId}"].mimeType must be a string; got ${describeType(f.mimeType)}`,
        );
      }
    }
  }

  // Elements that reference a fileId must have a matching entry in files.
  for (const fileId of fileIdsReferenced) {
    if (!Object.prototype.hasOwnProperty.call(filesMap, fileId)) {
      problems.push(`element references fileId "${fileId}" which is missing from the files map`);
    }
  }

  if (problems.length > 0) {
    throw new SceneValidationError(problems);
  }

  // Elements pass through untouched — same array contents / object identity.
  // We do not reorder, strip, or rewrite element fields (including optional index).
  return {
    elements: elements as ExcalidrawElement[],
    appState: pickAppState(appState),
    files: filesMap,
  };
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
