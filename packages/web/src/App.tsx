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
import { SceneEditor } from "./SceneEditor.tsx";
import { SceneList } from "./SceneList.tsx";

function usePathname(): string {
  const [pathname, setPathname] = useState(
    () => window.location.pathname || "/",
  );

  useEffect(() => {
    const onPopState = () => {
      setPathname(window.location.pathname || "/");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return pathname;
}

function navigate(to: string, event?: MouseEvent<HTMLAnchorElement>) {
  if (
    event &&
    (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
  ) {
    return;
  }
  event?.preventDefault();
  if (window.location.pathname === to) return;

  if (getEditorUnsavedFlag()) {
    const ok = window.confirm(UNSAVED_LEAVE_MESSAGE);
    if (!ok) return;
    setEditorUnsavedFlag(false);
  }

  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function HistoryView({ slug }: { slug: string }): ReactElement {
  return (
    <div className="placeholder-panel">
      <h2>Version history</h2>
      <p>
        History for scene <code>{slug}</code> will load here (Phase 3).
      </p>
      <p>
        <a
          href={`/s/${encodeURIComponent(slug)}`}
          onClick={(e) => navigate(`/s/${encodeURIComponent(slug)}`, e)}
        >
          Back to editor
        </a>
      </p>
    </div>
  );
}

function SceneView({
  slug,
  api,
}: {
  slug: string;
  api: ApiClient;
}): ReactElement {
  return <SceneEditor slug={slug} api={api} onNavigate={navigate} />;
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
    case "notFound":
      return "Not found";
  }
}

function storage(): Storage {
  return window.localStorage;
}

export function App(): ReactElement {
  const pathname = usePathname();
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
  }, [auth, api]);

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
          <button
            type="button"
            className="btn btn-ghost btn-sm header-sign-out"
            onClick={handleLogout}
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="app-main">
        {route.name === "home" ? (
          <SceneList api={api} onNavigate={navigate} />
        ) : null}
        {route.name === "scene" ? (
          <SceneView slug={route.slug} api={api} />
        ) : null}
        {route.name === "history" ? (
          <HistoryView slug={route.slug} />
        ) : null}
        {route.name === "notFound" ? (
          <NotFoundView path={route.path} />
        ) : null}
      </main>
    </div>
  );
}
