/** Hand-rolled path routes — no router dependency. */

export type Route =
  | { name: "home" }
  | { name: "scene"; slug: string }
  | { name: "history"; slug: string }
  | { name: "notFound"; path: string };

/**
 * Match exactly the three app routes: `/`, `/s/:slug`, `/s/:slug/history`.
 * Trailing slashes (except root) are normalized away.
 */
export function matchRoute(pathname: string): Route {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  if (path === "/" || path === "") {
    return { name: "home" };
  }

  const historyMatch = /^\/s\/([^/]+)\/history$/.exec(path);
  if (historyMatch) {
    return { name: "history", slug: decodeURIComponent(historyMatch[1]!) };
  }

  const sceneMatch = /^\/s\/([^/]+)$/.exec(path);
  if (sceneMatch) {
    return { name: "scene", slug: decodeURIComponent(sceneMatch[1]!) };
  }

  return { name: "notFound", path: pathname };
}
