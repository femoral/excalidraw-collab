import {
  useId,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { normalizeTokenInput } from "./auth.ts";

export type LoginScreenProps = {
  /** Optional error from a failed verification attempt. */
  error: string | null;
  busy: boolean;
  onSubmit: (token: string) => void;
};

/**
 * One-field token login. The token is verified by the parent against the API
 * before the session is considered authenticated.
 */
export function LoginScreen({
  error,
  busy,
  onSubmit,
}: LoginScreenProps): ReactElement {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const token = normalizeTokenInput(value);
    if (!token) {
      setLocalError("Paste an access token to continue.");
      return;
    }
    setLocalError(null);
    onSubmit(token);
  }

  const displayError = localError ?? error;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            ✎
          </span>
          <div>
            <h1 className="login-title">excalidraw-collab</h1>
            <p className="login-subtitle">
              Self-hosted boards with turn-based collaboration.
            </p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <label className="field-label" htmlFor={inputId}>
            Access token
          </label>
          <input
            id={inputId}
            className="field-input"
            type="password"
            name="token"
            autoComplete="current-password"
            spellCheck={false}
            placeholder="Paste your bearer token"
            value={value}
            disabled={busy}
            aria-invalid={displayError ? true : undefined}
            aria-describedby={displayError ? errorId : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              if (localError) setLocalError(null);
            }}
          />

          {displayError ? (
            <p id={errorId} className="form-error" role="alert">
              {displayError}
            </p>
          ) : (
            <p className="form-hint">
              Tokens are minted by an admin (
              <code>excalicli token create</code>
              ). Stored only in this browser.
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={busy}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
