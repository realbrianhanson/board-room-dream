import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, Check, Loader2, Lock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/project/$projectId")({
  component: ProjectJourneyPage,
});

// The guided single-path project experience. One page, one obvious next action.
// Everything a non-technical owner needs to know: where they are, what's done,
// and the single button to press next. The heavier stage screens (boardroom,
// design, runway, audits) are reached THROUGH this page, never hunted for.

type Ctx = {
  id: string;
  name: string;
  status: string;
  isImport: boolean;
  githubRepo: string | null;
  currentBatchNo: number;
  hasPlan: boolean;
  hasDesign: boolean;
  hasBatches: boolean;
  batchesTotal: number;
  batchesDone: number;
  hasFixNeeded: boolean;
  allPassed: boolean;
  hasFinalAudit: boolean;
  intakeId: string | null;
  intakeVerdict: string | null;
  // Which stage kinds currently have a run in flight (so we show "working…").
  runningKinds: Set<string>;
};

type StepState = "done" | "current" | "todo";
type Step = {
  key: string;
  title: string;
  blurb: string;
  state: StepState;
  // The action for the current step.
  ctaLabel?: string;
  onGo?: () => void;
  working?: string | null; // if set, the stage is running — show this instead of a button
  reviewLabel?: string; // shown on done steps
  onReview?: () => void;
};

function ProjectJourneyPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [{ data: p }, { data: pvs }, { data: bs }, { data: au }, { data: intake }, { data: runs }] =
      await Promise.all([
        supabase.from("projects").select("id, name, status, is_import, github_repo, current_batch_no").eq("id", projectId).maybeSingle(),
        supabase.from("plan_versions").select("kind").eq("project_id", projectId),
        supabase.from("batches").select("batch_no, status").eq("project_id", projectId),
        supabase.from("audits").select("kind, status").eq("project_id", projectId).eq("kind", "final_az"),
        supabase.from("intakes").select("id, verdict").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("boardroom_runs").select("kind, status").eq("project_id", projectId).in("status", ["queued", "running"]),
      ]);
    if (!p) { setLoading(false); return; }
    const kinds = new Set((pvs ?? []).map((r: any) => r.kind));
    const batchList = (bs ?? []) as Array<{ batch_no: number; status: string }>;
    const done = batchList.filter((b) => b.status === "passed" || b.status === "skipped").length;
    const runningKinds = new Set(((runs ?? []) as Array<{ kind: string }>).map((r) => r.kind));
    setCtx({
      id: p.id,
      name: p.name,
      status: p.status,
      isImport: !!(p as any).is_import,
      githubRepo: (p as any).github_repo ?? null,
      currentBatchNo: (p as any).current_batch_no ?? 0,
      hasPlan: kinds.has("plan"),
      hasDesign: kinds.has("design"),
      hasBatches: batchList.length > 0,
      batchesTotal: batchList.length,
      batchesDone: done,
      hasFixNeeded: batchList.some((b) => b.status === "fix_needed"),
      allPassed: batchList.length > 0 && batchList.every((b) => b.status === "passed" || b.status === "skipped"),
      hasFinalAudit: (au ?? []).some((a: any) => a.status === "clean") || p.status === "done",
      intakeId: intake?.id ?? null,
      intakeVerdict: (intake as any)?.verdict ?? null,
      runningKinds,
    });
    setLoading(false);
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: keep the journey current as runs progress and stages complete.
  useEffect(() => {
    const ch = supabase
      .channel(`journey:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "boardroom_runs", filter: `project_id=eq.${projectId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_versions", filter: `project_id=eq.${projectId}` }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "batches", filter: `project_id=eq.${projectId}` }, () => load())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${projectId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [projectId, load]);

  if (loading) {
    return <div className="mx-auto max-w-3xl px-6 py-16"><div className="h-64 animate-pulse rounded-2xl bg-surface-1" /></div>;
  }
  if (!ctx) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p className="font-display text-2xl text-foreground">We couldn't find that project.</p>
        <Link to="/dashboard" className="mt-4 inline-flex items-center gap-2 text-sm text-primary">← Back to your projects</Link>
      </div>
    );
  }

  const go = (to: string, params: Record<string, string>) => navigate({ to: to as any, params: params as any });
  const steps = buildSteps(ctx, go);
  const currentIdx = steps.findIndex((s) => s.state === "current");
  const current = currentIdx >= 0 ? steps[currentIdx] : null;
  const allDone = currentIdx === -1;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 md:py-14">
      <Link to="/dashboard" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
        ← My projects
      </Link>
      <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{ctx.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {allDone ? "Every step is done. Nicely done." : "Here's exactly where you are — just do the highlighted step."}
      </p>

      {/* The one thing to do now */}
      {current && (
        <div className="mt-8 rounded-2xl border border-primary/40 bg-primary/[0.06] p-6 md:p-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(38_65%_72%)]">Do this next</p>
          <h2 className="mt-2 font-display text-2xl text-foreground md:text-3xl">{current.title}</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-foreground/85">{current.blurb}</p>
          {current.working ? (
            <div className="mt-5 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-background/40 px-4 py-3 text-sm text-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-[hsl(38_65%_70%)]" />
              {current.working}
            </div>
          ) : (
            <button
              onClick={current.onGo}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-base font-medium text-primary-foreground shadow-lg transition-all hover:brightness-110"
            >
              {current.ctaLabel} <ArrowRight className="h-5 w-5" />
            </button>
          )}
        </div>
      )}

      {allDone && (
        <div className="mt-8 rounded-2xl border border-[hsl(160_45%_48%/0.4)] bg-[hsl(160_45%_28%/0.12)] p-8 text-center">
          <Check className="mx-auto h-8 w-8 text-[hsl(160_45%_62%)]" />
          <h2 className="mt-3 font-display text-2xl text-foreground">Your app is built and checked.</h2>
          <p className="mt-2 text-sm text-muted-foreground">Open your build steps any time to review or make changes.</p>
        </div>
      )}

      {/* The full path, so they always feel oriented */}
      <div className="mt-10">
        <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Your path</p>
        <ol className="space-y-2.5">
          {steps.map((s, i) => (
            <li
              key={s.key}
              className={`flex items-start gap-4 rounded-xl border p-4 transition-colors ${
                s.state === "current"
                  ? "border-primary/40 bg-primary/[0.04]"
                  : s.state === "done"
                  ? "border-border bg-surface-1"
                  : "border-border/50 bg-surface-1/40"
              }`}
            >
              <div
                className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] ${
                  s.state === "done"
                    ? "bg-[hsl(160_45%_48%/0.2)] text-[hsl(160_45%_65%)]"
                    : s.state === "current"
                    ? "bg-primary/20 text-[hsl(38_65%_72%)]"
                    : "bg-surface-2 text-muted-foreground"
                }`}
              >
                {s.state === "done" ? <Check className="h-4 w-4" /> : s.state === "todo" ? <Lock className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`font-display text-base ${s.state === "todo" ? "text-muted-foreground" : "text-foreground"}`}>{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.blurb}</p>
                {s.state === "done" && s.reviewLabel && (
                  <button onClick={s.onReview} className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    {s.reviewLabel} <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>
              {s.state === "current" && !s.working && (
                <span className="mt-1 shrink-0 font-mono text-[9px] uppercase tracking-[0.22em] text-[hsl(38_65%_72%)]">You're here</span>
              )}
              {s.state === "current" && s.working && (
                <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-[hsl(38_65%_70%)]" />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// Build the ordered step list with state + the single next action. Greenfield
// and imported apps have slightly different paths; both end at "ship".
function buildSteps(ctx: Ctx, go: (to: string, params: Record<string, string>) => void): Step[] {
  const boardroom = () => go("/boardroom/$projectId", { projectId: ctx.id });
  const design = () => go("/design/$projectId", { projectId: ctx.id });
  const runway = () => go("/runway/$projectId", { projectId: ctx.id });
  const audits = () => go("/audits/$projectId", { projectId: ctx.id });
  const plan = () => go("/plan/$projectId", { projectId: ctx.id });
  const intake = () => (ctx.intakeId ? go("/intake/$intakeId", { intakeId: ctx.intakeId }) : go("/dashboard", {}));

  const planRunning = ctx.runningKinds.has("plan");
  const designRunning = ctx.runningKinds.has("design");
  const batchesRunning = ctx.runningKinds.has("batches");
  const auditRunning = ctx.runningKinds.has("audit");

  const raw: Array<Omit<Step, "state">> = [];

  if (ctx.isImport) {
    raw.push({
      key: "import", title: "Your existing app", blurb: "You brought an app you've already built. The board will review it and help you make it better.",
      reviewLabel: undefined,
    });
    raw.push({
      key: "audit", title: "Health check", blurb: "The four AI experts read your app's code and find what's broken, risky, or missing.",
      ctaLabel: ctx.githubRepo ? "Have the board read my app" : "Connect your app, then run the check", onGo: audits,
      working: auditRunning ? "The board is reading your code…" : null,
      reviewLabel: "See what they found", onReview: audits,
    });
    raw.push({
      key: "plan", title: "Improvement plan", blurb: "The board agrees on exactly what to fix and build next, ranked by what matters most.",
      ctaLabel: "Build my improvement plan", onGo: boardroom,
      working: planRunning ? "The board is meeting… this takes a little while. You can close this and come back." : null,
      reviewLabel: "Read your plan", onReview: plan,
    });
  } else {
    raw.push({
      key: "idea", title: "Your idea", blurb: "Answer a few plain questions about what you want to build and who it's for.",
      ctaLabel: "Tell us your idea", onGo: intake,
      reviewLabel: "Review your idea", onReview: intake,
    });
    raw.push({
      key: "plan", title: "The plan", blurb: "Four AI experts debate your idea and agree on exactly what to build. Takes about 15 minutes — you can close this and come back.",
      ctaLabel: "Start the board meeting", onGo: boardroom,
      working: planRunning ? "The board is meeting… you can close this and come back." : null,
      reviewLabel: "Read your plan", onReview: plan,
    });
  }

  raw.push({
    key: "design", title: "The look & feel", blurb: "The board designs how your app looks — colors, fonts, and style — so it feels premium, not generic.",
    ctaLabel: "Design the look", onGo: design,
    working: designRunning ? "The board is designing…" : null,
    reviewLabel: "See the design", onReview: design,
  });
  raw.push({
    key: "steps", title: "Your build checklist", blurb: "The board turns the plan into a simple numbered list of build steps — the exact prompts you'll paste in.",
    ctaLabel: "Get my build steps", onGo: runway,
    working: batchesRunning ? "The board is writing your build steps…" : null,
    reviewLabel: "Open my build steps", onReview: runway,
  });
  raw.push({
    key: "build",
    title: "Build it, step by step",
    blurb: ctx.batchesTotal
      ? `Copy each step into Lovable, one at a time — the board checks each one before you move on. ${ctx.batchesDone} of ${ctx.batchesTotal} done.`
      : "Copy each step into Lovable, one at a time. The board checks each one before you move on.",
    ctaLabel: ctx.hasFixNeeded ? "The board found a fix — do it next" : "Build the next step", onGo: runway,
    reviewLabel: "Open my build steps", onReview: runway,
  });
  raw.push({
    key: "ship", title: "Final check & ship", blurb: "The board reads your whole finished app one last time and confirms it's ready to launch.",
    ctaLabel: "Run the final check", onGo: audits,
    working: auditRunning ? "The board is doing the final review…" : null,
    reviewLabel: "See the final report", onReview: audits,
  });

  // Determine done/current/todo per step from the project's real state.
  const isDone: Record<string, boolean> = {
    import: true,
    idea: ctx.hasPlan || (ctx.status !== "intake" && ctx.intakeVerdict === "pass"),
    audit: ctx.hasFinalAudit || ctx.hasPlan, // once they've moved to planning, the first health check is behind them
    plan: ctx.hasPlan,
    design: ctx.hasDesign,
    steps: ctx.hasBatches,
    build: ctx.allPassed,
    ship: ctx.hasFinalAudit,
  };

  let currentAssigned = false;
  return raw.map((s) => {
    const done = !!isDone[s.key];
    let state: StepState;
    if (done) state = "done";
    else if (!currentAssigned) { state = "current"; currentAssigned = true; }
    else state = "todo";
    return { ...s, state };
  });
}
