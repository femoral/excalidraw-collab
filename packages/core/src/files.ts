/**
 * Separate binary files from a scene document for content-addressed storage,
 * and rehydrate on read. Round-trips exactly.
 */

import type { BinaryFiles, SceneDocument } from "./types.js";

/**
 * Peel the `files` map off a document so binaries can be stored
 * content-addressed (keyed by Excalidraw's `fileId`) independently of the
 * version row. Returns a document whose `files` is `{}` plus the extracted map.
 *
 * Element objects and appState are left untouched (same references).
 */
export function splitFiles(doc: SceneDocument): {
  doc: SceneDocument;
  files: BinaryFiles;
} {
  const files: BinaryFiles = doc.files ?? {};
  return {
    doc: {
      elements: doc.elements,
      appState: doc.appState,
      files: {},
    },
    files,
  };
}

/**
 * Rehydrate a document with a files map (typically loaded from the content-
 * addressed file store). The provided `files` become the document's files
 * map exactly — existing `doc.files` entries are not merged.
 *
 * Element objects and appState are left untouched (same references).
 */
export function mergeFiles(doc: SceneDocument, files: BinaryFiles): SceneDocument {
  return {
    elements: doc.elements,
    appState: doc.appState,
    files,
  };
}
