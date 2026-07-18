import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const trimmed = code.trim();
      if (!trimmed) throw new Error("Enter a cohort code.");
      const { data: cohort, error: findErr } = await supabase
        .from("cohorts")
        .select("id")
        .eq("join_code", trimmed)
        .maybeSingle();
      if (findErr) throw findErr;
      if (!cohort) throw new Error("That code doesn't match a cohort.");
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error("Not signed in.");
      const { error: updErr } = await supabase
        .from("profiles")
        .update({ cohort_id: cohort.id })
        .eq("id", user.user.id);
      if (updErr) throw updErr;
      localStorage.removeItem("boardroom.cohort_skipped");
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function skip() {
    localStorage.setItem("boardroom.cohort_skipped", "1");
    navigate({ to: "/dashboard" });
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Onboarding · Step 1 of 1
      </span>
      <h1 className="mt-4 font-display text-4xl leading-tight text-foreground md:text-5xl">
        Which cohort are you with?
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Your cohort code unlocks shared materials and puts you in front of your
        instructor. You can always add it later from Settings.
      </p>

      <form onSubmit={join} className="mt-8 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
            Cohort code
          </label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="PUSHTEN1"
            className="w-full rounded-md border border-border bg-surface-1 px-4 py-3 font-mono text-sm tracking-widest text-foreground outline-none transition-colors focus:border-primary"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
          >
            {loading ? "Joining…" : "Join cohort"}
          </button>
          <button
            type="button"
            onClick={skip}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip for now
          </button>
        </div>
      </form>
    </div>
  );
}
