/**
 * Scene editor: load head-or-draft, debounced draft autosave, commit turn,
 * MainMenu items, image upload to the content-addressed file store.
 */

import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { ApiError, type ApiClient, type BinaryFilePayload } from "./api.ts";
import {
  arrayBufferToDataURL,
  buildCommitPayload,
  buildDraftPayload,
  createDebouncedCoalescer,
  DRAFT_AUTOSAVE_MS,
  filesNeedingUpload,
  formatFileUploadError,
  getEditorUnsavedFlag,
  hasUnsavedChanges,
  postCommitState,
  saveIndicatorLabel,
  selectInitialSource,
  setEditorUnsavedFlag,
  UNSAVED_LEAVE_MESSAGE,
  validateCommitMessage,
  type EditorSnapshot,
  type SaveIndicator,
} from "./editor-logic.ts";
import {
  buildRestorePayload,
  headEditorPath,
  historyPath,
  isReadOnlyVersion,
} from "./history-logic.ts";

export type SceneEditorProps = {
  slug: string;
  api: ApiClient;
  onNavigate: (path: string, event?: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * When set, load this absolute version instead of head/draft.
   * Past versions open read-only (no draft, no commit).
   */
  version?: number | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      initialData: {
        elements: readonly OrderedExcalidrawElement[];
        appState: Partial<AppState>;
        files: BinaryFiles;
      };
      headVersion: number;
      /** Absolute version currently displayed (head when live-editing). */
      viewingVersion: number;
      readOnly: boolean;
      draftStale: boolean;
      sceneName: string;
    };

function toBinaryFiles(
  files: Record<string, BinaryFilePayload> | undefined,
): BinaryFiles {
  if (!files) return {};
  const out: BinaryFiles = {};
  for (const [id, entry] of Object.entries(files)) {
    if (!entry?.dataURL) continue;
    out[id as keyof BinaryFiles] = {
      id: (entry.id || id) as BinaryFilePayload["id"] & string,
      mimeType: entry.mimeType as BinaryFiles[string]["mimeType"],
      dataURL: entry.dataURL as BinaryFiles[string]["dataURL"],
      created: entry.created ?? Date.now(),
    } as BinaryFiles[string];
  }
  return out;
}

function snapshotFromEditor(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): EditorSnapshot {
  const fileMap: Record<string, BinaryFilePayload | undefined> = {};
  for (const [id, entry] of Object.entries(files)) {
    if (!entry) continue;
    fileMap[id] = {
      id: String(entry.id ?? id),
      mimeType: String(entry.mimeType ?? "application/octet-stream"),
      dataURL: String(entry.dataURL ?? ""),
      created: typeof entry.created === "number" ? entry.created : undefined,
    };
  }
  return { elements, appState, files: fileMap };
}

/**
 * SEAM for issue #23 — advisory turn lock API lands there.
 * Menu items are wired; behaviour is intentionally a no-op with a clear note.
 */
function claimOrReleaseTurnSeam(): void {
  // TODO(#23): call POST/DELETE /api/scenes/:slug/lock once the locking API lands.
  // Do not fake lock state in the UI before then.
  console.info(
    "[excalidraw-collab] Claim/release turn is a seam for #23 (locking API).",
  );
}

export function SceneEditor({
  slug,
  api,
  onNavigate,
  version = null,
}: SceneEditorProps): ReactElement {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [saveIndicator, setSaveIndicator] = useState<SaveIndicator>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const headVersionRef = useRef(0);
  const uploadedFilesRef = useRef(new Set<string>());
  const latestSnapshotRef = useRef<EditorSnapshot | null>(null);
  const hydratingRef = useRef(true);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const coalescerRef = useRef<ReturnType<
    typeof createDebouncedCoalescer<EditorSnapshot>
  > | null>(null);
  /** Snapshot of the loaded past version for restore-from-readonly. */
  const loadedDocRef = useRef<{
    elements: unknown[];
    appState: Record<string, unknown>;
    files: Record<string, BinaryFilePayload | undefined>;
  } | null>(null);

  const commitTitleId = useId();
  const commitMessageId = useId();

  // ----- load head + optional draft, or a specific past version -------------

  useEffect(() => {
    let cancelled = false;
    hydratingRef.current = true;
    setLoad({ kind: "loading" });
    setSaveIndicator("idle");
    setSaveError(null);
    setFileError(null);
    setBanner(null);
    setCommitOpen(false);
    uploadedFilesRef.current = new Set();
    loadedDocRef.current = null;

    void (async () => {
      try {
        const meta = await api.getSceneMeta(slug);
        if (cancelled) return;

        headVersionRef.current = meta.headVersion;

        const wantVersion = version ?? null;
        const readOnly = isReadOnlyVersion(wantVersion, meta.headVersion);

        // Past version: load exactly that revision, skip draft entirely.
        if (readOnly && wantVersion != null) {
          const sceneDoc = await api.getSceneDocument(slug, wantVersion);
          if (cancelled) return;

          const elements =
            (sceneDoc.elements as readonly OrderedExcalidrawElement[]) ?? [];
          const appState = (sceneDoc.appState ?? {}) as Partial<AppState>;
          const files = toBinaryFiles(
            sceneDoc.files as Record<string, BinaryFilePayload> | undefined,
          );
          for (const id of Object.keys(files)) {
            uploadedFilesRef.current.add(id);
          }

          loadedDocRef.current = {
            elements: [...elements],
            appState: { ...(appState as Record<string, unknown>) },
            files: sceneDoc.files as Record<
              string,
              BinaryFilePayload | undefined
            >,
          };

          setLoad({
            kind: "ready",
            initialData: { elements, appState, files },
            headVersion: meta.headVersion,
            viewingVersion: wantVersion,
            readOnly: true,
            draftStale: false,
            sceneName: meta.name,
          });
          setBanner(
            `Viewing v${wantVersion} (read-only). Restore creates a new version — history is never rewritten.`,
          );
          return;
        }

        // Live editor: head (or matching version) + optional draft.
        const [sceneDoc, draft] = await Promise.all([
          api.getSceneDocument(
            slug,
            wantVersion != null && wantVersion === meta.headVersion
              ? wantVersion
              : undefined,
          ),
          api.getDraft(slug),
        ]);
        if (cancelled) return;

        const selection = selectInitialSource(
          draft
            ? {
                updatedAt: draft.updatedAt,
                basedOnVersion: draft.basedOnVersion,
                headVersion: draft.headVersion,
                stale: draft.stale,
              }
            : null,
          {
            headVersion: meta.headVersion,
            updatedAt: meta.updatedAt,
          },
        );

        let elements: readonly OrderedExcalidrawElement[];
        let appState: Partial<AppState>;
        let files: BinaryFiles;
        let draftStale = false;

        if (selection.source === "draft" && draft) {
          draftStale = selection.stale;
          elements = draft.elements as readonly OrderedExcalidrawElement[];
          appState = (draft.appState ?? {}) as Partial<AppState>;
          files = {};
          // Rehydrate binaries from the content-addressed store.
          for (const fileId of draft.fileIds) {
            try {
              const { bytes, mimeType } = await api.getFileBytes(fileId);
              if (cancelled) return;
              const payload = arrayBufferToDataURL(bytes, mimeType, fileId);
              files = {
                ...files,
                [fileId]: {
                  id: fileId as BinaryFiles[string]["id"],
                  mimeType: mimeType as BinaryFiles[string]["mimeType"],
                  dataURL: payload.dataURL as BinaryFiles[string]["dataURL"],
                  created: payload.created ?? Date.now(),
                },
              };
              uploadedFilesRef.current.add(fileId);
            } catch (err) {
              // Missing blob: keep going; image elements will show as broken.
              console.warn(
                `[excalidraw-collab] failed to rehydrate file ${fileId}`,
                err,
              );
            }
          }
          // Files already on the server from prior head versions that the draft
          // may still reference but not list — merge head files for completeness.
          const headFiles = toBinaryFiles(
            sceneDoc.files as Record<string, BinaryFilePayload> | undefined,
          );
          for (const [id, entry] of Object.entries(headFiles)) {
            if (!files[id] && entry) {
              files = { ...files, [id]: entry };
              uploadedFilesRef.current.add(id);
            }
          }
        } else {
          elements =
            (sceneDoc.elements as readonly OrderedExcalidrawElement[]) ?? [];
          appState = (sceneDoc.appState ?? {}) as Partial<AppState>;
          files = toBinaryFiles(
            sceneDoc.files as Record<string, BinaryFilePayload> | undefined,
          );
          for (const id of Object.keys(files)) {
            uploadedFilesRef.current.add(id);
          }
        }

        if (cancelled) return;

        const viewingVersion =
          meta.headVersion > 0 ? meta.headVersion : 0;

        setLoad({
          kind: "ready",
          initialData: {
            elements,
            appState,
            files,
          },
          headVersion: meta.headVersion,
          viewingVersion,
          readOnly: false,
          draftStale,
          sceneName: meta.name,
        });
        if (draftStale) {
          setBanner(
            "Your draft is based on an older version — someone committed while you were away. Review before committing.",
          );
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.isUnauthorized) return;
        const message =
          err instanceof Error ? err.message : "Failed to load scene.";
        setLoad({ kind: "error", message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, slug, version]);

  const readOnly = load.kind === "ready" && load.readOnly;

  // ----- debounced draft saver (disabled in read-only) ----------------------

  const persistDraft = useCallback(
    async (snapshot: EditorSnapshot) => {
      // Upload any new images first so the draft fileIds resolve on reload.
      const need = filesNeedingUpload(snapshot.files, uploadedFilesRef.current);
      for (const file of need) {
        try {
          await api.uploadFile(file);
          uploadedFilesRef.current.add(file.id);
        } catch (err) {
          const message =
            err instanceof ApiError
              ? formatFileUploadError(err)
              : formatFileUploadError({
                  message: err instanceof Error ? err.message : undefined,
                });
          setFileError(message);
          throw err instanceof Error ? err : new Error(message);
        }
      }

      const body = buildDraftPayload(snapshot, headVersionRef.current);
      await api.putDraft(slug, body);
      setSaveError(null);
      setFileError(null);
    },
    [api, slug],
  );

  useEffect(() => {
    if (readOnly) {
      coalescerRef.current?.dispose();
      coalescerRef.current = null;
      return;
    }
    const coalescer = createDebouncedCoalescer<EditorSnapshot>({
      delayMs: DRAFT_AUTOSAVE_MS,
      save: persistDraft,
      onStatus: (status) => {
        if (status === "scheduled") setSaveIndicator("dirty");
        else if (status === "saving") setSaveIndicator("saving");
        else if (status === "saved") setSaveIndicator("saved");
        else if (status === "error") {
          setSaveIndicator("error");
          setSaveError("Could not save draft. Your latest strokes are local only.");
        }
      },
    });
    coalescerRef.current = coalescer;
    return () => {
      coalescer.dispose();
      coalescerRef.current = null;
    };
  }, [persistDraft, readOnly]);

  // ----- unsaved-changes guard ----------------------------------------------

  useEffect(() => {
    if (readOnly) {
      setEditorUnsavedFlag(false);
      return;
    }
    setEditorUnsavedFlag(hasUnsavedChanges(saveIndicator));
    return () => setEditorUnsavedFlag(false);
  }, [saveIndicator, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges(saveIndicator) || getEditorUnsavedFlag()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveIndicator, readOnly]);

  const guardedNavigate = useCallback(
    (path: string, event?: MouseEvent<HTMLAnchorElement>) => {
      if (!readOnly && hasUnsavedChanges(saveIndicator)) {
        const ok = window.confirm(UNSAVED_LEAVE_MESSAGE);
        if (!ok) {
          event?.preventDefault();
          return;
        }
        setEditorUnsavedFlag(false);
      }
      onNavigate(path, event);
    },
    [onNavigate, saveIndicator, readOnly],
  );

  // ----- onChange -----------------------------------------------------------

  const handleChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      // Read-only: never draft-save or mark dirty (viewMode blocks edits).
      if (load.kind === "ready" && load.readOnly) {
        return;
      }

      const snapshot = snapshotFromEditor(elements, appState, files);
      latestSnapshotRef.current = snapshot;

      // First onChange after mount is hydration — establish baseline only.
      if (hydratingRef.current) {
        hydratingRef.current = false;
        return;
      }

      coalescerRef.current?.push(snapshot);
    },
    [load],
  );

  // ----- commit (live editor only) ------------------------------------------

  async function handleCommit(event: FormEvent) {
    event.preventDefault();
    if (readOnly) {
      setCommitError("Read-only view — switch to head to commit.");
      return;
    }
    const validated = validateCommitMessage(commitMessage);
    if (!validated.ok) {
      setCommitError(validated.error);
      return;
    }

    // Prefer live editor state; fall back to last onChange snapshot.
    let snapshot = latestSnapshotRef.current;
    const apiHandle = apiRef.current;
    if (apiHandle) {
      const elements = apiHandle.getSceneElementsIncludingDeleted();
      const appState = apiHandle.getAppState();
      const files = apiHandle.getFiles();
      snapshot = snapshotFromEditor(elements, appState, files);
      latestSnapshotRef.current = snapshot;
    }
    if (!snapshot) {
      setCommitError("Nothing to commit yet.");
      return;
    }

    setCommitBusy(true);
    setCommitError(null);
    try {
      // Drain pending draft so we do not race a PUT against the commit.
      await coalescerRef.current?.flushNow();

      // Upload any remaining new files before the turn lands.
      const need = filesNeedingUpload(
        snapshot.files,
        uploadedFilesRef.current,
      );
      for (const file of need) {
        try {
          await api.uploadFile(file);
          uploadedFilesRef.current.add(file.id);
        } catch (err) {
          const message =
            err instanceof ApiError
              ? formatFileUploadError(err)
              : formatFileUploadError({
                  message: err instanceof Error ? err.message : undefined,
                });
          setCommitError(message);
          setFileError(message);
          setCommitBusy(false);
          return;
        }
      }

      // Include files so the version's file_ids list is complete; server
      // content-addresses them (dedup if already uploaded). Binaries never
      // live in elements — only fileId references.
      const body = buildCommitPayload(
        snapshot,
        headVersionRef.current,
        validated.message,
        { includeFiles: true },
      );

      const result = await api.commitScene(slug, body);
      // Server clears draft inside the same transaction; local DELETE is belt.
      await api.deleteDraft(slug);

      const next = postCommitState(result.headVersion);
      headVersionRef.current = next.headVersion;
      setSaveIndicator(next.saveIndicator);
      setSaveError(null);
      setBanner(null);
      setCommitOpen(false);
      setCommitMessage("");
      setBanner(
        `Committed v${result.version} as ${result.author}: “${result.message}”`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      if (err instanceof ApiError && err.isConflict) {
        setCommitError(
          err.message ||
            "Conflict: the scene moved while you were editing. Reload or force-resolve (CLI).",
        );
      } else {
        setCommitError(
          err instanceof Error ? err.message : "Commit failed.",
        );
      }
    } finally {
      setCommitBusy(false);
    }
  }

  // ----- restore from read-only view ----------------------------------------

  async function handleRestoreFromView() {
    if (load.kind !== "ready" || !load.readOnly) return;
    const restoredVersion = load.viewingVersion;
    const ok = window.confirm(
      `Restore v${restoredVersion} as a new version?\n\n` +
        `This commits the content of v${restoredVersion} on top of head v${load.headVersion}. ` +
        `Earlier versions stay in history.`,
    );
    if (!ok) return;

    setRestoreBusy(true);
    try {
      const source =
        loadedDocRef.current ?? {
          elements: [...load.initialData.elements],
          appState: load.initialData.appState as Record<string, unknown>,
          files: {},
        };
      const body = buildRestorePayload(
        source,
        headVersionRef.current,
        restoredVersion,
      );
      const result = await api.commitScene(slug, body);
      setBanner(
        `Restored v${restoredVersion} as new v${result.version}. Opening head…`,
      );
      // Navigate to live head so the user can continue editing.
      onNavigate(headEditorPath(slug));
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      setBanner(
        err instanceof Error
          ? err.message
          : "Restore failed.",
      );
    } finally {
      setRestoreBusy(false);
    }
  }

  // ----- render -------------------------------------------------------------

  if (load.kind === "loading") {
    return (
      <div className="editor-state" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>Loading scene…</p>
      </div>
    );
  }

  if (load.kind === "error") {
    return (
      <div className="editor-state editor-state-error" role="alert">
        <p>{load.message}</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => guardedNavigate("/")}
        >
          Back to scenes
        </button>
      </div>
    );
  }

  const indicatorText = readOnly ? "" : saveIndicatorLabel(saveIndicator);

  return (
    <div className="editor-shell">
      <div className="editor-chrome" role="status" aria-live="polite">
        <div className="editor-chrome-left">
          <span className="editor-version">
            {readOnly ? (
              <>
                v{load.viewingVersion}
                <span className="editor-readonly-badge">read-only</span>
                <span className="meta-sep" aria-hidden="true">
                  ·
                </span>
                <span>head v{load.headVersion}</span>
              </>
            ) : (
              <>
                head v{load.headVersion}
                {load.draftStale ? (
                  <span
                    className="editor-stale-badge"
                    title="Draft based on older head"
                  >
                    stale draft
                  </span>
                ) : null}
              </>
            )}
          </span>
          {indicatorText ? (
            <span
              className={
                saveIndicator === "error"
                  ? "editor-save-indicator is-error"
                  : saveIndicator === "saving" || saveIndicator === "dirty"
                    ? "editor-save-indicator is-active"
                    : "editor-save-indicator is-saved"
              }
            >
              {saveIndicator === "saving" ? (
                <span className="editor-save-dot" aria-hidden="true" />
              ) : null}
              {indicatorText}
            </span>
          ) : null}
        </div>
        <div className="editor-chrome-actions">
          {readOnly ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={restoreBusy}
                onClick={() => void handleRestoreFromView()}
              >
                {restoreBusy ? "Restoring…" : "Restore as new version"}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => guardedNavigate(headEditorPath(slug))}
              >
                Back to head
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setCommitError(null);
                setCommitOpen(true);
              }}
            >
              Commit turn
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => guardedNavigate(historyPath(slug))}
          >
            History
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={
            readOnly
              ? "editor-banner editor-banner-readonly"
              : "editor-banner"
          }
          role="status"
        >
          <span>{banner}</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setBanner(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {!readOnly && (saveError || fileError) ? (
        <div className="editor-banner editor-banner-error" role="alert">
          <span>{fileError ?? saveError}</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss"
            onClick={() => {
              setSaveError(null);
              setFileError(null);
            }}
          >
            ×
          </button>
        </div>
      ) : null}

      <div
        className="excalidraw-host"
        data-canvas={
          readOnly
            ? `scene:${slug}:v${load.viewingVersion}`
            : `scene:${slug}`
        }
      >
        <Excalidraw
          key={
            readOnly
              ? `${slug}:v${load.viewingVersion}`
              : `${slug}:head:${load.headVersion}`
          }
          initialData={{
            elements: load.initialData.elements,
            appState: {
              ...load.initialData.appState,
              // Keep name in sync with scene for exports.
              name: load.sceneName,
            },
            files: load.initialData.files,
            scrollToContent: true,
          }}
          viewModeEnabled={readOnly}
          onChange={handleChange}
          excalidrawAPI={(apiHandle) => {
            apiRef.current = apiHandle;
          }}
          UIOptions={{
            canvasActions: {
              // Load from disk is local-only; our persistence is server-side.
              // Disable load/clear in read-only so history cannot be mutated.
              loadScene: !readOnly,
              export: { saveFileToDisk: true },
            },
          }}
        >
          <MainMenu>
            {!readOnly ? <MainMenu.DefaultItems.LoadScene /> : null}
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            {!readOnly ? <MainMenu.DefaultItems.ClearCanvas /> : null}
            <MainMenu.Separator />
            {!readOnly ? (
              <MainMenu.Item
                onSelect={() => {
                  setCommitError(null);
                  setCommitOpen(true);
                }}
              >
                Commit turn…
              </MainMenu.Item>
            ) : (
              <MainMenu.Item
                onSelect={() => {
                  void handleRestoreFromView();
                }}
              >
                Restore as new version…
              </MainMenu.Item>
            )}
            <MainMenu.Item
              onSelect={() => {
                guardedNavigate(historyPath(slug));
              }}
            >
              Version history
            </MainMenu.Item>
            {!readOnly ? (
              /* SEAM #23: advisory turn lock — wire when locking API lands. */
              <MainMenu.Item
                onSelect={() => {
                  claimOrReleaseTurnSeam();
                  setBanner(
                    "Turn claim/release lands with the locking API (#23). This menu item is intentionally a seam.",
                  );
                }}
              >
                Claim / release turn
              </MainMenu.Item>
            ) : null}
            <MainMenu.Separator />
            {!readOnly ? (
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            ) : null}
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </div>

      {commitOpen && !readOnly ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !commitBusy) {
              setCommitOpen(false);
            }
          }}
        >
          <div
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={commitTitleId}
          >
            <div className="modal-header">
              <h2 id={commitTitleId} className="modal-title">
                Commit turn
              </h2>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="Close"
                disabled={commitBusy}
                onClick={() => setCommitOpen(false)}
              >
                ×
              </button>
            </div>
            <form className="modal-form" onSubmit={handleCommit}>
              <p className="modal-lede">
                End your turn with a short message. This creates a new version
                others can pull — drafts stay private until you commit.
              </p>
              <label className="field-label" htmlFor={commitMessageId}>
                Message
              </label>
              <input
                id={commitMessageId}
                className="field-input"
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="e.g. reworked the data path"
                disabled={commitBusy}
                autoFocus
                maxLength={2000}
              />
              {commitError ? (
                <p className="form-error" role="alert">
                  {commitError}
                </p>
              ) : (
                <p className="form-hint">
                  Author is taken from your token. Parent version: v
                  {headVersionRef.current}.
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={commitBusy}
                  onClick={() => setCommitOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={commitBusy}
                >
                  {commitBusy ? "Committing…" : "Commit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
