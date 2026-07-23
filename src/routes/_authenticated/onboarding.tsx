import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, Lightbulb, Package } from "lucide-react";
import { markCohortSkipped, clearCohortSkipped } from "@/lib/onboarding";

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
      clearCohortSkipped(localStorage);
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function go(mode: "idea" | "import") {
    // Preserve skip marker so the onboarding never re-nags.
    markCohortSkipped(localStorage);
    navigate({ to: "/dashboard", search: { new: mode } });
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Welcome to App Blueprint
      </span>
      <h1 className="mt-4 font-display text-4xl leading-tight text-foreground md:text-5xl">
        Pick where to start.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
        Bring code the Boardroom can read for immediate repo evidence, or an
        idea worth pressure-testing with a focused intake. Either way you leave
        with an evidence-backed Blueprint and safer step-by-step Lovable prompts.
      </p>


      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <button
          type="button"
          onClick={() => go("import")}
          className="group flex h-full flex-col items-start rounded-xl border border-border bg-surface-1 p-6 text-left transition-colors hover:border-primary/50"
          data-testid="onboarding-audit-existing"
        >
          <Package className="mb-3 h-5 w-5 text-primary" />
          <h2 className="font-display text-xl text-foreground">Audit an existing app</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Link the repo. The board reads real code first, then helps you decide what to fix or build next.
          </p>
          <span className="mt-5 inline-flex items-center gap-1.5 text-sm text-foreground/85 group-hover:text-primary">
            Import a project <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </button>
        <button
          type="button"
          onClick={() => go("idea")}
          className="group flex h-full flex-col items-start rounded-xl border border-border bg-surface-1 p-6 text-left transition-colors hover:border-primary/50"
          data-testid="onboarding-blueprint-idea"
        >
          <Lightbulb className="mb-3 h-5 w-5 text-primary" />
          <h2 className="font-display text-xl text-foreground">Blueprint a new idea</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Answer five short prompts. The board scores it, debates it, and locks a plan you can build.
          </p>
          <span className="mt-5 inline-flex items-center gap-1.5 text-sm text-foreground/85 group-hover:text-primary">
            Start the intake <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </button>
      </div>

      <div className="mt-10 border-t border-border/60 pt-6">
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
        <p className="mt-6 text-xs text-muted-foreground">
          Not sure yet? <Link to="/dashboard" className="underline hover:text-foreground">Go straight to your dashboard</Link>.
        </p>
      </div>
    </div>
  );
}
