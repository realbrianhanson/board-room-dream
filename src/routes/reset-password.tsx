import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  initialResetPasswordState,
  reduceResetPassword,
  type ResetPasswordEvent,
  type ResetPasswordUiState,
} from "@/lib/reset-password-state";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

// Threshold after which we soften copy to "taking longer than usual" without
// ever claiming the link is expired. Bumped past the old 5s auto-expire so
// slow but successful Supabase callbacks are never mislabeled.
const SLOW_HINT_MS = 12_000;

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState<ResetPasswordUiState>(initialResetPasswordState());
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  function dispatch(event: ResetPasswordEvent) {
    setReady((prev) => reduceResetPassword(prev, event));
  }

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      dispatch({ type: "auth_event", event });
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (data.session) dispatch({ type: "session_ready" });
      // A getSession error alone is not proof the link is expired (network
      // hiccups happen). We only demote to invalid on explicit auth failure,
      // which surfaces via updateUser() below or via a specific error object.
      if (error && /expired|invalid|malformed/i.test(error.message)) {
        dispatch({ type: "auth_error", message: error.message });
      }
    });
    // Soft "taking longer" hint. Never flips state to invalid.
    const slowTimer = window.setTimeout(() => {
      dispatch({ type: "slow_threshold" });
    }, SLOW_HINT_MS);
    return () => {
      sub.subscription.unsubscribe();
      window.clearTimeout(slowTimer);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (password.length < 8) {
      setMessage({ tone: "error", text: "Password must be at least 8 characters." });
      return;
    }
    if (password !== confirm) {
      setMessage({ tone: "error", text: "Passwords do not match." });
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setMessage({ tone: "info", text: "Password updated. Redirecting…" });
      setTimeout(() => navigate({ to: "/dashboard" }), 800);
    } catch (err) {
      setMessage({ tone: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  function recheck() {
    dispatch({ type: "recheck" });
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) dispatch({ type: "session_ready" });
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">
        <Link
          to="/"
          className="mb-8 block text-center font-display text-sm tracking-[0.28em] text-muted-foreground transition-colors hover:text-foreground"
        >
          APP BLUEPRINT
        </Link>

        <div className="rounded-xl border border-border bg-surface-1 p-8 shadow-2xl shadow-black/40">
          <h1 className="font-display text-3xl text-foreground">Set a new password</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {ready === "ok" && "Choose a new password for your account."}
            {ready === "pending" && "Verifying your reset link…"}
            {ready === "pending_slow" &&
              "This is taking a little longer than usual. Your link may still be valid — hang on, or recheck below."}
            {ready === "invalid" && "This reset link is invalid or has expired."}
          </p>

          {ready === "ok" && (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                  New password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                  Confirm password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary"
                />
              </div>

              {message && (
                <p
                  className={`text-sm ${
                    message.tone === "error" ? "text-destructive" : "text-success"
                  }`}
                >
                  {message.text}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
              >
                {loading ? "Updating…" : "Update password"}
              </button>
            </form>
          )}

          {ready === "pending_slow" && (
            <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={recheck}
                className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40"
              >
                Recheck link
              </button>
              <Link
                to="/auth"
                className="text-xs text-primary transition-colors hover:brightness-125"
              >
                Or request a fresh reset email
              </Link>
            </div>
          )}

          {ready === "invalid" && (
            <div className="mt-6 space-y-3 text-sm text-muted-foreground">
              <p>
                Password-reset links expire quickly for security. Request a fresh
                one from the sign-in page and open it right away.
              </p>
              <Link
                to="/auth"
                className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
              >
                Request a new reset link
              </Link>
            </div>
          )}

          {ready !== "ok" && message && (
            <p
              className={`mt-6 text-sm ${
                message.tone === "error" ? "text-destructive" : "text-success"
              }`}
            >
              {message.text}
            </p>
          )}

          <p className="mt-6 text-center text-xs text-muted-foreground">
            <Link to="/auth" className="text-primary transition-colors hover:brightness-125">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
