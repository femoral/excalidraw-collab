import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { ApiError, type ApiClient, type SceneInfo } from "./api.ts";
import {
  buildCreatePayload,
  buildRenamePayload,
  formatUpdatedAt,
  headAuthorLabel,
  isLockActive,
  reduceSceneList,
  versionCount,
  type SceneListStatus,
} from "./scenes-logic.ts";

export type SceneListProps = {
  api: ApiClient;
  onNavigate: (path: string, event?: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Fired when the list learns the session is no longer valid. Parent already
   * clears the token via the API client's onUnauthorized; this is a belt-and-
   * suspenders hook for extra UI cleanup if needed.
   */
  onUnauthorized?: () => void;
};

/**
 * Scene home: list, create, rename, delete. Thumbnail slot is reserved for
 * wave 5 (#30) with a neutral placeholder matching final card dimensions.
 */
export function SceneList({
  api,
  onNavigate,
  onUnauthorized,
}: SceneListProps): ReactElement {
  const [list, setList] = useState<SceneListStatus>({ kind: "loading" });
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const [renaming, setRenaming] = useState<SceneInfo | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const [deleting, setDeleting] = useState<SceneInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList((s) => reduceSceneList(s, { type: "load_start" }));
    setActionError(null);
    try {
      const scenes = await api.listScenes();
      setList(reduceSceneList({ kind: "idle" }, { type: "load_success", scenes }));
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        setList(reduceSceneList({ kind: "idle" }, { type: "unauthorized" }));
        onUnauthorized?.();
        return;
      }
      const message =
        err instanceof Error ? err.message : "Failed to load scenes.";
      setList(
        reduceSceneList({ kind: "idle" }, { type: "load_error", message }),
      );
    }
  }, [api, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const payload = buildCreatePayload(createName, createSlug);
    if (!payload.ok) {
      setCreateError(payload.error);
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await api.createScene(payload.body);
      setList((s) => reduceSceneList(s, { type: "upsert", scene: created }));
      setCreateOpen(false);
      setCreateName("");
      setCreateSlug("");
      onNavigate(`/s/${encodeURIComponent(created.slug)}`);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        setList((s) => reduceSceneList(s, { type: "unauthorized" }));
        onUnauthorized?.();
        return;
      }
      setCreateError(
        err instanceof Error ? err.message : "Could not create scene.",
      );
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const payload = buildRenamePayload(renameName);
    if (!payload.ok) {
      setRenameError(payload.error);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      const updated = await api.renameScene(renaming.slug, payload.name);
      setList((s) => reduceSceneList(s, { type: "upsert", scene: updated }));
      setRenaming(null);
      setRenameName("");
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        setList((s) => reduceSceneList(s, { type: "unauthorized" }));
        onUnauthorized?.();
        return;
      }
      setRenameError(
        err instanceof Error ? err.message : "Could not rename scene.",
      );
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await api.deleteScene(deleting.slug);
      setList((s) =>
        reduceSceneList(s, { type: "remove", slug: deleting.slug }),
      );
      setDeleting(null);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        setList((s) => reduceSceneList(s, { type: "unauthorized" }));
        onUnauthorized?.();
        return;
      }
      setActionError(
        err instanceof Error ? err.message : "Could not delete scene.",
      );
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="scene-list-page">
      <div className="scene-list-header">
        <div>
          <h2 className="scene-list-title">Scenes</h2>
          <p className="scene-list-lede">
            Open a board, start a new one, or clean up what you no longer need.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setCreateOpen(true);
            setCreateError(null);
          }}
        >
          New scene
        </button>
      </div>

      {actionError ? (
        <div className="banner banner-error" role="alert">
          {actionError}
          <button
            type="button"
            className="banner-dismiss"
            onClick={() => setActionError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}

      {list.kind === "loading" ? (
        <div className="scene-list-state" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Loading scenes…</p>
        </div>
      ) : null}

      {list.kind === "error" ? (
        <div className="scene-list-state scene-list-state-error" role="alert">
          <p>{list.message}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {list.kind === "ready" && list.scenes.length === 0 ? (
        <div className="scene-list-empty">
          <div className="empty-illustration" aria-hidden="true">
            <span className="empty-grid" />
          </div>
          <h3>No scenes yet</h3>
          <p>
            Create a scene to start drawing. Agents and humans share the same
            boards with turn-based commits.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            Create your first scene
          </button>
        </div>
      ) : null}

      {list.kind === "ready" && list.scenes.length > 0 ? (
        <ul className="scene-grid">
          {list.scenes.map((item) => (
            <li key={item.id}>
              <SceneCard
                scene={item}
                onOpen={(e) =>
                  onNavigate(`/s/${encodeURIComponent(item.slug)}`, e)
                }
                onRename={() => {
                  setRenaming(item);
                  setRenameName(item.name);
                  setRenameError(null);
                }}
                onDelete={() => setDeleting(item)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {createOpen ? (
        <Modal
          title="New scene"
          onClose={() => !createBusy && setCreateOpen(false)}
        >
          <form onSubmit={handleCreate} className="modal-form">
            <label className="field-label" htmlFor="create-name">
              Name
            </label>
            <input
              id="create-name"
              className="field-input"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              disabled={createBusy}
              autoFocus
              required
              maxLength={256}
              placeholder="Architecture diagram"
            />
            <label className="field-label" htmlFor="create-slug">
              Slug <span className="field-optional">(optional)</span>
            </label>
            <input
              id="create-slug"
              className="field-input"
              value={createSlug}
              onChange={(e) => setCreateSlug(e.target.value)}
              disabled={createBusy}
              maxLength={64}
              placeholder="auto-derived from name"
              spellCheck={false}
              autoComplete="off"
            />
            {createError ? (
              <p className="form-error" role="alert">
                {createError}
              </p>
            ) : (
              <p className="form-hint">
                Leave slug blank to generate one. Slugs stay fixed after create.
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={createBusy}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={createBusy}
              >
                {createBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {renaming ? (
        <Modal
          title="Rename scene"
          onClose={() => !renameBusy && setRenaming(null)}
        >
          <form onSubmit={handleRename} className="modal-form">
            <p className="form-hint modal-lede">
              Slug <code>{renaming.slug}</code> stays the same.
            </p>
            <label className="field-label" htmlFor="rename-name">
              Name
            </label>
            <input
              id="rename-name"
              className="field-input"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              disabled={renameBusy}
              autoFocus
              required
              maxLength={256}
            />
            {renameError ? (
              <p className="form-error" role="alert">
                {renameError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={renameBusy}
                onClick={() => setRenaming(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={renameBusy}
              >
                {renameBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title="Delete scene?"
          onClose={() => !deleteBusy && setDeleting(null)}
        >
          <div className="modal-form">
            <p className="modal-lede">
              Soft-delete <strong>{deleting.name}</strong> (
              <code>{deleting.slug}</code>). Version history is retained but
              the scene disappears from the list.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={deleteBusy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleteBusy}
                onClick={() => void handleDeleteConfirm()}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function SceneCard({
  scene,
  onOpen,
  onRename,
  onDelete,
}: {
  scene: SceneInfo;
  onOpen: (event?: MouseEvent<HTMLAnchorElement>) => void;
  onRename: () => void;
  onDelete: () => void;
}): ReactElement {
  const locked = isLockActive(scene.lock);
  const href = `/s/${encodeURIComponent(scene.slug)}`;
  const versions = versionCount(scene);
  const author = headAuthorLabel(scene);
  const updated = formatUpdatedAt(scene.updatedAt);

  return (
    <article className="scene-card">
      <a
        href={href}
        className="scene-card-thumb"
        onClick={(e) => onOpen(e)}
        aria-label={`Open ${scene.name}`}
      >
        {/* Thumbnail slot — populated in wave 5 (#30). Fixed aspect so layout
            does not reflow when real previews arrive. */}
        <div className="scene-thumb-placeholder" aria-hidden="true">
          <span className="scene-thumb-glyph">◇</span>
        </div>
      </a>

      <div className="scene-card-body">
        <div className="scene-card-title-row">
          <h3 className="scene-card-name">
            <a href={href} onClick={(e) => onOpen(e)}>
              {scene.name}
            </a>
          </h3>
          {locked && scene.lock ? (
            <span
              className="lock-badge"
              title={`Turn held by ${scene.lock.holder}`}
            >
              <span className="lock-badge-icon" aria-hidden="true">
                🔒
              </span>
              <span className="lock-badge-text">{scene.lock.holder}</span>
            </span>
          ) : null}
        </div>

        <p className="scene-card-meta">
          <span title={scene.updatedAt}>Updated {updated}</span>
          <span className="meta-sep" aria-hidden="true">
            ·
          </span>
          <span>{author}</span>
          <span className="meta-sep" aria-hidden="true">
            ·
          </span>
          <span>
            {versions === 1 ? "1 version" : `${versions} versions`}
          </span>
        </p>

        <p className="scene-card-slug">
          <code>{scene.slug}</code>
        </p>

        <div className="scene-card-actions">
          <a
            href={href}
            className="btn btn-secondary btn-sm"
            onClick={(e) => onOpen(e)}
          >
            Open
          </a>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRename}
          >
            Rename
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-danger-text"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactElement;
}): ReactElement {
  const titleId = useId();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
