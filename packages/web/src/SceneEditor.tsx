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
import {
  ApiError,
  type ApiClient,
  type BinaryFilePayload,
  type LockInfo,
} from "./api.ts";
import {
  arrayBufferToDataURL,
  buildCommitPayload,
  buildDraftPayload,
  createDebouncedCoalescer,
  DRAFT_AUTOSAVE_MS,
  filesNeedingUpload,
  formatFileUploadError,
  formatLockBadge,
  getEditorUnsavedFlag,
  hasUnsavedChanges,
  isEditorLockActive,
  postCommitState,
  saveIndicatorLabel,
  selectInitialSource,
  setEditorUnsavedFlag,
  turnMenuLabel,
  turnMenuShouldClaim,
  UNSAVED_LEAVE_MESSAGE,
  validateCommitMessage,
  type EditorLock,
  type EditorSnapshot,
  type SaveIndicator,
} from "./editor-logic.ts";

export type SceneEditorProps = {
  slug: string;
  api: ApiClient;
  onNavigate: (path: string, event?: MouseEvent<HTMLAnchorElement>) => void;
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

export function SceneEditor({
  slug,
  api,
  onNavigate,
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

  /** Advisory turn lock (null = free / expired). */
  const [lock, setLock] = useState<EditorLock>(null);
  const [selfName, setSelfName] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);

  const headVersionRef = useRef(0);
  const uploadedFilesRef = useRef(new Set<string>());
  const latestSnapshotRef = useRef<EditorSnapshot | null>(null);
  const hydratingRef = useRef(true);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const coalescerRef = useRef<ReturnType<
    typeof createDebouncedCoalescer<EditorSnapshot>
  > | null>(null);

  const commitTitleId = useId();
  const commitMessageId = useId();

  // ----- load head + optional draft -----------------------------------------

  useEffect(() => {
    let cancelled = false;
    hydratingRef.current = true;
    setLoad({ kind: "loading" });
    setSaveIndicator("idle");
    setSaveError(null);
    setFileError(null);
    setBanner(null);
    setLock(null);
    uploadedFilesRef.current = new Set();

    void (async () => {
      try {
        const [meta, sceneDoc, draft, who] = await Promise.all([
          api.getSceneMeta(slug),
          api.getSceneDocument(slug),
          api.getDraft(slug),
          api.whoami().catch(() => null),
        ]);
        if (cancelled) return;

        if (who) setSelfName(who.name);
        setLock(
          meta.lock && isEditorLockActive(meta.lock) ? meta.lock : null,
        );

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

        headVersionRef.current = meta.headVersion;

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

        setLoad({
          kind: "ready",
          initialData: {
            elements,
            appState,
            files,
          },
          headVersion: meta.headVersion,
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
  }, [api, slug]);

  // ----- debounced draft saver ----------------------------------------------

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
  }, [persistDraft]);

  // ----- unsaved-changes guard ----------------------------------------------

  useEffect(() => {
    setEditorUnsavedFlag(hasUnsavedChanges(saveIndicator));
    return () => setEditorUnsavedFlag(false);
  }, [saveIndicator]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges(saveIndicator) || getEditorUnsavedFlag()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveIndicator]);

  const guardedNavigate = useCallback(
    (path: string, event?: MouseEvent<HTMLAnchorElement>) => {
      if (hasUnsavedChanges(saveIndicator)) {
        const ok = window.confirm(UNSAVED_LEAVE_MESSAGE);
        if (!ok) {
          event?.preventDefault();
          return;
        }
        setEditorUnsavedFlag(false);
      }
      onNavigate(path, event);
    },
    [onNavigate, saveIndicator],
  );

  // ----- onChange -----------------------------------------------------------

  const handleChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      const snapshot = snapshotFromEditor(elements, appState, files);
      latestSnapshotRef.current = snapshot;

      // First onChange after mount is hydration — establish baseline only.
      if (hydratingRef.current) {
        hydratingRef.current = false;
        return;
      }

      coalescerRef.current?.push(snapshot);
    },
    [],
  );

  // ----- commit -------------------------------------------------------------

  async function handleCommit(event: FormEvent) {
    event.preventDefault();
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
      // Successful push by the lock holder auto-releases server-side.
      if (selfName && lock && lock.holder === selfName) {
        setLock(null);
      } else {
        // Refresh meta so we notice holder release / expiry after our push.
        try {
          const meta = await api.getSceneMeta(slug);
          setLock(
            meta.lock && isEditorLockActive(meta.lock) ? meta.lock : null,
          );
        } catch {
          // non-fatal
        }
      }
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

  // ----- advisory turn lock -------------------------------------------------

  async function handleClaimOrReleaseTurn() {
    if (lockBusy) return;
    setLockBusy(true);
    try {
      if (turnMenuShouldClaim(lock)) {
        const claimed = await api.claimLock(slug);
        setLock(claimed);
        setBanner(`You hold the turn as ${claimed.holder}.`);
      } else {
        await api.releaseLock(slug);
        setLock(null);
        setBanner("Turn released.");
      }
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      if (err instanceof ApiError && err.code === "LOCK_HELD") {
        const details = err.details as LockInfo | undefined;
        if (details?.holder) {
          setLock({
            holder: details.holder,
            expiresAt: details.expiresAt ?? "",
          });
          setBanner(
            `${details.holder} already holds the turn` +
              (details.expiresAt ? ` until ${details.expiresAt}` : "") +
              ". You can still draw and commit — locks are advisory.",
          );
        } else {
          setBanner(err.message);
        }
        return;
      }
      setBanner(
        err instanceof Error ? err.message : "Could not update turn lock.",
      );
    } finally {
      setLockBusy(false);
    }
  }

  async function handleReleaseFromBadge() {
    if (lockBusy) return;
    setLockBusy(true);
    try {
      await api.releaseLock(slug);
      setLock(null);
      setBanner("Turn released.");
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      setBanner(
        err instanceof Error ? err.message : "Could not release turn.",
      );
    } finally {
      setLockBusy(false);
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

  const indicatorText = saveIndicatorLabel(saveIndicator);
  const lockActive = isEditorLockActive(lock);
  const menuTurnLabel = turnMenuLabel(lock, selfName);

  return (
    <div className="editor-shell">
      <div className="editor-chrome" role="status" aria-live="polite">
        <div className="editor-chrome-left">
          <span className="editor-version">
            head v{load.headVersion}
            {load.draftStale ? (
              <span className="editor-stale-badge" title="Draft based on older head">
                stale draft
              </span>
            ) : null}
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
          {lockActive && lock ? (
            <span
              className="editor-lock-badge"
              title={
                lock.expiresAt
                  ? `Expires ${lock.expiresAt}`
                  : "Advisory turn lock"
              }
            >
              <span className="editor-lock-badge-text">
                {formatLockBadge(lock)}
              </span>
              <button
                type="button"
                className="editor-lock-release"
                disabled={lockBusy}
                onClick={() => void handleReleaseFromBadge()}
              >
                Release
              </button>
            </span>
          ) : null}
        </div>
        <div className="editor-chrome-actions">
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() =>
              guardedNavigate(`/s/${encodeURIComponent(slug)}/history`)
            }
          >
            History
          </button>
        </div>
      </div>

      {banner ? (
        <div className="editor-banner" role="status">
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

      {saveError || fileError ? (
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

      <div className="excalidraw-host" data-canvas={`scene:${slug}`}>
        <Excalidraw
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
          onChange={handleChange}
          excalidrawAPI={(apiHandle) => {
            apiRef.current = apiHandle;
          }}
          UIOptions={{
            canvasActions: {
              // Load from disk is local-only; our persistence is server-side.
              loadScene: true,
              export: { saveFileToDisk: true },
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.Item
              onSelect={() => {
                setCommitError(null);
                setCommitOpen(true);
              }}
            >
              Commit turn…
            </MainMenu.Item>
            <MainMenu.Item
              onSelect={() => {
                guardedNavigate(`/s/${encodeURIComponent(slug)}/history`);
              }}
            >
              Version history
            </MainMenu.Item>
            <MainMenu.Item
              onSelect={() => {
                void handleClaimOrReleaseTurn();
              }}
            >
              {menuTurnLabel}
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </div>

      {commitOpen ? (
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
