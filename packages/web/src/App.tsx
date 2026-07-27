import { Excalidraw } from "@excalidraw/excalidraw";
import { useEffect, useState, type MouseEvent, type ReactElement } from "react";
import { matchRoute, type Route } from "./routing.ts";

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
  if (window.location.pathname !== to) {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function ExcalidrawCanvas({ label }: { label: string }): ReactElement {
  return (
    <div className="excalidraw-host" data-canvas={label}>
      <Excalidraw />
    </div>
  );
}

function HomeView(): ReactElement {
  return <ExcalidrawCanvas label="scratch" />;
}

function SceneView({ slug }: { slug: string }): ReactElement {
  return <ExcalidrawCanvas label={`scene:${slug}`} />;
}

function HistoryView({ slug }: { slug: string }): ReactElement {
  return (
    <div className="placeholder-panel">
      <h2>Version history</h2>
      <p>
        History for scene <code>{slug}</code> will load here (Phase 3).
      </p>
      <p>
        <a href={`/s/${encodeURIComponent(slug)}`} onClick={(e) => navigate(`/s/${encodeURIComponent(slug)}`, e)}>
          Back to editor
        </a>
      </p>
    </div>
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
          Home
        </a>
      </p>
    </div>
  );
}

function routeTitle(route: Route): string {
  switch (route.name) {
    case "home":
      return "Scratch";
    case "scene":
      return route.slug;
    case "history":
      return `${route.slug} · history`;
    case "notFound":
      return "Not found";
  }
}

export function App(): ReactElement {
  const pathname = usePathname();
  const route = matchRoute(pathname);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>excalidraw-collab · {routeTitle(route)}</h1>
        <nav>
          <a href="/" onClick={(e) => navigate("/", e)}>
            Scratch
          </a>
          {route.name === "scene" || route.name === "history" ? (
            <>
              <a
                href={`/s/${encodeURIComponent(route.slug)}`}
                onClick={(e) =>
                  navigate(`/s/${encodeURIComponent(route.slug)}`, e)
                }
              >
                Editor
              </a>
              <a
                href={`/s/${encodeURIComponent(route.slug)}/history`}
                onClick={(e) =>
                  navigate(`/s/${encodeURIComponent(route.slug)}/history`, e)
                }
              >
                History
              </a>
            </>
          ) : null}
        </nav>
      </header>
      <main className="app-main">
        {route.name === "home" ? <HomeView /> : null}
        {route.name === "scene" ? <SceneView slug={route.slug} /> : null}
        {route.name === "history" ? <HistoryView slug={route.slug} /> : null}
        {route.name === "notFound" ? <NotFoundView path={route.path} /> : null}
      </main>
    </div>
  );
}
