/**
 * Scene editor: load head-or-draft, debounced draft autosave, commit turn,
 * MainMenu items, image upload to the content-addressed file store.
 * Also supports opening a past version read-only (`?v=N`) with restore.
 *
 * What-changed panel + remote-version toast (issue #22): humans review agent
 * turns by scrolling to changed elements; remote loads use CaptureUpdateAction.NEVER
 * so they never land on the human undo stack.
 */

import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  MainMenu,
} from "@excalidraw/excalidraw";
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
  draftFingerprint,
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
  shouldShowLockControls,
  turnMenuLabel,
  turnMenuShouldClaim,
  UNSAVED_LEAVE_MESSAGE,
  validateCommitMessage,
  type EditorLock,
  type EditorSnapshot,
  type SaveIndicator,
} from "./editor-logic.ts";
import {
  buildRestorePayload,
  formatChangeCounts,
  headEditorPath,
  historyPath,
  isReadOnlyVersion,
  opBadge,
} from "./history-logic.ts";
import {
  buildRemoteSceneUpdate,
  buildWhatChangedModel,
  canReopenPanel,
  findScrollTarget,
  formatRemoteToastMessage,
  formatWhatChangedTitle,
  getLastSeenVersion,
  initialPollState,
  isPanelVisible,
  markSceneSeen,
  panelAfterRemoteLoad,
  panelBeginLoad,
  panelDismiss,
  panelLoadFailed,
  panelLoadSucceeded,
  panelReopen,
  pollAdvanceSince,
  pollBeginWait,
  pollNextDelayMs,
  pollOnError,
  pollOnEvent,
  pollOnTimeout,
  pollStop,
  REMOTE_CAPTURE_UPDATE,
  remoteUpdateSkipsUndoHistory,
  shouldShowWhatChangedOnOpen,
  toastApplyFailed,
  toastApplySucceeded,
  toastBeginApply,
  toastDismiss,
  toastFromSceneEvent,
  toastShow,
  type WhatChangedPanelState,
  type ToastState,
} from "./what-changed-logic.ts";
import {
  attachThumbnailForCommit,
  buildThumbnailExportAppState,
  shouldGenerateThumbnail,
  THUMBNAIL_EXPORT,
  thumbnailFileIdForCommit,
  withThumbnailFileId,
} from "./thumbnail-logic.ts";
import { filterExportElements } from "./render-logic.ts";

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

  /** Advisory turn lock (null = free / expired). */
  const [lock, setLock] = useState<EditorLock>(null);
  const [selfName, setSelfName] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);

  /** What-changed review panel (last-seen → head). */
  const [whatChanged, setWhatChanged] = useState<WhatChangedPanelState>({
    kind: "hidden",
  });
  /** Toast when head advances while the tab is open. */
  const [remoteToast, setRemoteToast] = useState<ToastState>({
    kind: "hidden",
  });
  /** Live head shown in chrome (updated on commit / remote Load without remount). */
  const [chromeHeadVersion, setChromeHeadVersion] = useState(0);

  const headVersionRef = useRef(0);
  /** Long-poll cursor — advanced on commit and remote Load so we don't re-toast ourselves. */
  const pollSinceRef = useRef(0);
  const uploadedFilesRef = useRef(new Set<string>());
  const latestSnapshotRef = useRef<EditorSnapshot | null>(null);
  const hydratingRef = useRef(true);
  /** Fingerprint of the last snapshot queued for save — suppresses no-op PUTs. */
  const savedFingerprintRef = useRef<string | null>(null);
  /** Skip one onChange after remote updateScene so draft autosave does not fire. */
  const applyingRemoteRef = useRef(false);
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
  const selfNameRef = useRef<string | null>(null);

  const commitTitleId = useId();
  const commitMessageId = useId();
  const whatChangedTitleId = useId();

  // ----- load: meta+whoami in parallel; version-aware body; no draft in RO ---

  useEffect(() => {
    let cancelled = false;
    hydratingRef.current = true;
    setLoad({ kind: "loading" });
    setSaveIndicator("idle");
    setSaveError(null);
    setFileError(null);
    setBanner(null);
    setCommitOpen(false);
    setLock(null);
    setWhatChanged({ kind: "hidden" });
    setRemoteToast({ kind: "hidden" });
    setChromeHeadVersion(0);
    uploadedFilesRef.current = new Set();
    loadedDocRef.current = null;
    applyingRemoteRef.current = false;
    savedFingerprintRef.current = null;

    void (async () => {
      try {
        // Identity + scene meta always; needed before we know read-only vs live.
        const [meta, who] = await Promise.all([
          api.getSceneMeta(slug),
          api.whoami().catch(() => null),
        ]);
        if (cancelled) return;

        if (who) {
          setSelfName(who.name);
          selfNameRef.current = who.name;
        } else {
          selfNameRef.current = null;
        }
        setLock(
          meta.lock && isEditorLockActive(meta.lock) ? meta.lock : null,
        );
        headVersionRef.current = meta.headVersion;
        pollSinceRef.current = meta.headVersion;
        setChromeHeadVersion(meta.headVersion);

        const wantVersion = version ?? null;
        const readOnly = isReadOnlyVersion(wantVersion, meta.headVersion);

        // Past version: load exactly that revision, skip draft (and writes).
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

        // Live editor: head (or matching version) + optional draft in parallel.
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

        const viewingVersion = meta.headVersion > 0 ? meta.headVersion : 0;

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

        // What-changed panel: last-seen → head (dismissible; first visit is silent).
        const lastSeen = getLastSeenVersion(window.localStorage, slug);
        if (shouldShowWhatChangedOnOpen(lastSeen, meta.headVersion)) {
          const from = lastSeen as number;
          const to = meta.headVersion;
          setWhatChanged(panelBeginLoad(from, to));
          try {
            const diff = await api.getDiff(slug, from, to);
            if (cancelled) return;
            const model = buildWhatChangedModel(diff, { from, to });
            if (model.view.isEmpty) {
              setWhatChanged({ kind: "hidden" });
              markSceneSeen(window.localStorage, slug, meta.headVersion);
            } else {
              setWhatChanged(panelLoadSucceeded(model));
            }
          } catch (err) {
            if (cancelled) return;
            if (err instanceof ApiError && err.isUnauthorized) return;
            setWhatChanged(
              panelLoadFailed(
                { from, to },
                err instanceof Error ? err.message : "Could not load changes.",
              ),
            );
          }
        } else {
          // First visit or already current — record head so future visits diff.
          markSceneSeen(window.localStorage, slug, meta.headVersion);
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
  // Hide (not disable) claim/release in read-only: viewing history is not a turn.
  const showLockControls = shouldShowLockControls(readOnly);

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
      const fingerprint = draftFingerprint(snapshot);

      // First onChange after mount is hydration — establish baseline only.
      if (hydratingRef.current) {
        hydratingRef.current = false;
        savedFingerprintRef.current = fingerprint;
        return;
      }

      // Remote Load/Merge applied via updateScene(NEVER) — do not draft-save
      // that as a local dirty burst (it is already on the server as head).
      if (applyingRemoteRef.current) {
        applyingRemoteRef.current = false;
        savedFingerprintRef.current = fingerprint;
        return;
      }

      // Nothing the draft persists actually moved. Excalidraw emits onChange
      // for re-renders and selection/pointer churn too, and a save flips the
      // save indicator — so pushing these would let autosave feed itself.
      if (fingerprint === savedFingerprintRef.current) {
        return;
      }
      savedFingerprintRef.current = fingerprint;

      coalescerRef.current?.push(snapshot);
    },
    [load],
  );

  // ----- long-poll for remote commits while the tab is open -----------------

  useEffect(() => {
    if (readOnly || load.kind !== "ready") return;

    let cancelled = false;
    const ac = new AbortController();
    let poll = initialPollState(pollSinceRef.current);

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = window.setTimeout(() => resolve(), ms);
        ac.signal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });

    void (async () => {
      while (!cancelled && !ac.signal.aborted) {
        // Keep the pure state machine's since in sync with commits / Load.
        poll = pollAdvanceSince(poll, pollSinceRef.current);

        const delay = pollNextDelayMs(poll);
        if (delay === Number.POSITIVE_INFINITY) break;
        if (delay > 0) {
          await sleep(delay);
          if (cancelled || ac.signal.aborted) break;
        }

        poll = pollBeginWait(poll);
        try {
          const event = await api.getSceneEvents(slug, pollSinceRef.current, {
            signal: ac.signal,
          });
          if (cancelled || ac.signal.aborted) break;

          if (!event) {
            poll = pollOnTimeout(poll);
            continue;
          }

          const from = pollSinceRef.current;
          const to =
            typeof event.headVersion === "number"
              ? event.headVersion
              : event.version;

          if (!Number.isInteger(to) || to <= from) {
            poll = pollOnTimeout(poll);
            continue;
          }

          poll = pollOnEvent(poll, to);
          // Advance the poll cursor so we do not re-deliver the same event.
          // Do NOT touch headVersionRef here — that is the local commit parent
          // and only moves on our own commit or an explicit Load/Merge.
          pollSinceRef.current = to;

          // Suppress toast for our own commits (we already advanced after push).
          const self = selfNameRef.current;
          if (self && event.author === self) {
            // Our commit already updated headVersionRef / chrome; just mark seen.
            markSceneSeen(window.localStorage, slug, to);
            continue;
          }

          setRemoteToast((s) =>
            toastShow(s, toastFromSceneEvent(from, event)),
          );
        } catch (err) {
          if (cancelled || ac.signal.aborted) break;
          if (err instanceof Error && err.name === "AbortError") break;
          if (err instanceof ApiError && err.isUnauthorized) break;
          poll = pollOnError(poll);
        }
      }
      poll = pollStop(poll);
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [api, slug, readOnly, load.kind]);

  // ----- scroll-to-element from what-changed panel --------------------------

  function handleScrollToChange(elementId: string) {
    const apiHandle = apiRef.current;
    if (!apiHandle) return;
    const elements = apiHandle.getSceneElementsIncludingDeleted();
    const target = findScrollTarget(elements, elementId);
    if (!target) return;
    // Public upstream API — fly the viewport to the changed element.
    apiHandle.scrollToContent(target as OrderedExcalidrawElement, {
      fitToViewport: true,
    });
  }

  /**
   * Apply a remote scene document without putting it on the undo stack.
   * Tripwire: buildRemoteSceneUpdate always sets captureUpdate NEVER; we also
   * pass CaptureUpdateAction.NEVER explicitly so a refactors cannot silently
   * drop it.
   */
  async function applyRemoteDocument(opts: {
    fromVersion: number;
    toVersion: number;
    /** When true, open the what-changed panel for from→to after apply. */
    showDiff: boolean;
  }): Promise<void> {
    const sceneDoc = await api.getSceneDocument(slug, opts.toVersion);
    const apiHandle = apiRef.current;
    if (!apiHandle) {
      throw new Error("Editor is not ready yet.");
    }

    const elements =
      (sceneDoc.elements as readonly OrderedExcalidrawElement[]) ?? [];
    const appState = (sceneDoc.appState ?? {}) as Record<string, unknown>;
    const files = toBinaryFiles(
      sceneDoc.files as Record<string, BinaryFilePayload> | undefined,
    );

    const remotePayload = buildRemoteSceneUpdate({
      elements,
      appState: {
        ...appState,
        name:
          load.kind === "ready" ? load.sceneName : (appState.name as string),
      },
    });
    // Acceptance tripwire: remote must never enter undo history.
    if (
      !remoteUpdateSkipsUndoHistory(remotePayload) ||
      remotePayload.captureUpdate !== CaptureUpdateAction.NEVER ||
      REMOTE_CAPTURE_UPDATE !== CaptureUpdateAction.NEVER
    ) {
      throw new Error(
        "Internal error: remote load would capture undo history.",
      );
    }

    applyingRemoteRef.current = true;
    // captureUpdate MUST be NEVER — remote content must not enter undo history.
    // appState is a whitelist subset from the server; cast through unknown for TS.
    apiHandle.updateScene({
      elements: remotePayload.elements as OrderedExcalidrawElement[],
      appState: remotePayload.appState as unknown as AppState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    const fileList = Object.values(files).filter(Boolean) as BinaryFiles[string][];
    if (fileList.length > 0) {
      apiHandle.addFiles(fileList);
    }
    for (const id of Object.keys(files)) {
      uploadedFilesRef.current.add(id);
    }

    headVersionRef.current = opts.toVersion;
    pollSinceRef.current = opts.toVersion;
    setChromeHeadVersion(opts.toVersion);
    setLoad((prev) =>
      prev.kind === "ready"
        ? {
            ...prev,
            headVersion: opts.toVersion,
            viewingVersion: opts.toVersion,
            draftStale: false,
          }
        : prev,
    );
    markSceneSeen(window.localStorage, slug, opts.toVersion);
    setBanner(null);

    // Baseline snapshot so subsequent edits draft against the loaded head.
    latestSnapshotRef.current = snapshotFromEditor(
      elements,
      apiHandle.getAppState(),
      apiHandle.getFiles(),
    );

    if (opts.showDiff && opts.fromVersion < opts.toVersion) {
      try {
        const diff = await api.getDiff(slug, opts.fromVersion, opts.toVersion);
        const model = buildWhatChangedModel(diff, {
          from: opts.fromVersion,
          to: opts.toVersion,
        });
        setWhatChanged(panelAfterRemoteLoad(model));
      } catch {
        // Non-fatal: scene is loaded even if the review panel fails.
      }
    }
  }

  async function handleRemoteLoad() {
    if (remoteToast.kind !== "visible" && remoteToast.kind !== "error") return;
    const toast = remoteToast.toast;
    setRemoteToast((s) => toastBeginApply(s, "load"));
    try {
      await applyRemoteDocument({
        fromVersion: toast.fromVersion,
        toVersion: toast.toVersion,
        showDiff: true,
      });
      // Clear local draft — head is now the source of truth we just loaded.
      try {
        await api.deleteDraft(slug);
      } catch {
        // non-fatal
      }
      setSaveIndicator("idle");
      setRemoteToast((s) => toastApplySucceeded(s));
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      setRemoteToast((s) =>
        toastApplyFailed(
          s,
          err instanceof Error ? err.message : "Could not load remote version.",
        ),
      );
    }
  }

  /**
   * Merge into mine: POST /scene?merge=true with the local working copy.
   * Server reconciles via upstream reconcileElements; never a client-side merge.
   */
  async function handleRemoteMerge() {
    if (remoteToast.kind !== "visible" && remoteToast.kind !== "error") return;
    const toast = remoteToast.toast;
    setRemoteToast((s) => toastBeginApply(s, "merge"));

    let snapshot = latestSnapshotRef.current;
    const apiHandle = apiRef.current;
    if (apiHandle) {
      snapshot = snapshotFromEditor(
        apiHandle.getSceneElementsIncludingDeleted(),
        apiHandle.getAppState(),
        apiHandle.getFiles(),
      );
      latestSnapshotRef.current = snapshot;
    }
    if (!snapshot) {
      setRemoteToast((s) =>
        toastApplyFailed(s, "Nothing local to merge yet."),
      );
      return;
    }

    try {
      // Upload any new local binaries first so merge fileIds resolve.
      const need = filesNeedingUpload(snapshot.files, uploadedFilesRef.current);
      for (const file of need) {
        await api.uploadFile(file);
        uploadedFilesRef.current.add(file.id);
      }

      // parentVersion is the version we were on when remote advanced — the
      // local working copy's base. Server merges local with current head.
      const body = buildCommitPayload(
        snapshot,
        toast.fromVersion,
        `merge with v${toast.toVersion}`,
        { includeFiles: true },
      );

      const result = await api.mergeScene(slug, body);

      await applyRemoteDocument({
        fromVersion: toast.fromVersion,
        toVersion: result.headVersion,
        showDiff: true,
      });
      try {
        await api.deleteDraft(slug);
      } catch {
        // non-fatal
      }
      setSaveIndicator("idle");
      setRemoteToast((s) => toastApplySucceeded(s));
      setBanner(
        `Merged as v${result.version}. Local strokes were reconciled with remote head.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      const message =
        err instanceof ApiError
          ? err.message ||
            (err.status === 501
              ? "Server-side merge requires RENDER_WORKER=on on the server."
              : err.message)
          : err instanceof Error
            ? err.message
            : "Merge failed.";
      setRemoteToast((s) => toastApplyFailed(s, message));
    }
  }

  function handleDismissWhatChanged() {
    setWhatChanged((s) => {
      const next = panelDismiss(s);
      // Dismissing marks head as seen so the panel does not re-ambush on reload,
      // but the model is retained for the "What changed" re-open control.
      if (s.kind === "ready") {
        markSceneSeen(
          window.localStorage,
          slug,
          s.model.range.to,
        );
      } else if (s.kind === "loading" || s.kind === "error") {
        markSceneSeen(window.localStorage, slug, headVersionRef.current);
      }
      return next;
    });
  }

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

      // Client-side thumbnail: browser exportToBlob → content-addressed store.
      // Soft-fails so a commit never blocks on preview generation (issue #30).
      const thumbResult = await attachThumbnailForCommit({
        shouldGenerate: shouldGenerateThumbnail(snapshot.elements),
        exportPng: async () => {
          const elements = filterExportElements(
            snapshot.elements,
          ) as Parameters<typeof exportToBlob>[0]["elements"];
          const appState = buildThumbnailExportAppState(
            snapshot.appState as Record<string, unknown> | undefined,
          ) as Parameters<typeof exportToBlob>[0]["appState"];
          const files = Object.fromEntries(
            Object.entries(snapshot.files).filter(
              (entry): entry is [string, BinaryFilePayload] =>
                entry[1] != null && typeof entry[1].dataURL === "string",
            ),
          ) as Parameters<typeof exportToBlob>[0]["files"];
          if (typeof document !== "undefined" && document.fonts?.ready) {
            await document.fonts.ready;
          }
          return exportToBlob({
            elements,
            appState,
            files,
            exportPadding: THUMBNAIL_EXPORT.padding,
            mimeType: THUMBNAIL_EXPORT.mimeType,
          });
        },
        uploadPng: async (bytes) => {
          const uploaded = await api.uploadRawFile(bytes, "image/png");
          return { fileId: uploaded.fileId };
        },
      });

      // Include files so the version's file_ids list is complete; server
      // content-addresses them (dedup if already uploaded). Binaries never
      // live in elements — only fileId references.
      const body = withThumbnailFileId(
        buildCommitPayload(
          snapshot,
          headVersionRef.current,
          validated.message,
          { includeFiles: true },
        ),
        thumbnailFileIdForCommit(thumbResult),
      );

      const result = await api.commitScene(slug, body);
      // Server clears draft inside the same transaction; local DELETE is belt.
      await api.deleteDraft(slug);

      const next = postCommitState(result.headVersion);
      headVersionRef.current = next.headVersion;
      // Advance poll cursor before the events hub notifies us of our own push.
      pollSinceRef.current = next.headVersion;
      setChromeHeadVersion(next.headVersion);
      markSceneSeen(window.localStorage, slug, next.headVersion);
      setSaveIndicator(next.saveIndicator);
      setSaveError(null);
      setBanner(null);
      setCommitOpen(false);
      setCommitMessage("");
      setLoad((prev) =>
        prev.kind === "ready"
          ? {
              ...prev,
              headVersion: next.headVersion,
              viewingVersion: next.headVersion,
              draftStale: false,
            }
          : prev,
      );
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
    // Defence in depth: read-only must never claim (controls are also hidden).
    if (readOnly || lockBusy) return;
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
    if (readOnly || lockBusy) return;
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
  const lockActive = isEditorLockActive(lock);
  const menuTurnLabel = turnMenuLabel(lock, selfName);
  // Local base version (commit parent). Remote advances surface via the toast,
  // not by rewriting this number — that would desync parentVersion from content.
  const displayHead =
    chromeHeadVersion > 0 ? chromeHeadVersion : load.headVersion;
  const panelVisible = isPanelVisible(whatChanged);
  const reopenWhatChanged = canReopenPanel(whatChanged);
  const toastBusy = remoteToast.kind === "applying";

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
                <span>head v{displayHead}</span>
              </>
            ) : (
              <>
                head v{displayHead}
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
          {showLockControls && lockActive && lock ? (
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
          {!readOnly && reopenWhatChanged ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setWhatChanged((s) => panelReopen(s))}
              title="Re-open the review panel for changes since your last visit"
            >
              What changed
            </button>
          ) : null}
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

      {/* Remote version toast — Load uses updateScene(CaptureUpdateAction.NEVER). */}
      {!readOnly && remoteToast.kind !== "hidden" ? (
        <div
          className={
            remoteToast.kind === "error"
              ? "remote-toast remote-toast-error"
              : "remote-toast"
          }
          role="status"
          aria-live="polite"
        >
          <div className="remote-toast-body">
            <p className="remote-toast-message">
              {formatRemoteToastMessage(remoteToast.toast)}
            </p>
            {remoteToast.kind === "error" ? (
              <p className="remote-toast-error-text" role="alert">
                {remoteToast.message}
              </p>
            ) : (
              <p className="remote-toast-hint">
                Load replaces the canvas with remote head (kept off your undo
                stack). Merge keeps your strokes and reconciles server-side.
              </p>
            )}
          </div>
          <div className="remote-toast-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={toastBusy}
              onClick={() => void handleRemoteLoad()}
            >
              {toastBusy &&
              remoteToast.kind === "applying" &&
              remoteToast.action === "load"
                ? "Loading…"
                : "Load"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={toastBusy}
              onClick={() => void handleRemoteMerge()}
              title="POST /scene?merge=true — server-side reconcile (issue #29)"
            >
              {toastBusy &&
              remoteToast.kind === "applying" &&
              remoteToast.action === "merge"
                ? "Merging…"
                : "Merge into mine"}
            </button>
            <button
              type="button"
              className="btn btn-icon remote-toast-dismiss"
              aria-label="Dismiss"
              disabled={toastBusy}
              onClick={() => setRemoteToast((s) => toastDismiss(s))}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      {/* What-changed review panel — dismissible; re-open from chrome. */}
      {!readOnly && whatChanged.kind === "loading" ? (
        <aside
          className="what-changed-panel"
          aria-labelledby={whatChangedTitleId}
          aria-busy="true"
        >
          <div className="what-changed-header">
            <h2 id={whatChangedTitleId} className="what-changed-title">
              What changed
            </h2>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Dismiss"
              onClick={handleDismissWhatChanged}
            >
              ×
            </button>
          </div>
          <div className="what-changed-state" role="status">
            <div className="spinner" aria-hidden="true" />
            <p>
              Loading changes v{whatChanged.range.from} → v
              {whatChanged.range.to}…
            </p>
          </div>
        </aside>
      ) : null}

      {!readOnly && whatChanged.kind === "error" ? (
        <aside
          className="what-changed-panel"
          aria-labelledby={whatChangedTitleId}
          role="alert"
        >
          <div className="what-changed-header">
            <h2 id={whatChangedTitleId} className="what-changed-title">
              What changed
            </h2>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Dismiss"
              onClick={handleDismissWhatChanged}
            >
              ×
            </button>
          </div>
          <div className="what-changed-state what-changed-state-error">
            <p>{whatChanged.message}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const { from, to } = whatChanged.range;
                setWhatChanged(panelBeginLoad(from, to));
                void (async () => {
                  try {
                    const diff = await api.getDiff(slug, from, to);
                    const model = buildWhatChangedModel(diff, { from, to });
                    setWhatChanged(panelLoadSucceeded(model));
                  } catch (err) {
                    setWhatChanged(
                      panelLoadFailed(
                        { from, to },
                        err instanceof Error
                          ? err.message
                          : "Could not load changes.",
                      ),
                    );
                  }
                })();
              }}
            >
              Retry
            </button>
          </div>
        </aside>
      ) : null}

      {!readOnly && panelVisible && whatChanged.kind === "ready" ? (
        <aside
          className="what-changed-panel"
          aria-labelledby={whatChangedTitleId}
        >
          <div className="what-changed-header">
            <div className="what-changed-header-text">
              <h2 id={whatChangedTitleId} className="what-changed-title">
                {formatWhatChangedTitle(whatChanged.model.range)}
              </h2>
              <p className="what-changed-subtitle">
                <span className="what-changed-counts">
                  {formatChangeCounts(whatChanged.model.view.summary)}
                </span>
                {" · "}
                click a row to scroll
              </p>
            </div>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Dismiss what changed panel"
              onClick={handleDismissWhatChanged}
            >
              ×
            </button>
          </div>
          <p className="what-changed-lede">
            Click a change to fly to it. Deleted items are listed but not
            navigable — there is nothing left on the canvas.
          </p>
          <ul className="what-changed-list">
            {whatChanged.model.reviewItems.map((item) => {
              const badge = opBadge(item.change.op);
              const key = `${item.change.op}:${item.change.id}`;
              if (item.navigable) {
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`what-changed-item is-navigable ${badge.className}`}
                      onClick={() => handleScrollToChange(item.change.id)}
                      title={`Scroll to ${item.headline}`}
                    >
                      <span className="diff-item-op" aria-hidden="true">
                        {badge.symbol}
                      </span>
                      <span className="diff-item-body">
                        <span className="diff-item-headline">
                          {item.headline}
                        </span>
                        {item.detail ? (
                          <span className="diff-item-detail">{item.detail}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={key}>
                  <div
                    className={`what-changed-item is-deleted ${badge.className}`}
                    title="Deleted — not navigable"
                    aria-label={`${item.headline} (deleted, not navigable)`}
                  >
                    <span className="diff-item-op" aria-hidden="true">
                      {badge.symbol}
                    </span>
                    <span className="diff-item-body">
                      <span className="diff-item-headline">
                        {item.headline}
                        <span className="what-changed-deleted-tag">
                          deleted
                        </span>
                      </span>
                      {item.detail ? (
                        <span className="diff-item-detail">{item.detail}</span>
                      ) : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {whatChanged.model.view.appStateCount > 0 ? (
            <p className="what-changed-appstate-note">
              +{whatChanged.model.view.appStateCount} canvas setting
              {whatChanged.model.view.appStateCount === 1 ? "" : "s"} changed
              (not navigable).
            </p>
          ) : null}
        </aside>
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
              // Stable live key: remote Load must not remount (would wipe undo).
              : `${slug}:live`
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
            {/* Hide (not disable) claim/release in read-only — past version ≠ turn. */}
            {showLockControls ? (
              <MainMenu.Item
                onSelect={() => {
                  void handleClaimOrReleaseTurn();
                }}
              >
                {menuTurnLabel}
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
