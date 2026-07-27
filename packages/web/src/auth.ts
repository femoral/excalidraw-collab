/**
 * Token storage and auth state transitions for the web app.
 *
 * The bearer token lives in localStorage and is cleared on any 401 so a
 * revoked session never leaves a half-rendered authenticated UI.
 */

export const TOKEN_STORAGE_KEY = "excalidraw-collab.token";

/** Minimal Storage surface so tests can inject an in-memory map. */
export type TokenStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type AuthState =
  | { status: "checking"; token: string }
  | { status: "authenticated"; token: string }
  | { status: "anonymous" };

export type AuthAction =
  | { type: "hydrate"; token: string | null }
  | { type: "login"; token: string }
  | { type: "session_verified" }
  | { type: "unauthorized" }
  | { type: "logout" };

/** Read a non-empty trimmed token, or null. */
export function readStoredToken(storage: TokenStorage): string | null {
  const raw = storage.getItem(TOKEN_STORAGE_KEY);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function writeStoredToken(storage: TokenStorage, token: string): void {
  storage.setItem(TOKEN_STORAGE_KEY, token);
}

/**
 * Clear the stored token. Called on logout and on any 401 response.
 * Idempotent.
 */
export function clearStoredToken(storage: TokenStorage): void {
  storage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Pure auth reducer. Side effects (localStorage writes) stay outside —
 * the reducer only maps state + action → next state.
 */
export function reduceAuth(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "hydrate": {
      if (action.token) {
        return { status: "checking", token: action.token };
      }
      return { status: "anonymous" };
    }
    case "login": {
      const token = action.token.trim();
      if (token.length === 0) {
        return { status: "anonymous" };
      }
      // Verify against the API before treating as authenticated.
      return { status: "checking", token };
    }
    case "session_verified": {
      if (state.status === "checking" || state.status === "authenticated") {
        return { status: "authenticated", token: state.token };
      }
      return state;
    }
    case "unauthorized":
    case "logout":
      return { status: "anonymous" };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Apply the 401-clears-token rule: wipe storage and return anonymous auth.
 * Pure-ish: storage mutation is the only side effect, intentionally here so
 * every call site that handles 401 uses the same path.
 */
export function applyUnauthorized(storage: TokenStorage): AuthState {
  clearStoredToken(storage);
  return { status: "anonymous" };
}

/**
 * Normalize a login field value: trim whitespace; empty → null.
 */
export function normalizeTokenInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
