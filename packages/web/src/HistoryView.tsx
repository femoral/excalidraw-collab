/**
 * Version history: timeline + two-version diff + open/restore.
 * Pure decision logic lives in history-logic.ts; this file is the React shell.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
import {
  ApiError,
  type ApiClient,
  type SceneDiffResponse,
  type VersionInfo,
} from "./api.ts";
import {
  appendRemoteVersion,
  buildRestorePayload,
  elementHeadline,
  formatChangeCounts,
  formatVersionTimestamp,
  headEditorPath,
  isVersionSelected,
  opBadge,
  orderVersionsNewestFirst,
  parentRefForVersion,
  prioritizeDiff,
  resolveDiffRange,
  selectionRole,
  shouldAppendRemoteVersion,
  toggleVersionSelection,
  totalChangeCount,
  versionEditorPath,
  versionInfoFromSceneEvent,
  type DiffSection,
  type DiffViewItem,
  type PrioritizedDiffView,
} from "./history-logic.ts";
import {
  initialPollState,
  pollAdvanceSince,
  pollBeginWait,
  pollNextDelayMs,
  pollOnError,
  pollOnEvent,
  pollOnTimeout,
  pollStop,
} from "./what-changed-logic.ts";

export type HistoryViewProps = {
  slug: string;
  api: ApiClient;
  onNavigate: (path: string, event?: MouseEvent<HTMLAnchorElement>) => void;
};

type TimelineState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      versions: VersionInfo[];
      total: number;
      headVersion: number;
      /** parent→version change counts, keyed by version number. */
      commitCounts: Record<number, string>;
    };

type DiffState =
  | { kind: "idle" }
  | { kind: "loading"; from: number; to: number }
  | { kind: "error"; message: string; from: number; to: number }
  | {
      kind: "ready";
      from: number;
      to: number;
      raw: SceneDiffResponse;
      view: PrioritizedDiffView;
    };

export function HistoryView({
  slug,
  api,
  onNavigate,
}: HistoryViewProps): ReactElement {
  const [timeline, setTimeline] = useState<TimelineState>({ kind: "loading" });
  const [selected, setSelected] = useState<number[]>([]);
  const [diff, setDiff] = useState<DiffState>({ kind: "idle" });
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({});
  const [showAllInSection, setShowAllInSection] = useState<
    Record<string, boolean>
  >({});
  const [restoreBusy, setRestoreBusy] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const titleId = useId();

  /** Per-scene long-poll cursor (head version watermark). */
  const pollSinceRef = useRef(0);
  const selfNameRef = useRef<string | null>(null);
  const headVersionRef = useRef(0);

  // ----- load timeline ------------------------------------------------------

  const loadTimeline = useCallback(async () => {
    setTimeline({ kind: "loading" });
    setRestoreError(null);
    try {
      const [page, who] = await Promise.all([
        api.listVersions(slug, { limit: 100, offset: 0 }),
        api.whoami().catch(() => null),
      ]);
      selfNameRef.current = who?.name ?? null;
      const versions = orderVersionsNewestFirst(page.versions);

      // Per-commit change counts (parent → version). Bounded parallelism.
      const commitCounts: Record<number, string> = {};
      const CONCURRENCY = 6;
      let cursor = 0;
      async function worker() {
        while (cursor < versions.length) {
          const i = cursor++;
          const v = versions[i]!;
          try {
            const d = await api.getDiff(slug, parentRefForVersion(v), v.version);
            commitCounts[v.version] = formatChangeCounts(d.summary);
          } catch {
            // Non-fatal: leave the badge blank rather than fail the page.
            commitCounts[v.version] = "";
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, versions.length) }, () =>
          worker(),
        ),
      );

      headVersionRef.current = page.headVersion;
      pollSinceRef.current = page.headVersion;
      setTimeline({
        kind: "ready",
        versions,
        total: page.total,
        headVersion: page.headVersion,
        commitCounts,
      });
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      setTimeline({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load history.",
      });
    }
  }, [api, slug]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  // ----- long-poll: append remote versions without moving selection ---------

  useEffect(() => {
    if (timeline.kind !== "ready") return;

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

          const to =
            typeof event.headVersion === "number"
              ? event.headVersion
              : event.version;
          if (!Number.isInteger(to) || to <= pollSinceRef.current) {
            poll = pollOnTimeout(poll);
            continue;
          }

          poll = pollOnEvent(poll, to);
          pollSinceRef.current = to;

          const self = selfNameRef.current;
          if (
            !shouldAppendRemoteVersion(event, {
              selfName: self,
              currentHead: headVersionRef.current,
            })
          ) {
            // Self-authored or already known — advance head watermark only.
            if (to > headVersionRef.current) {
              headVersionRef.current = to;
              setTimeline((s) =>
                s.kind === "ready" ? { ...s, headVersion: to } : s,
              );
            }
            continue;
          }

          const info = versionInfoFromSceneEvent(event);
          headVersionRef.current = to;

          // Fetch parent→version change counts for the new row (non-fatal).
          let countLabel = "";
          try {
            const d = await api.getDiff(
              slug,
              parentRefForVersion(info),
              info.version,
            );
            countLabel = formatChangeCounts(d.summary);
          } catch {
            countLabel = "";
          }
          if (cancelled || ac.signal.aborted) break;

          setTimeline((s) => {
            if (s.kind !== "ready") return s;
            const appended = appendRemoteVersion(s.versions, info);
            return {
              kind: "ready",
              versions: appended.versions,
              total: Math.max(s.total, appended.total),
              headVersion: Math.max(s.headVersion, appended.headVersion, to),
              commitCounts: {
                ...s.commitCounts,
                [info.version]: countLabel,
              },
            };
          });
          // Intentionally leave `selected` and `diff` untouched.
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
  }, [api, slug, timeline.kind]);

  // ----- load diff when pair resolves ---------------------------------------

  const range = useMemo(() => resolveDiffRange(selected), [selected]);

  useEffect(() => {
    if (!range) {
      setDiff({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setDiff({ kind: "loading", from: range.from, to: range.to });
    setExpandedSections({});
    setShowAllInSection({});

    void (async () => {
      try {
        const raw = await api.getDiff(slug, range.from, range.to);
        if (cancelled) return;
        setDiff({
          kind: "ready",
          from: range.from,
          to: range.to,
          raw,
          view: prioritizeDiff(raw),
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.isUnauthorized) return;
        setDiff({
          kind: "error",
          from: range.from,
          to: range.to,
          message: err instanceof Error ? err.message : "Failed to load diff.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, slug, range?.from, range?.to]);

  // ----- actions ------------------------------------------------------------

  function handleSelect(version: number) {
    setSelected((prev) => toggleVersionSelection(prev, version));
    setRestoreError(null);
  }

  function handleOpen(version: number, event?: MouseEvent) {
    event?.preventDefault();
    const path =
      timeline.kind === "ready" && version === timeline.headVersion
        ? headEditorPath(slug)
        : versionEditorPath(slug, version);
    onNavigate(path);
  }

  async function handleRestore(version: number) {
    if (timeline.kind !== "ready") return;
    if (version === timeline.headVersion) {
      setRestoreError("That version is already head — nothing to restore.");
      return;
    }
    const ok = window.confirm(
      `Restore v${version} as a new version?\n\n` +
        `This commits the content of v${version} on top of head v${timeline.headVersion}. ` +
        `Earlier versions stay in history — restore never rewrites the past.`,
    );
    if (!ok) return;

    setRestoreBusy(version);
    setRestoreError(null);
    try {
      const doc = await api.getSceneDocument(slug, version);
      const body = buildRestorePayload(
        {
          elements: doc.elements ?? [],
          appState: doc.appState,
          files: doc.files as
            | Record<string, import("./api.ts").BinaryFilePayload | undefined>
            | undefined,
        },
        timeline.headVersion,
        version,
      );
      const result = await api.commitScene(slug, body);
      setBanner(
        `Restored v${version} as new v${result.version} (head is now v${result.headVersion}).`,
      );
      setSelected([]);
      await loadTimeline();
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) return;
      if (err instanceof ApiError && err.isConflict) {
        setRestoreError(
          err.message ||
            "Conflict: head moved while restoring. Reload history and try again.",
        );
      } else {
        setRestoreError(
          err instanceof Error ? err.message : "Restore failed.",
        );
      }
    } finally {
      setRestoreBusy(null);
    }
  }

  function sectionIsExpanded(section: DiffSection): boolean {
    if (section.key in expandedSections) {
      return expandedSections[section.key]!;
    }
    return !section.defaultCollapsed;
  }

  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const section =
        diff.kind === "ready"
          ? diff.view.sections.find((s) => s.key === key)
          : undefined;
      const currently =
        key in prev
          ? prev[key]!
          : section
            ? !section.defaultCollapsed
            : true;
      return { ...prev, [key]: !currently };
    });
  }

  // ----- render branches ----------------------------------------------------

  if (timeline.kind === "loading") {
    return (
      <div className="history-page">
        <div className="history-state" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Loading version history…</p>
        </div>
      </div>
    );
  }

  if (timeline.kind === "error") {
    return (
      <div className="history-page">
        <div className="history-state history-state-error" role="alert">
          <p>{timeline.message}</p>
          <div className="history-state-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void loadTimeline()}
            >
              Retry
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onNavigate(headEditorPath(slug))}
            >
              Back to editor
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { versions, headVersion, commitCounts, total } = timeline;

  return (
    <div className="history-page">
      <header className="history-header">
        <div>
          <h2 id={titleId} className="history-title">
            Version history
          </h2>
          <p className="history-lede">
            {total === 0
              ? "No committed versions yet — commit a turn from the editor to start the timeline."
              : `${total} version${total === 1 ? "" : "s"} · head v${headVersion}. Select two to compare.`}
          </p>
        </div>
        <div className="history-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onNavigate(headEditorPath(slug))}
          >
            Back to editor
          </button>
        </div>
      </header>

      {banner ? (
        <div className="banner history-banner" role="status">
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

      {restoreError ? (
        <div className="banner banner-error" role="alert">
          <span>{restoreError}</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setRestoreError(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {versions.length === 0 ? (
        <div className="history-empty">
          <h3>Nothing committed yet</h3>
          <p>
            Drafts never appear here. Open the editor and use{" "}
            <strong>Commit turn</strong> to create the first version.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onNavigate(headEditorPath(slug))}
          >
            Open editor
          </button>
        </div>
      ) : (
        <div className="history-layout">
          <section
            className="history-timeline"
            aria-labelledby={titleId}
          >
            <ol className="version-list">
              {versions.map((v) => {
                const selectedHere = isVersionSelected(selected, v.version);
                const role = selectionRole(selected, v.version);
                const ts = formatVersionTimestamp(v.createdAt);
                const counts = commitCounts[v.version] ?? "";
                const isHead = v.version === headVersion;

                return (
                  <li key={v.version}>
                    <div
                      className={
                        selectedHere
                          ? "version-row is-selected"
                          : "version-row"
                      }
                    >
                      <button
                        type="button"
                        className="version-select"
                        aria-pressed={selectedHere}
                        aria-label={`Select version ${v.version} for comparison`}
                        onClick={() => handleSelect(v.version)}
                      >
                        <span className="version-check" aria-hidden="true">
                          {selectedHere ? "✓" : ""}
                        </span>
                        <span className="version-row-main">
                          <span className="version-row-top">
                            <span className="version-number">
                              v{v.version}
                              {isHead ? (
                                <span className="version-head-badge">head</span>
                              ) : null}
                              {role === "from" ? (
                                <span className="version-role-badge role-from">
                                  from
                                </span>
                              ) : null}
                              {role === "to" ? (
                                <span className="version-role-badge role-to">
                                  to
                                </span>
                              ) : null}
                            </span>
                            {counts ? (
                              <span
                                className="version-counts"
                                title="Changes vs parent"
                              >
                                {counts}
                              </span>
                            ) : null}
                          </span>
                          <span className="version-message">
                            {v.message || "(no message)"}
                          </span>
                          <span className="version-meta">
                            <span className="version-author">{v.author}</span>
                            <span className="meta-sep" aria-hidden="true">
                              ·
                            </span>
                            <time
                              dateTime={v.createdAt}
                              title={ts.absolute}
                            >
                              {ts.relative || ts.absolute}
                            </time>
                            <span className="meta-sep" aria-hidden="true">
                              ·
                            </span>
                            <span className="version-elcount">
                              {v.elementCount} el
                            </span>
                          </span>
                        </span>
                      </button>
                      <div className="version-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleOpen(v.version)}
                        >
                          {isHead ? "Open" : "View"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={
                            isHead ||
                            restoreBusy !== null
                          }
                          title={
                            isHead
                              ? "Already head"
                              : "Commit this version’s content as a new head"
                          }
                          onClick={() => void handleRestore(v.version)}
                        >
                          {restoreBusy === v.version
                            ? "Restoring…"
                            : "Restore"}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section
            className="history-diff"
            aria-label="Version diff"
          >
            <DiffPanel
              selected={selected}
              diff={diff}
              sectionIsExpanded={sectionIsExpanded}
              toggleSection={toggleSection}
              showAllInSection={showAllInSection}
              setShowAllInSection={setShowAllInSection}
              onClearSelection={() => setSelected([])}
            />
          </section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff panel
// ---------------------------------------------------------------------------

function DiffPanel({
  selected,
  diff,
  sectionIsExpanded,
  toggleSection,
  showAllInSection,
  setShowAllInSection,
  onClearSelection,
}: {
  selected: number[];
  diff: DiffState;
  sectionIsExpanded: (s: DiffSection) => boolean;
  toggleSection: (key: string) => void;
  showAllInSection: Record<string, boolean>;
  setShowAllInSection: Dispatch<SetStateAction<Record<string, boolean>>>;
  onClearSelection: () => void;
}): ReactElement {
  if (selected.length === 0) {
    return (
      <div className="diff-empty">
        <h3>Compare versions</h3>
        <p>
          Click two versions in the timeline to see what changed between them.
          Diffs prioritise adds, deletes, and content edits so a large scene
          stays scannable.
        </p>
      </div>
    );
  }

  if (selected.length === 1) {
    return (
      <div className="diff-empty">
        <h3>Select a second version</h3>
        <p>
          <strong>v{selected[0]}</strong> is selected. Pick another version to
          build the diff (older → newer).
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onClearSelection}
        >
          Clear selection
        </button>
      </div>
    );
  }

  if (diff.kind === "loading") {
    return (
      <div className="diff-state" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>
          Diffing v{diff.from} → v{diff.to}…
        </p>
      </div>
    );
  }

  if (diff.kind === "error") {
    return (
      <div className="diff-state diff-state-error" role="alert">
        <p>{diff.message}</p>
      </div>
    );
  }

  if (diff.kind !== "ready") {
    return (
      <div className="diff-empty">
        <p>Select two versions to compare.</p>
      </div>
    );
  }

  const { view, from, to } = diff;

  return (
    <div className="diff-panel">
      <header className="diff-panel-header">
        <div>
          <h3 className="diff-panel-title">
            v{from} → v{to}
          </h3>
          <p className="diff-panel-summary">
            <SummaryPills summary={view.summary} appState={view.appStateCount} />
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onClearSelection}
        >
          Clear
        </button>
      </header>

      {view.isEmpty ? (
        <div className="diff-identical">
          <p>No element or canvas changes between these versions.</p>
        </div>
      ) : (
        <>
          {view.topChanges.length > 0 &&
          totalChangeCount(view.summary) > view.topChanges.length ? (
            <div className="diff-top">
              <h4 className="diff-section-heading">
                Top changes
                <span className="diff-section-count">
                  {view.topChanges.length} of {view.totalItems}
                </span>
              </h4>
              <ul className="diff-item-list">
                {view.topChanges.map((item, i) => (
                  <DiffItemRow key={`top-${i}`} item={item} />
                ))}
              </ul>
            </div>
          ) : null}

          {view.sections.map((section) => {
            const open = sectionIsExpanded(section);
            const showAll = showAllInSection[section.key] === true;
            const visible = showAll
              ? section.items
              : section.items.slice(0, section.previewCount);
            const hidden = section.items.length - visible.length;

            return (
              <section
                key={section.key}
                className={
                  open
                    ? "diff-section"
                    : "diff-section is-collapsed"
                }
              >
                <button
                  type="button"
                  className="diff-section-toggle"
                  aria-expanded={open}
                  onClick={() => toggleSection(section.key)}
                >
                  <span className="diff-section-chevron" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="diff-section-heading">
                    {section.title}
                    <span className="diff-section-count">
                      {section.items.length}
                    </span>
                  </span>
                  {section.defaultCollapsed && !open ? (
                    <span className="diff-section-hint">collapsed</span>
                  ) : null}
                </button>
                {open ? (
                  <>
                    <ul className="diff-item-list">
                      {visible.map((item, i) => (
                        <DiffItemRow
                          key={`${section.key}-${i}`}
                          item={item}
                        />
                      ))}
                    </ul>
                    {hidden > 0 ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm diff-show-more"
                        onClick={() =>
                          setShowAllInSection((prev) => ({
                            ...prev,
                            [section.key]: true,
                          }))
                        }
                      >
                        Show {hidden} more
                      </button>
                    ) : null}
                    {showAll && section.items.length > section.previewCount ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm diff-show-more"
                        onClick={() =>
                          setShowAllInSection((prev) => ({
                            ...prev,
                            [section.key]: false,
                          }))
                        }
                      >
                        Show fewer
                      </button>
                    ) : null}
                  </>
                ) : null}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function SummaryPills({
  summary,
  appState,
}: {
  summary: PrioritizedDiffView["summary"];
  appState: number;
}): ReactElement {
  return (
    <span className="diff-pills">
      {summary.added > 0 ? (
        <span className="diff-pill diff-pill-add">+{summary.added}</span>
      ) : null}
      {summary.deleted > 0 ? (
        <span className="diff-pill diff-pill-delete">−{summary.deleted}</span>
      ) : null}
      {summary.updated > 0 ? (
        <span className="diff-pill diff-pill-update">~{summary.updated}</span>
      ) : null}
      {summary.reordered > 0 ? (
        <span className="diff-pill diff-pill-reorder">↻{summary.reordered}</span>
      ) : null}
      {appState > 0 ? (
        <span className="diff-pill diff-pill-appstate">⚙{appState}</span>
      ) : null}
      {totalChangeCount(summary) === 0 && appState === 0 ? (
        <span className="diff-pill">no changes</span>
      ) : null}
    </span>
  );
}

function DiffItemRow({ item }: { item: DiffViewItem }): ReactElement {
  if (item.kind === "appState") {
    const badge = opBadge("appState");
    return (
      <li className={`diff-item ${badge.className}`}>
        <span className="diff-item-op" title={badge.label} aria-hidden="true">
          {badge.symbol}
        </span>
        <span className="diff-item-body">
          <span className="diff-item-headline">{item.headline}</span>
          {item.detail ? (
            <span className="diff-item-detail">{item.detail}</span>
          ) : null}
        </span>
      </li>
    );
  }

  const badge = opBadge(item.change.op);
  const id = item.change.id;
  return (
    <li className={`diff-item ${badge.className}`}>
      <span className="diff-item-op" title={badge.label} aria-hidden="true">
        {badge.symbol}
      </span>
      <span className="diff-item-body">
        <span className="diff-item-headline" title={`id: ${id}`}>
          {item.headline || elementHeadline(item.change)}
        </span>
        {item.detail ? (
          <span className="diff-item-detail">{item.detail}</span>
        ) : null}
      </span>
    </li>
  );
}

