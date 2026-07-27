import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import { ApiError, createApiClient, type ApiClient } from "./api.ts";
import {
  applyUnauthorized,
  readStoredToken,
  reduceAuth,
  writeStoredToken,
  type AuthState,
} from "./auth.ts";
import { LoginScreen } from "./LoginScreen.tsx";
import { matchRoute, type Route } from "./routing.ts";
import {
  getEditorUnsavedFlag,
  setEditorUnsavedFlag,
  UNSAVED_LEAVE_MESSAGE,
} from "./editor-logic.ts";
import { HistoryView } from "./HistoryView.tsx";
import { parseVersionQuery } from "./history-logic.ts";
import { SceneEditor } from "./SceneEditor.tsx";
import { SceneList } from "./SceneList.tsx";
import {
  applyThemeToDocument,
  oppositeTheme,
  readHintDismissed,
  readSystemPreference,
  readViewerTheme,
  resolveTheme,
  shouldShowThemeMismatchHint,
  subscribeSystemPreference,
  writeHintDismissed,
  writeViewerTheme,
  type InstanceTheme,
  type Theme,
  type ViewerThemeChoice,
} from "./theme-logic.ts";

function useLocation(): { pathname: string; search: string } {
  const [loc, setLoc] = useState(() => ({
    pathname: window.location.pathname || "/",
    search: window.location.search || "",
  }));

  useEffect(() => {
    const onPopState = () => {
      setLoc({
        pathname: window.location.pathname || "/",
        search: window.location.search || "",
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return loc;
}

function navigate(to: string, event?: MouseEvent<HTMLAnchorElement>) {
  if (
    event &&
    (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
  ) {
    return;
  }
  event?.preventDefault();

  const current = `${window.location.pathname}${window.location.search}`;
  if (current === to) return;

  if (getEditorUnsavedFlag()) {
    const ok = window.confirm(UNSAVED_LEAVE_MESSAGE);
    if (!ok) return;
    setEditorUnsavedFlag(false);
  }

  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function SceneView({
  slug,
  api,
  search,
  theme,
}: {
  slug: string;
  api: ApiClient;
  search: string;
  theme: Theme;
}): ReactElement {
  const version = parseVersionQuery(search);
  return (
    <SceneEditor
      slug={slug}
      api={api}
      onNavigate={navigate}
      version={version}
      theme={theme}
    />
  );
}

function NotFoundView({ path }: { path: string }): ReactElement {
  return (
    <div className="placeholder-panel">
      <h2>Not found</h2>
      <p>
        No route for <code>{path}</code>.
      </p>
      <p>
        <a href="/" onClick={(e) => navigate("/", e)}>
          Scenes
        </a>
      </p>
    </div>
  );
}

function routeTitle(route: Route): string {
  switch (route.name) {
    case "home":
      return "Scenes";
    case "scene":
      return route.slug;
    case "history":
      return `${route.slug} · history`;
    case "render":
      return "Render";
    case "notFound":
      return "Not found";
  }
}

function storage(): Storage {
  return window.localStorage;
}

type ThemeController = {
  theme: Theme;
  viewerChoice: ViewerThemeChoice;
  instanceDefault: InstanceTheme;
  systemPreference: Theme;
  showMismatchHint: boolean;
  isAdmin: boolean;
  setIsAdmin: (value: boolean) => void;
  toggleTheme: () => void;
  adoptInstanceTheme: () => void;
  switchToSystemTheme: () => void;
  dismissMismatchHint: () => void;
  publishInstanceDefault: () => Promise<void>;
  instanceBusy: boolean;
  instanceError: string | null;
  clearInstanceError: () => void;
};

/**
 * Theme controller: resolves viewer > instance > system, applies to DOM,
 * and exposes toggle / admin publish controls (issue #38).
 */
function useThemeController(api: ApiClient): ThemeController {
  const [viewerChoice, setViewerChoice] = useState<ViewerThemeChoice>(() =>
    readViewerTheme(storage()),
  );
  const [instanceDefault, setInstanceDefault] = useState<InstanceTheme>(null);
  const [systemPreference, setSystemPreference] = useState<Theme>(() =>
    readSystemPreference(),
  );
  const [hintDismissed, setHintDismissed] = useState(() =>
    readHintDismissed(storage()),
  );
  const [isAdmin, setIsAdmin] = useState(false);
  const [instanceBusy, setInstanceBusy] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);

  const theme = resolveTheme({
    viewerChoice,
    instanceDefault,
    systemPreference,
  });

  // Apply immediately (also covers first paint after instance default arrives).
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  // Mid-session OS switches only matter when no higher-precedence source exists.
  useEffect(() => {
    return subscribeSystemPreference((next) => {
      setSystemPreference(next);
    });
  }, []);

  // Instance default: unauthenticated read so login themes correctly.
  // Do not block first paint — provisional theme already applied from
  // localStorage / prefers-color-scheme in index.html.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getThemeSettings();
        if (cancelled) return;
        setInstanceDefault(settings.theme);
      } catch {
        // Offline / 5xx: keep provisional theme; instance stays null.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const showMismatchHint = shouldShowThemeMismatchHint({
    viewerChoice,
    instanceDefault,
    systemPreference,
    hintDismissed,
  });

  const setLocalChoice = useCallback((choice: Theme) => {
    writeViewerTheme(storage(), choice);
    setViewerChoice(choice);
    // Choosing is a permanent local preference; hide the hint forever.
    writeHintDismissed(storage(), true);
    setHintDismissed(true);
  }, []);

  const toggleTheme = useCallback(() => {
    setLocalChoice(oppositeTheme(theme));
  }, [theme, setLocalChoice]);

  const adoptInstanceTheme = useCallback(() => {
    if (instanceDefault) setLocalChoice(instanceDefault);
  }, [instanceDefault, setLocalChoice]);

  const switchToSystemTheme = useCallback(() => {
    setLocalChoice(systemPreference);
  }, [systemPreference, setLocalChoice]);

  const dismissMismatchHint = useCallback(() => {
    // Dismiss without switching: lock current resolved (instance) theme as
    // the local choice so the hint never returns.
    writeViewerTheme(storage(), theme);
    setViewerChoice(theme);
    writeHintDismissed(storage(), true);
    setHintDismissed(true);
  }, [theme]);

  const publishInstanceDefault = useCallback(async () => {
    setInstanceBusy(true);
    setInstanceError(null);
    try {
      const settings = await api.setThemeSettings(theme);
      setInstanceDefault(settings.theme);
      // Publishing implies the admin wants this theme locally too.
      writeViewerTheme(storage(), theme);
      setViewerChoice(theme);
    } catch (err) {
      setInstanceError(
        err instanceof Error ? err.message : "Could not set instance theme.",
      );
    } finally {
      setInstanceBusy(false);
    }
  }, [api, theme]);

  const clearInstanceError = useCallback(() => {
    setInstanceError(null);
  }, []);

  return {
    theme,
    viewerChoice,
    instanceDefault,
    systemPreference,
    showMismatchHint,
    isAdmin,
    setIsAdmin,
    toggleTheme,
    adoptInstanceTheme,
    switchToSystemTheme,
    dismissMismatchHint,
    publishInstanceDefault,
    instanceBusy,
    instanceError,
    clearInstanceError,
  };
}

function ThemeToggleButton({
  theme,
  onToggle,
  className,
}: {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}): ReactElement {
  const next = oppositeTheme(theme);
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm theme-toggle${className ? ` ${className}` : ""}`}
      onClick={onToggle}
      aria-label={next === "dark" ? "Switch to dark theme" : "Switch to light theme"}
      title={next === "dark" ? "Dark theme" : "Light theme"}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

export function App(): ReactElement {
  const { pathname, search } = useLocation();
  const route = matchRoute(pathname);

  const [auth, dispatchAuth] = useReducer(
    reduceAuth,
    undefined,
    (): AuthState => {
      const token = readStoredToken(storage());
      return reduceAuth({ status: "anonymous" }, { type: "hydrate", token });
    },
  );

  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // Stable token getter for the API client — always reads current auth.
  const authRef = useRef(auth);
  authRef.current = auth;

  const handleUnauthorized = useCallback(() => {
    applyUnauthorized(storage());
    dispatchAuth({ type: "unauthorized" });
    setLoginError("Your session expired or the token was revoked. Sign in again.");
    setLoginBusy(false);
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        getToken: () => {
          const s = authRef.current;
          if (s.status === "authenticated" || s.status === "checking") {
            return s.token;
          }
          return null;
        },
        onUnauthorized: handleUnauthorized,
      }),
    [handleUnauthorized],
  );

  const themeCtl = useThemeController(api);

  // Verify stored (or freshly submitted) tokens against the API.
  useEffect(() => {
    if (auth.status !== "checking") return;

    let cancelled = false;
    setLoginBusy(true);

    void (async () => {
      try {
        await api.verifySession();
        if (cancelled) return;
        writeStoredToken(storage(), auth.token);
        dispatchAuth({ type: "session_verified" });
        setLoginError(null);
        // Load admin bit for "set instance default" control.
        try {
          const who = await api.whoami();
          if (!cancelled) themeCtl.setIsAdmin(who.isAdmin);
        } catch {
          if (!cancelled) themeCtl.setIsAdmin(false);
        }
      } catch (err) {
        if (cancelled) return;
        // 401 already cleared storage + set anonymous via onUnauthorized.
        if (err instanceof ApiError && err.isUnauthorized) {
          setLoginError(
            "That token is invalid or has been revoked. Request a new one.",
          );
        } else {
          // Network / server errors: return to login UI but keep the token so
          // reload retries without re-pasting. (logout does not clear storage.)
          const message =
            err instanceof Error
              ? err.message
              : "Could not reach the server.";
          setLoginError(message);
          dispatchAuth({ type: "logout" });
        }
      } finally {
        if (!cancelled) setLoginBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // themeCtl methods are stable enough; avoid re-running on theme flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, api]);

  // Clear admin flag on logout.
  useEffect(() => {
    if (auth.status === "anonymous") {
      themeCtl.setIsAdmin(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  function handleLoginSubmit(token: string) {
    setLoginError(null);
    writeStoredToken(storage(), token);
    dispatchAuth({ type: "login", token });
  }

  function handleLogout() {
    applyUnauthorized(storage());
    dispatchAuth({ type: "logout" });
    setLoginError(null);
    navigate("/");
  }

  // --- Auth gates -----------------------------------------------------------

  if (auth.status === "anonymous") {
    return (
      <LoginScreen
        error={loginError}
        busy={loginBusy}
        onSubmit={handleLoginSubmit}
        theme={themeCtl.theme}
        onToggleTheme={themeCtl.toggleTheme}
      />
    );
  }

  if (auth.status === "checking") {
    return (
      <div className="session-check" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>Checking session…</p>
      </div>
    );
  }

  // authenticated
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-brand">
          <a
            href="/"
            className="app-logo"
            onClick={(e) => navigate("/", e)}
          >
            excalidraw-collab
          </a>
          <span className="app-header-sep" aria-hidden="true">
            /
          </span>
          <h1 className="app-header-title">{routeTitle(route)}</h1>
        </div>
        <nav className="app-header-nav" aria-label="Primary">
          <a
            href="/"
            className={route.name === "home" ? "nav-link is-active" : "nav-link"}
            onClick={(e) => navigate("/", e)}
          >
            Scenes
          </a>
          {route.name === "scene" || route.name === "history" ? (
            <>
              <a
                href={`/s/${encodeURIComponent(route.slug)}`}
                className={
                  route.name === "scene" ? "nav-link is-active" : "nav-link"
                }
                onClick={(e) =>
                  navigate(`/s/${encodeURIComponent(route.slug)}`, e)
                }
              >
                Editor
              </a>
              <a
                href={`/s/${encodeURIComponent(route.slug)}/history`}
                className={
                  route.name === "history" ? "nav-link is-active" : "nav-link"
                }
                onClick={(e) =>
                  navigate(
                    `/s/${encodeURIComponent(route.slug)}/history`,
                    e,
                  )
                }
              >
                History
              </a>
            </>
          ) : null}
          <div className="header-theme-controls">
            <ThemeToggleButton
              theme={themeCtl.theme}
              onToggle={themeCtl.toggleTheme}
            />
            {themeCtl.isAdmin ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm theme-instance-btn"
                disabled={themeCtl.instanceBusy}
                onClick={() => {
                  void themeCtl.publishInstanceDefault();
                }}
                title="Publish the current theme as this instance’s default for all viewers without a local choice"
              >
                Set instance default
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm header-sign-out"
            onClick={handleLogout}
          >
            Sign out
          </button>
        </nav>
      </header>

      {themeCtl.showMismatchHint && themeCtl.instanceDefault ? (
        <div
          className="banner banner-info theme-mismatch-banner"
          role="status"
        >
          <span>
            This instance defaults to the{" "}
            <strong>{themeCtl.instanceDefault}</strong> theme, which differs
            from your system preference ({themeCtl.systemPreference}).
          </span>
          <div className="banner-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={themeCtl.switchToSystemTheme}
            >
              Use system ({themeCtl.systemPreference})
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={themeCtl.adoptInstanceTheme}
            >
              Keep {themeCtl.instanceDefault}
            </button>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Dismiss"
              onClick={themeCtl.dismissMismatchHint}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      {themeCtl.instanceError ? (
        <div className="banner banner-error theme-mismatch-banner" role="alert">
          <span>{themeCtl.instanceError}</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss"
            onClick={themeCtl.clearInstanceError}
          >
            ×
          </button>
        </div>
      ) : null}

      <main className="app-main">
        {route.name === "home" ? (
          <SceneList api={api} onNavigate={navigate} />
        ) : null}
        {route.name === "scene" ? (
          <SceneView
            slug={route.slug}
            api={api}
            search={search}
            theme={themeCtl.theme}
          />
        ) : null}
        {route.name === "history" ? (
          <HistoryView slug={route.slug} api={api} onNavigate={navigate} />
        ) : null}
        {route.name === "notFound" ? (
          <NotFoundView path={route.path} />
        ) : null}
      </main>
    </div>
  );
}
