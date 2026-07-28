/**
 * Theme resolution (issue #38).
 *
 * Precedence (first wins):
 *   1. Explicit viewer choice in localStorage
 *   2. Server-side instance default
 *   3. prefers-color-scheme (with matchMedia mid-session updates)
 *
 * Theme is a per-viewer preference. It must never enter the scene document.
 */

export type Theme = "light" | "dark";

/** Instance default: a theme, or null when unset. */
export type InstanceTheme = Theme | null;

/** Viewer local choice: a theme, or null when the viewer has not chosen. */
export type ViewerThemeChoice = Theme | null;

export const THEME_STORAGE_KEY = "excalidraw-collab.theme";
export const THEME_HINT_DISMISSED_KEY = "excalidraw-collab.theme-hint-dismissed";

/** Minimal Storage surface so tests can inject an in-memory map. */
export type ThemeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** Parse a stored viewer choice; invalid / empty → null. */
export function readViewerTheme(storage: ThemeStorage): ViewerThemeChoice {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return isTheme(trimmed) ? trimmed : null;
}

/** Persist an explicit viewer choice (or clear with null). */
export function writeViewerTheme(storage: ThemeStorage, theme: ViewerThemeChoice): void {
  if (theme === null) {
    storage.removeItem(THEME_STORAGE_KEY);
    return;
  }
  storage.setItem(THEME_STORAGE_KEY, theme);
}

export function readHintDismissed(storage: ThemeStorage): boolean {
  return storage.getItem(THEME_HINT_DISMISSED_KEY) === "1";
}

export function writeHintDismissed(storage: ThemeStorage, dismissed: boolean): void {
  if (dismissed) {
    storage.setItem(THEME_HINT_DISMISSED_KEY, "1");
  } else {
    storage.removeItem(THEME_HINT_DISMISSED_KEY);
  }
}

/**
 * Resolve the effective theme from the three sources.
 * Pure: no DOM / media access — pass system preference in.
 */
export function resolveTheme(input: {
  viewerChoice: ViewerThemeChoice;
  instanceDefault: InstanceTheme;
  systemPreference: Theme;
}): Theme {
  if (input.viewerChoice !== null) return input.viewerChoice;
  if (input.instanceDefault !== null) return input.instanceDefault;
  return input.systemPreference;
}

/**
 * Whether to show the one-shot mismatch hint.
 *
 * Conditions (all required):
 * - Viewer has no local choice
 * - Instance default is set
 * - Instance default differs from OS preference
 * - Hint has not been dismissed (dismissal also records a local choice in UI)
 */
export function shouldShowThemeMismatchHint(input: {
  viewerChoice: ViewerThemeChoice;
  instanceDefault: InstanceTheme;
  systemPreference: Theme;
  hintDismissed: boolean;
}): boolean {
  if (input.viewerChoice !== null) return false;
  if (input.hintDismissed) return false;
  if (input.instanceDefault === null) return false;
  return input.instanceDefault !== input.systemPreference;
}

/** Opposite theme (for the toggle). */
export function oppositeTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/**
 * Apply resolved theme to the document root.
 * Sets `data-theme` and `color-scheme` so CSS vars + native UI follow.
 */
export function applyThemeToDocument(
  theme: Theme,
  root: {
    setAttribute(name: string, value: string): void;
    style: { colorScheme: string };
  } = typeof document !== "undefined"
    ? document.documentElement
    : { setAttribute() {}, style: { colorScheme: "" } },
): void {
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

/**
 * Read prefers-color-scheme. Defaults to light when matchMedia is unavailable
 * (tests / non-browser).
 */
export function readSystemPreference(
  matchMedia:
    ((query: string) => { matches: boolean }) | undefined = typeof globalThis.matchMedia ===
  "function"
    ? globalThis.matchMedia.bind(globalThis)
    : undefined,
): Theme {
  if (!matchMedia) return "light";
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * Subscribe to mid-session OS theme changes. Returns an unsubscribe.
 * No-op when matchMedia / addEventListener are missing.
 */
export function subscribeSystemPreference(
  onChange: (theme: Theme) => void,
  matchMedia: ((query: string) => MediaQueryListLike) | undefined = typeof globalThis.matchMedia ===
  "function"
    ? (globalThis.matchMedia.bind(globalThis) as (query: string) => MediaQueryListLike)
    : undefined,
): () => void {
  if (!matchMedia) return () => {};
  let mql: MediaQueryListLike;
  try {
    mql = matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  const handler = () => {
    onChange(mql.matches ? "dark" : "light");
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener?.("change", handler);
  }
  // Safari < 14
  if (typeof mql.addListener === "function") {
    mql.addListener(handler);
    return () => mql.removeListener?.(handler);
  }
  return () => {};
}

type MediaQueryListLike = {
  matches: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};
