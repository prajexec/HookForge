import { StrictMode, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import { createApiClient, errorMessage } from "./api.js";
import { Dashboard } from "./Dashboard.js";
import type { Session } from "./types.js";
import "./styles.css";

function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (session: Session) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = createApiClient(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await api.request<Session>(`/api/v1/auth/${mode}`, {
        method: "POST",
        body: { email: email.trim(), password },
      });
      onAuthenticated(response);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-art">
        <span className="brand-mark">H</span>
        <p className="eyebrow">HookForge / control plane</p>
        <h1>Make every webhook count.</h1>
        <p className="lede">
          Durable events, observable attempts, and receivers you can trust when
          the network gets noisy.
        </p>
        <div className="signal-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <section className="auth-card">
        <p className="eyebrow">
          {mode === "login" ? "Welcome back" : "New workspace"}
        </p>
        <h2>
          {mode === "login" ? "Sign in to HookForge" : "Create an account"}
        </h2>
        <p className="muted">
          {mode === "login"
            ? "Continue to your delivery workspace."
            : "Start with a local project and add your first receiver."}
        </p>
        <form className="auth-form" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={pending}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={pending}
            />
            <small>At least 12 characters.</small>
          </label>
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
          <button className="button wide" type="submit" disabled={pending}>
            {pending
              ? "Working…"
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login"
            ? "Need an account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const api = useMemo(
    () =>
      session ? createApiClient(session.token, () => setSession(null)) : null,
    [session],
  );
  if (!session || !api) return <AuthScreen onAuthenticated={setSession} />;
  return (
    <Dashboard api={api} session={session} onLogout={() => setSession(null)} />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
