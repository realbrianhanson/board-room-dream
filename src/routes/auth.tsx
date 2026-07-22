import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [isSignup, setIsSignup] = useState(false);
  const [showMagic, setShowMagic] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [magicEmail, setMagicEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (isSignup) {
      if (password.length < 8) {
        setMessage({ tone: "error", text: "Password must be at least 8 characters." });
        return;
      }
      if (password !== confirm) {
        setMessage({ tone: "error", text: "Passwords do not match." });
        return;
      }
    }
    setLoading(true);
    try {
      if (isSignup) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/dashboard`,
            data: { display_name: displayName || email.split("@")[0] },
          },
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
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setMessage({ tone: "info", text: "Password reset link sent. Check your inbox." });
    } catch (err) {
      setMessage({ tone: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: magicEmail,
        options: { emailRedirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) throw error;
      setMessage({ tone: "info", text: "Check your inbox for the sign-in link." });
    } catch (err) {
      setMessage({ tone: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary";
  const labelCls = "mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground";

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
          <h1 className="font-display text-3xl text-foreground">
            {isSignup ? "Request a seat" : "The board is in session."}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {isSignup
              ? "Create your account to enter the boardroom."
              : "Sign in to continue."}
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className={labelCls}>Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
              />
            </div>

            <div>
              <label className={labelCls}>Password</label>
              <input
                type="password"
                required
                minLength={8}
                autoComplete={isSignup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
            </div>

            {isSignup && (
              <>
                <div>
                  <label className={labelCls}>Confirm password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Display name</label>
                  <input
                    type="text"
                    required
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </>
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
              {loading ? "Working…" : isSignup ? "Create account" : "Sign in"}
            </button>
          </form>

          {!isSignup && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={loading}
                className="text-xs text-muted-foreground transition-colors hover:text-primary disabled:opacity-60"
              >
                Forgot password?
              </button>
            </div>
          )}

          <p className="mt-6 text-center text-xs text-muted-foreground">
            {isSignup ? "Already have a seat?" : "New to the boardroom?"}{" "}
            <button
              type="button"
              onClick={() => {
                setIsSignup((v) => !v);
                setMessage(null);
              }}
              className="text-primary transition-colors hover:brightness-125"
            >
              {isSignup ? "Sign in" : "Create an account"}
            </button>
          </p>

          <div className="mt-8 border-t border-border/60 pt-5 text-center">
            {!showMagic ? (
              <button
                type="button"
                onClick={() => setShowMagic(true)}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Prefer an emailed sign-in link?
              </button>
            ) : (
              <form onSubmit={handleMagicLink} className="space-y-3 text-left">
                <label className={labelCls}>Email for sign-in link</label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={magicEmail}
                  onChange={(e) => setMagicEmail(e.target.value)}
                  className={inputCls}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/60 disabled:opacity-60"
                  >
                    {loading ? "Sending…" : "Send magic link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowMagic(false)}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
