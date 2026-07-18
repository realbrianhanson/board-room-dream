import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Lock,
  Palette,
  Rocket,
  SkipForward,
  X,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/runway/$projectId")({
  component: RunwayPage,
});

type Project = {
  id: string;
  name: string;
  user_id: string;
  status: string;
  lovable_project_url: string | null;
  current_batch_no: number;
};

type Batch = {
  id: string;
  batch_no: number;
  title: string;
  channel: "lovable" | "supabase" | "human";
  prompt_md: string;
  status: "pending" | "sent" | "built" | "auditing" | "fix_needed" | "passed" | "skipped";
  is_fix: boolean;
  sent_at: string | null;
  built_at: string | null;
};

type Run = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
};

const ROLLBACK_PROMPT = `The last change broke the app. Do not add features. Diagnose and repair only. Identify what changed in the last step and what errors appear in build/preview/logs. Fix the regression and nothing else. Return a summary of the root cause and the repair.`;

const CHANNEL_STYLE: Record<Batch["channel"], { chip: string; label: string }> = {
  lovable: { chip: "bg-primary/15 text-[hsl(38_65%_72%)] border-primary/30", label: "Lovable" },
  supabase: { chip: "bg-[hsl(205_60%_55%/0.15)] text-[hsl(205_60%_75%)] border-[hsl(205_60%_55%/0.35)]", label: "Supabase" },
  human: { chip: "bg-surface-2 text-muted-foreground border-border", label: "Human" },
};

const STATUS_STYLE: Record<Batch["status"], { chip: string; label: string }> = {
  pending:    { chip: "bg-surface-2 text-muted-foreground border-border", label: "Pending" },
  sent:       { chip: "bg-primary/15 text-[hsl(38_65%_72%)] border-primary/30", label: "Sent" },
  built:      { chip: "bg-[hsl(205_60%_55%/0.15)] text-[hsl(205_60%_75%)] border-[hsl(205_60%_55%/0.35)]", label: "Built" },
  auditing:   { chip: "bg-[hsl(205_60%_55%/0.15)] text-[hsl(205_60%_75%)] border-[hsl(205_60%_55%/0.35)]", label: "Auditing" },
  fix_needed: { chip: "bg-[hsl(8_60%_55%/0.15)] text-[hsl(8_60%_75%)] border-[hsl(8_60%_55%/0.35)]", label: "Fix needed" },
  passed:     { chip: "bg-[hsl(160_45%_48%/0.15)] text-[hsl(160_45%_65%)] border-[hsl(160_45%_48%/0.35)]", label: "Passed" },
  skipped:    { chip: "bg-surface-2 text-muted-foreground border-border", label: "Skipped" },
};

function isTerminal(s: Batch["status"]) {
  return s === "passed" || s === "skipped";
}

function MiniRing({ fill, color = "hsl(38 65% 55%)", size = 22 }: { fill: number; color?: string; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="hsl(40 15% 24% / 0.5)" strokeWidth="2" />
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none" stroke={color} strokeWidth="2"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, fill)))}
        strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`}
      />
    </svg>
  );
}

function RunwayPage() {
  const { projectId } = Route.useParams();
  const [uid, setUid] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [hasPlan, setHasPlan] = useState<boolean | null>(null);
  const [hasDesign, setHasDesign] = useState<boolean>(false);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [generating, setGenerating] = useState(false);
  const [urlEdit, setUrlEdit] = useState("");
  const [showRollback, setShowRollback] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState<Batch | null>(null);

  const loadAll = useCallback(async () => {
    const [{ data: p }, { data: pv }, { data: dv }, { data: bs }, { data: rs }] = await Promise.all([
      supabase.from("projects").select("id, name, user_id, status, lovable_project_url, current_batch_no").eq("id", projectId).maybeSingle(),
      supabase.from("plan_versions").select("id").eq("project_id", projectId).eq("kind", "plan").limit(1),
      supabase.from("plan_versions").select("id").eq("project_id", projectId).eq("kind", "design").limit(1),
      supabase.from("batches").select("*").eq("project_id", projectId).order("batch_no", { ascending: true }),
      supabase.from("boardroom_runs").select("id, kind, status, error").eq("project_id", projectId).eq("kind", "batches").order("created_at", { ascending: false }).limit(1),
    ]);
    setProject((p as Project) ?? null);
    setHasPlan(((pv ?? []).length ?? 0) > 0);
    setHasDesign(((dv ?? []).length ?? 0) > 0);
    setBatches((bs ?? []) as Batch[]);
    setRun(((rs ?? [])[0] as Run) ?? null);
    if (p && !urlEdit) setUrlEdit((p as Project).lovable_project_url ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => { (async () => {
    const { data: u } = await supabase.auth.getUser();
    setUid(u.user?.id ?? null);
    await loadAll();
  })(); }, [loadAll]);

  useEffect(() => {
    const ch = supabase
      .channel(`runway:${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "batches", filter: `project_id=eq.${projectId}` }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "boardroom_runs", filter: `project_id=eq.${projectId}` }, () => loadAll())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${projectId}` }, () => loadAll())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [projectId, loadAll]);

  const isOwner = !!project && !!uid && project.user_id === uid;
  const runInFlight = run && ["queued", "running"].includes(run.status);

  const passedCount = useMemo(() => (batches ?? []).filter((b) => b.status === "passed").length, [batches]);
  const total = (batches ?? []).length;
  const activeIdx = useMemo(
    () => (batches ?? []).findIndex((b) => !isTerminal(b.status)),
    [batches],
  );

  async function generate() {
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("boardroom-orchestrator", {
        body: { action: "start_run", project_id: projectId, kind: "batches" },
      });
      if (error) throw error;
      if ((data as any)?.no_key) {
        toast.error("Seat the board first — add your OpenRouter key in Settings.");
        return;
      }
      toast.success("The Chair is sequencing your build…");
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to start");
    } finally {
      setGenerating(false);
    }
  }

  async function saveLovableUrl() {
    const val = urlEdit.trim();
    const { error } = await supabase
      .from("projects")
      .update({ lovable_project_url: val || null })
      .eq("id", projectId);
    if (error) { toast.error(error.message); return; }
    toast.success("Saved.");
    loadAll();
  }

  async function advance(b: Batch, next: Batch["status"]) {
    const patch: any = { status: next };
    if (next === "sent") patch.sent_at = new Date().toISOString();
    if (next === "built") patch.built_at = new Date().toISOString();
    const { error } = await supabase.from("batches").update(patch).eq("id", b.id);
    if (error) { toast.error(error.message); return; }
    if (next === "passed") {
      const nextNo = (batches ?? []).find((x) => x.batch_no > b.batch_no && !isTerminal(x.status))?.batch_no;
      if (nextNo) await supabase.from("projects").update({ current_batch_no: Math.floor(nextNo) }).eq("id", projectId);
      else await supabase.from("projects").update({ current_batch_no: b.batch_no, status: "auditing" }).eq("id", projectId);
    }
    loadAll();
  }

  async function copy(text: string, msg = "Copied.") {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(msg);
    } catch {
      toast.error("Clipboard blocked.");
    }
  }

  if (!project || hasPlan === null || batches === null) {
    return <div className="mx-auto max-w-6xl px-6 py-14"><div className="h-32 animate-pulse rounded-xl bg-surface-1" /></div>;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/runway" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
            ← Runway
          </Link>
          <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{project.name}</h1>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">The Build Runway</p>
        </div>
        {total > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-1 px-4 py-2">
            <MiniRing fill={total ? passedCount / total : 0} size={26} />
            <p className="font-mono text-xs text-foreground">
              <span className="text-foreground">{passedCount}</span>
              <span className="text-muted-foreground"> of {total} passed</span>
            </p>
          </div>
        )}
      </div>

      {/* State A: no locked plan */}
      {!hasPlan && (
        <EmptyState
          icon={<Lock className="h-6 w-6 text-muted-foreground" />}
          title="The board locks the plan before it sequences the build."
          subtitle="Take this project through the Boardroom first."
          actionTo="/boardroom/$projectId"
          actionParams={{ projectId }}
          actionLabel="To the Boardroom"
        />
      )}

      {/* State B: locked plan, no batches, no run */}
      {hasPlan && total === 0 && !runInFlight && (
        <div className="rounded-xl border border-border bg-surface-1 p-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(38_65%_70%)]">The Chair, ready to sequence</p>
          <h2 className="mt-3 font-display text-3xl text-foreground">Turn the locked plan into a build sequence.</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            The Chair drafts 6–14 numbered batches you paste into Lovable, one at a time. Each batch stays small enough to ship cleanly.
          </p>

          {!hasDesign && (
            <div className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-surface-2 p-4">
              <Palette className="mt-0.5 h-4 w-4 text-[hsl(38_65%_70%)]" />
              <div className="flex-1">
                <p className="text-sm text-foreground">Convene the Design Council first so Batch 1 installs your design system.</p>
                <Link
                  to="/design/$projectId" params={{ projectId }}
                  className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.24em] text-[hsl(38_65%_72%)] hover:brightness-125"
                >
                  Convene the council <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          )}

          {isOwner && (
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                onClick={generate}
                disabled={generating || !hasDesign}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
              >
                <Rocket className="h-4 w-4" /> {generating ? "Convening…" : "Generate the build sequence"}
              </button>
              {!hasDesign && (
                <button
                  onClick={generate}
                  disabled={generating}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-5 py-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-60"
                >
                  Generate anyway
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* State C: generation in flight */}
      {hasPlan && total === 0 && runInFlight && (
        <div className="rounded-xl border border-border bg-surface-1 p-8 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <p className="font-display text-2xl text-foreground">The Chair is sequencing your build…</p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Status · {run?.status}
          </p>
        </div>
      )}

      {/* State C: generation failed with no batches */}
      {hasPlan && total === 0 && run && run.status === "failed" && (
        <div className="mt-4 rounded-xl border border-[hsl(8_60%_55%/0.4)] bg-[hsl(8_60%_25%/0.15)] p-6">
          <p className="flex items-center gap-2 font-mono text-xs text-[hsl(8_60%_75%)]"><AlertTriangle className="h-4 w-4" /> The Chair couldn't finish.</p>
          <p className="mt-2 text-sm text-foreground/85">{run.error ?? "Unknown error"}</p>
          {isOwner && (
            <button
              onClick={generate}
              disabled={generating}
              className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:opacity-60"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {/* State D: THE RUNWAY */}
      {total > 0 && (
        <div className="space-y-4">
          {/* Lovable URL editor */}
          {isOwner && (
            <div className="rounded-xl border border-border bg-surface-1 p-5">
              <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                Your Lovable project URL
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  value={urlEdit}
                  onChange={(e) => setUrlEdit(e.target.value)}
                  placeholder="https://lovable.dev/projects/…"
                  className="flex-1 min-w-[240px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <button
                  onClick={saveLovableUrl}
                  className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
                >
                  Save
                </button>
                {project.lovable_project_url && (
                  <a
                    href={project.lovable_project_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
                  >
                    Open <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          )}

          {batches!.map((b, i) => (
            <BatchCard
              key={b.id}
              batch={b}
              active={i === activeIdx}
              locked={activeIdx !== -1 && i > activeIdx}
              activeBatchNo={activeIdx !== -1 ? (batches![activeIdx].batch_no) : null}
              isOwner={isOwner}
              lovableUrl={project.lovable_project_url}
              onCopyPrompt={() => copy(b.prompt_md, "Paste it into Lovable and let it build.")}
              onAdvance={(next) => advance(b, next)}
              onOpenRollback={() => setShowRollback(true)}
              onRequestSkip={() => setShowSkipConfirm(b)}
            />
          ))}
        </div>
      )}

      {/* Rollback modal */}
      {showRollback && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-6"
          onClick={() => setShowRollback(false)}
        >
          <div
            className="relative w-full max-w-2xl rounded-xl border border-border bg-surface-1 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowRollback(false)}
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(8_60%_75%)]">Standing rollback prompt</p>
            <h3 className="mt-2 font-display text-2xl text-foreground">Something broke?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Paste this into Lovable to make it diagnose and repair — no new features.
            </p>
            <pre className="mt-4 max-h-72 overflow-auto rounded-lg border border-border bg-background p-4 font-mono text-[12px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
{ROLLBACK_PROMPT}
            </pre>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => copy(ROLLBACK_PROMPT, "Copied — paste it into Lovable.")}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
              >
                <Copy className="h-4 w-4" /> Copy rollback prompt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Skip confirm */}
      {showSkipConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-6"
          onClick={() => setShowSkipConfirm(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-xl text-foreground">Skip Batch {showSkipConfirm.batch_no}?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              "{showSkipConfirm.title}" won't ship. Later batches may still depend on it.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowSkipConfirm(null)}
                className="rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={async () => { const b = showSkipConfirm; setShowSkipConfirm(null); await advance(b, "skipped"); }}
                className="rounded-md bg-[hsl(8_60%_45%)] px-4 py-2 text-sm font-medium text-foreground hover:brightness-110"
              >
                Skip it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({
  icon, title, subtitle, actionTo, actionParams, actionLabel,
}: {
  icon: React.ReactNode; title: string; subtitle: string;
  actionTo: string; actionParams: Record<string, string>; actionLabel: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-20 text-center">
      <div className="mx-auto flex justify-center">{icon}</div>
      <p className="mt-4 font-display text-2xl text-foreground">{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      <Link
        // @ts-expect-error dynamic route string
        to={actionTo}
        params={actionParams}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
      >
        {actionLabel} <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function BatchCard({
  batch, active, locked, activeBatchNo, isOwner, lovableUrl,
  onCopyPrompt, onAdvance, onOpenRollback, onRequestSkip,
}: {
  batch: Batch;
  active: boolean;
  locked: boolean;
  activeBatchNo: number | null;
  isOwner: boolean;
  lovableUrl: string | null;
  onCopyPrompt: () => void;
  onAdvance: (next: Batch["status"]) => void;
  onOpenRollback: () => void;
  onRequestSkip: () => void;
}) {
  const ch = CHANNEL_STYLE[batch.channel];
  const st = STATUS_STYLE[batch.status];
  const isPassed = batch.status === "passed";
  const isSkipped = batch.status === "skipped";

  // Progress fill for the mini ring per status.
  const fill =
    batch.status === "pending" ? 0 :
    batch.status === "sent" ? 0.33 :
    batch.status === "built" ? 0.66 :
    batch.status === "auditing" ? 0.75 :
    batch.status === "fix_needed" ? 0.66 :
    1;
  const ringColor = batch.status === "fix_needed"
    ? "hsl(8 60% 55%)"
    : isPassed || batch.status === "auditing" ? "hsl(160 45% 48%)"
    : "hsl(38 65% 55%)";

  return (
    <div
      className={`rounded-xl border bg-surface-1 transition-all ${
        active ? "border-primary/50 shadow-[0_0_0_1px_hsl(38_65%_55%/0.15),0_20px_60px_-20px_hsl(38_65%_55%/0.25)]"
        : isPassed ? "border-[hsl(160_45%_48%/0.35)] opacity-90"
        : isSkipped ? "border-border opacity-60"
        : locked ? "border-border opacity-70"
        : "border-border"
      }`}
    >
      <div className="flex items-start gap-4 p-5">
        <MiniRing fill={fill} color={ringColor} size={30} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">Batch {batch.batch_no}</span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${ch.chip}`}>
              {ch.label}
            </span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${st.chip}`}>
              {st.label}
            </span>
          </div>
          <h3 className="mt-1.5 font-display text-lg text-foreground">{batch.title}</h3>
          {locked && activeBatchNo !== null && (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              Finish Batch {activeBatchNo} first
            </p>
          )}
        </div>
        {isPassed && <Check className="h-5 w-5 text-[hsl(160_45%_60%)]" />}
      </div>

      {active && (
        <div className="border-t border-border/60 p-5">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Prompt</p>
          <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-background p-4 font-mono text-[12px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
{batch.prompt_md}
          </pre>

          {isOwner && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={onCopyPrompt}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
              >
                <Copy className="h-4 w-4" /> Copy prompt
              </button>
              {lovableUrl ? (
                <a
                  href={lovableUrl}
                  target="_blank" rel="noreferrer noopener"
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
                >
                  Open your Lovable project <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-4 py-2 text-xs text-muted-foreground">
                  Save your Lovable URL above to open it here
                </span>
              )}

              {/* Channel-specific advance controls */}
              {batch.channel === "human" ? (
                <>
                  {batch.status !== "passed" && batch.status !== "skipped" && (
                    <button
                      onClick={() => onAdvance("passed")}
                      className="inline-flex items-center gap-2 rounded-md border border-[hsl(160_45%_48%/0.5)] bg-[hsl(160_45%_28%/0.3)] px-4 py-2 text-sm text-foreground transition-colors hover:brightness-110"
                    >
                      <Check className="h-4 w-4" /> Mark done
                    </button>
                  )}
                  {batch.status !== "passed" && batch.status !== "skipped" && (
                    <button
                      onClick={onRequestSkip}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      <SkipForward className="h-4 w-4" /> Skip
                    </button>
                  )}
                </>
              ) : (
                <>
                  {batch.status === "pending" && (
                    <button
                      onClick={() => onAdvance("sent")}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
                    >
                      Mark sent
                    </button>
                  )}
                  {batch.status === "sent" && (
                    <button
                      onClick={() => onAdvance("built")}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
                    >
                      Mark built
                    </button>
                  )}
                  {batch.status === "built" && (
                    <>
                      <span className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
                        Code audit arrives in a later batch
                      </span>
                      <button
                        onClick={() => onAdvance("passed")}
                        className="inline-flex items-center gap-2 rounded-md border border-[hsl(160_45%_48%/0.5)] bg-[hsl(160_45%_28%/0.3)] px-4 py-2 text-sm text-foreground transition-colors hover:brightness-110"
                      >
                        <Check className="h-4 w-4" /> Mark passed
                      </button>
                    </>
                  )}
                  {batch.status === "fix_needed" && (
                    <button
                      onClick={() => onAdvance("passed")}
                      className="inline-flex items-center gap-2 rounded-md border border-[hsl(160_45%_48%/0.5)] bg-[hsl(160_45%_28%/0.3)] px-4 py-2 text-sm text-foreground transition-colors hover:brightness-110"
                    >
                      <Check className="h-4 w-4" /> Mark passed
                    </button>
                  )}
                </>
              )}

              <button
                onClick={onOpenRollback}
                className="ml-auto text-xs text-muted-foreground underline underline-offset-4 hover:text-[hsl(8_60%_75%)]"
              >
                Something broke?
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
