import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [showCohort, setShowCohort] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const trimmed = code.trim();
      if (!trimmed) throw new Error("Enter a cohort code.");
      const { error: rpcErr } = await supabase.rpc("join_cohort", { code: trimmed });
      if (rpcErr) {
        throw new Error(
          rpcErr.message.replace(/^.*Invalid cohort code.*$/i, "That code doesn't match a cohort."),
        );
      }
      localStorage.removeItem("boardroom.cohort_skipped");
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function startBlueprint() {
    // Preserve the existing skip behavior so we don't nag users again.
    localStorage.setItem("boardroom.cohort_skipped", "1");
    navigate({ to: "/dashboard" });
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Welcome to App Blueprint
      </span>
      <h1 className="mt-4 font-display text-4xl leading-tight text-foreground md:text-5xl">
        Turn your idea into a build you can trust.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
        Bring a new idea or an existing Lovable app. The Boardroom — a council of
        specialist models — challenges assumptions against the real code and
        produces an evidence-backed Blueprint plus safer step-by-step prompts to
        paste back into Lovable.
      </p>

      <div className="mt-8">
        <button
          type="button"
          onClick={startBlueprint}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
        >
          Start my App Blueprint
          <ArrowRight className="h-4 w-4" />
        </button>
        <p className="mt-3 text-xs text-muted-foreground">
          You'll land on your dashboard — start a new idea or import an existing app there.
        </p>
      </div>

      <div className="mt-12 border-t border-border/60 pt-6">
        {!showCohort ? (
          <button
            type="button"
            onClick={() => setShowCohort(true)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={false}
            aria-controls="cohort-form"
          >
            Have a cohort code? Add it here.
          </button>
        ) : (
          <form onSubmit={join} className="space-y-3" id="cohort-form" aria-label="Join a cohort">
            <label
              htmlFor="cohort-code"
              className="block text-xs uppercase tracking-widest text-muted-foreground"
            >
              Cohort code
            </label>
            <input
              id="cohort-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="PUSHTEN1"
              autoComplete="off"
              className="w-full max-w-sm rounded-md border border-border bg-surface-1 px-4 py-2.5 font-mono text-sm tracking-widest text-foreground outline-none transition-colors focus:border-primary"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-md border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
              >
                {loading ? "Joining…" : "Join cohort"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCohort(false);
                  setError(null);
                }}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
