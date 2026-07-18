import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

type Mode = "password" | "magic";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("password");
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin + "/dashboard" },
        });
        if (error) throw error;
        setMessage({ tone: "info", text: "Check your inbox for the sign-in link." });
      } else if (isSignup) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + "/dashboard" },
        });
        if (error) throw error;
        setMessage({
          tone: "info",
          text: "Account created. Check your email to confirm, then sign in.",
        });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/dashboard" });
      }
    } catch (err) {
      setMessage({ tone: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email) {
      setMessage({ tone: "error", text: "Enter your email above, then click Forgot password again." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password",
      });
      if (error) throw error;
      setMessage({ tone: "info", text: "Password reset link sent. Check your inbox." });
    } catch (err) {
      setMessage({ tone: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">
        <Link
          to="/"
          className="mb-8 block text-center font-display text-sm tracking-[0.28em] text-muted-foreground transition-colors hover:text-foreground"
        >
          BOARDROOM
        </Link>

        <div className="rounded-xl border border-border bg-surface-1 p-8 shadow-2xl shadow-black/40">
          <h1 className="font-display text-3xl text-foreground">
            {isSignup ? "Request a seat" : "The board is in session."}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {isSignup
              ? "Create your account to enter the boardroom."
              : "Sign in to continue."}
          </p>

          <div className="mt-6 inline-flex rounded-md border border-border bg-background p-1 text-xs">
            <button
              type="button"
              onClick={() => setMode("password")}
              className={`rounded-sm px-3 py-1.5 transition-colors ${
                mode === "password"
                  ? "bg-surface-2 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setMode("magic")}
              className={`rounded-sm px-3 py-1.5 transition-colors ${
                mode === "magic"
                  ? "bg-surface-2 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Magic link
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                Email
              </label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary"
              />
            </div>

            {mode === "password" && (
              <div>
                <label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                  Password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary"
                />
              </div>
            )}

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
              {loading
                ? "Working…"
                : mode === "magic"
                  ? "Send magic link"
                  : isSignup
                    ? "Create account"
                    : "Sign in"}
            </button>
          </form>

          {mode === "password" && (
            <p className="mt-6 text-center text-xs text-muted-foreground">
              {isSignup ? "Already have a seat?" : "New to the boardroom?"}{" "}
              <button
                type="button"
                onClick={() => setIsSignup((v) => !v)}
                className="text-primary transition-colors hover:brightness-125"
              >
                {isSignup ? "Sign in" : "Create an account"}
              </button>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
