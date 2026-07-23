import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AlertTriangle, KeyRound, Pause, Play, RotateCcw, Users2 } from "lucide-react";

export type Seat = "chair" | "strategist" | "contrarian" | "inspector";
const SEAT_ORDER: Seat[] = ["chair", "strategist", "contrarian", "inspector"];

const SEAT_META: Record<Seat, { label: string; hue: string; initials: string }> = {
  chair: { label: "The Chair", hue: "38 65% 55%", initials: "CH" },
  strategist: { label: "The Strategist", hue: "205 60% 55%", initials: "ST" },
  contrarian: { label: "The Contrarian", hue: "350 55% 52%", initials: "CO" },
  inspector: { label: "The Inspector", hue: "160 45% 48%", initials: "IN" },
};

export type SessionRun = {
  id: string;
  project_id: string;
  user_id: string;
  kind: string;
  status: string;
  round_no: number;
  budget_usd: number;
  spent_usd: number;
  budget_warning: boolean;
  consensus: { awaiting?: string } | null;
  founder_notes: string | null;
  error: string | null;
  created_at: string;
  constitution_version?: number | null;
};
export type SessionStep = {
  id: string;
  run_id: string;
  step_key: string;
  round: number;
  seat: Seat;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  response_text: string | null;
  response_json: any;
  error: string | null;
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
};
type SeatRow = { seat: Seat; display_name: string | null; model_id: string; enabled: boolean };

export type BoardroomSessionProps = {
  projectId: string;
  kind: "plan" | "design";
  rubric: readonly string[];
  conveneLabel: string;
  runningTitle: string;
  /** Reasons the "Convene" action is blocked, keyed by project.status. */
  conveneBlockedByStatus?: Record<string, string>;
  /** Extra guard applied on top of status. Return reason string when blocked, null otherwise. */
  extraConveneGate?: () => string | null;
  /** Rendered when no run exists yet. */
  emptyTitle: string;
  emptySubtitle: string;
  /** Card to render when a run has reached consensus / chair_ruled. Pass null to hide. */
  lockCard?: (run: SessionRun) => ReactNode;
  /** Whether to render the header row (title + status + controls). */
  showHeader?: boolean;
  /** Called after a run first becomes available. */
  onRunLoaded?: (run: SessionRun | null) => void;
  /** When true, all mutation UI (convene, pause/resume, retry) is hidden regardless of ownership. */
  readOnly?: boolean;
  /** Label used for the terminal-reconvene button on import projects. */
  reconveneImportLabel?: string;
  /**
   * When provided, a locked (consensus / chair_ruled) run whose owner-authority
   * artifact is not build-safe is treated as legacy: the lock card is hidden
   * and a legacy warning banner is rendered instead.
   */
  legacyRequiresSafeArtifact?: { hasSafeArtifact: boolean };
};

export function BoardroomSession(props: BoardroomSessionProps) {
  const {
    projectId,
    kind,
    rubric,
    conveneLabel,
    runningTitle,
    conveneBlockedByStatus,
    extraConveneGate,
    emptyTitle,
    emptySubtitle,
    lockCard,
    showHeader = true,
    onRunLoaded,
    readOnly = false,
    reconveneImportLabel,
    legacyRequiresSafeArtifact,
  } = props;

  const navigate = useNavigate();
  const [project, setProject] = useState<{ id: string; name: string; status: string; user_id: string } | null>(null);
  const [run, setRun] = useState<SessionRun | null>(null);
  const [steps, setSteps] = useState<SessionStep[]>([]);
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [convening, setConvening] = useState(false);
  // Distinguish load failure from empty. `runError` sticks until a successful
  // reload clears it; when we already have a run in memory a subsequent
  // failure is treated as a background/stale refresh (data stays on screen).
  const [runError, setRunError] = useState<string | null>(null);
  const [runStale, setRunStale] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const consensusPulseRef = useRef<HTMLDivElement | null>(null);

  const loadSteps = useCallback(async (runId: string) => {
    const { data, error } = await supabase
      .from("run_steps")
      .select("id, run_id, step_key, round, seat, status, response_text, response_json, error, cost_usd, created_at, completed_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (error) {
      // Preserve last good steps on failure; surface via stale banner.
      setRunError(error.message);
      setRunStale(true);
      return;
    }
    setSteps((data ?? []) as SessionStep[]);
  }, []);

  const loadRun = useCallback(async (): Promise<SessionRun | null> => {
    const { data, error } = await supabase
      .from("boardroom_runs")
      .select("*")
      .eq("project_id", projectId)
      .eq("kind", kind)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      setRunError(error.message);
      // Only mark stale when we have a run already loaded — otherwise this is
      // an initial load failure and must render as an explicit error state,
      // never as an empty "Preparing…" placeholder.
      setRunStale((prev) => (run ? true : prev));
      return run;
    }
    setRunError(null);
    setRunStale(false);
    setRun((data as SessionRun) ?? null);
    if (data) await loadSteps(data.id);
    onRunLoaded?.((data as SessionRun) ?? null);
    return (data as SessionRun) ?? null;
  }, [projectId, kind, loadSteps, onRunLoaded, run]);






  const loadProject = useCallback(async () => {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const { data: proj, error: pErr } = await supabase
      .from("projects")
      .select("id, name, status, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (pErr) {
      // Explicit project-load failure: surface via runError so the UI renders
      // an accessible retry card instead of hanging on the skeleton or
      // silently degrading to "preparing…". Preserve any last-good project
      // on a background refresh failure.
      setRunError(pErr.message);
      setRunStale((prev) => (project ? true : prev));
      return { proj: null as null, uid };
    }
    if (!proj) {
      toast.error("Project not found");
      setRunError("Project not found");
      return { proj: null as null, uid };
    }
    setProject(proj);
    setIsOwner(!readOnly && !!uid && uid === proj.user_id);
    return { proj, uid };
  }, [projectId, readOnly, project]);

  const retryLoad = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { proj } = await loadProject();
      if (proj) await loadRun();
    } finally {
      setRetrying(false);
    }
  }, [loadRun, loadProject, retrying]);


  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { proj, uid } = await loadProject();
      if (cancelled) return;
      if (!proj) return;

      const { data: seatRows } = await supabase
        .from("model_registry_public")
        .select("seat, display_name, model_id, enabled")
        .in("seat", ["chair", "strategist", "contrarian", "inspector"]);
      if (!cancelled) setSeats((seatRows ?? []) as SeatRow[]);

      if (uid && uid === proj.user_id) {
        const { data: keyRes } = await supabase.functions.invoke("key-vault", { body: { action: "list" } });
        if (!cancelled) {
          const rows: Array<{ provider: string; status: string }> = keyRes?.keys ?? [];
          const or = rows.find((k) => k.provider === "openrouter");
          setHasKey(!!or && or.status !== "invalid");
        }
      }
      await loadRun();
    })();
    return () => { cancelled = true; };
  }, [projectId, loadRun, loadProject]);

  useEffect(() => {
    const runsChannel = supabase
      .channel(`boardroom_runs:${kind}:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "boardroom_runs", filter: `project_id=eq.${projectId}` },
        (payload) => {
          const next = payload.new as SessionRun;
          if (!next || next.kind !== kind) return;
          setRun((prev) => {
            if (!prev || prev.id === next.id || new Date(next.created_at) > new Date(prev.created_at)) return next;
            return prev;
          });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(runsChannel); };
  }, [projectId, kind]);

  useEffect(() => {
    if (!run?.id) return;
    const runId = run.id;
    const stepsChannel = supabase
      .channel(`run_steps:${runId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "run_steps", filter: `run_id=eq.${runId}` },
        () => { loadSteps(runId); },
      )
      .subscribe();
    return () => { supabase.removeChannel(stepsChannel); };
  }, [run?.id, loadSteps]);

  useEffect(() => {
    if (run?.status === "consensus" && consensusPulseRef.current) {
      const el = consensusPulseRef.current;
      el.classList.remove("consensus-pulse");
      void el.offsetWidth;
      el.classList.add("consensus-pulse");
    }
  }, [run?.status]);

  const seatMap = useMemo(() => {
    const m = new Map<Seat, SeatRow>();
    for (const s of seats) m.set(s.seat as Seat, s);
    return m;
  }, [seats]);

  const stepBySeat = useMemo(() => {
    const m = new Map<Seat, SessionStep>();
    for (const s of steps) if (SEAT_ORDER.includes(s.seat)) m.set(s.seat, s);
    return m;
  }, [steps]);

  const completedR1 = steps.filter((s) => s.round === 1 && s.status === "completed").length;
  const totalR1 = Math.max(4, steps.filter((s) => s.round === 1).length || 4);

  const segments = useMemo(() => {
    const voteSteps = steps.filter(
      (s) => s.round === 4 && s.status === "completed" && s.step_key.startsWith("r4_vote_"),
    );
    let latestLoop = -1;
    for (const v of voteSteps) {
      const m = /_loop(\d+)$/.exec(v.step_key);
      if (m) latestLoop = Math.max(latestLoop, Number(m[1]));
    }
    const latest = voteSteps.filter((v) => v.step_key.endsWith(`_loop${latestLoop}`));
    const bySeat = new Map<Seat, SessionStep>();
    for (const v of latest) bySeat.set(v.seat, v);
    // The Chair abstains on its own synthesis in current runs; legacy runs
    // include its vote. Size the ring to whoever actually votes.
    const votingOrder = SEAT_ORDER.filter((s) => s !== "chair" || bySeat.has("chair"));
    const out: Array<"empty" | "brass" | "oxblood"> = [];
    for (const seat of votingOrder) {
      const v = bySeat.get(seat);
      const scores = v?.response_json?.scores as Record<string, number> | undefined;
      for (const key of rubric) {
        if (!scores || typeof scores[key] !== "number") out.push("empty");
        else out.push(scores[key] >= 8 ? "brass" : "oxblood");
      }
    }
    return out;
  }, [steps, rubric]);

  const roundOneFill = completedR1 / totalR1;
  const votesFilled = segments.filter((s) => s !== "empty").length;
  const votesFraction = segments.length ? votesFilled / segments.length : 0;
  const consensusFill =
    run?.status === "consensus" || run?.status === "chair_ruled"
      ? 1
      : votesFilled > 0 ? votesFraction : roundOneFill;

  async function convene() {
    if (!project) return;
    if (hasKey === false) { navigate({ to: "/settings" }); return; }
    const blocked = conveneBlockedByStatus?.[project.status];
    if (blocked) { toast.error(blocked); return; }
    const extra = extraConveneGate?.();
    if (extra) { toast.error(extra); return; }
    setConvening(true);
    try {
      const { data, error } = await supabase.functions.invoke("boardroom-orchestrator", {
        body: { action: "start_run", project_id: project.id, kind },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success("The board has been convened.");
      await loadRun();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConvening(false);
    }
  }
  async function pauseRun() {
    if (!run) return;
    const { error } = await supabase.functions.invoke("boardroom-orchestrator", { body: { action: "pause", run_id: run.id } });
    if (error) toast.error(error.message);
  }
  async function resumeRun() {
    if (!run) return;
    const { error } = await supabase.functions.invoke("boardroom-orchestrator", { body: { action: "resume", run_id: run.id } });
    if (error) toast.error(error.message); else toast.success("Session resumed.");
  }
  async function retryStep(stepId: string) {
    if (!run) return;
    const { error } = await supabase.functions.invoke("boardroom-orchestrator", { body: { action: "retry_step", run_id: run.id, step_id: stepId } });
    if (error) toast.error(error.message);
  }

  if (!project) {
    if (runError) {
      return (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-6 py-8 text-sm text-destructive"
        >
          <p className="font-medium">Couldn't load this project.</p>
          <p className="mt-1 text-destructive/80">{runError}</p>
          <button
            type="button"
            onClick={retryLoad}
            disabled={retrying}
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-60"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      );
    }
    return <div className="h-64 animate-pulse rounded-xl bg-surface-1" />;
  }


  const overBudget = run && Number(run.spent_usd) >= Number(run.budget_usd) * 0.8;
  const locked = run?.status === "consensus" || run?.status === "chair_ruled";
  const terminal = !!run && ["failed", "completed", "consensus", "chair_ruled"].includes(run.status);
  const isLegacy = !!(
    run &&
    terminal &&
    (
      (typeof run.constitution_version === "number" && run.constitution_version < 3) ||
      (legacyRequiresSafeArtifact && !legacyRequiresSafeArtifact.hasSafeArtifact)
    )
  );
  const gateReason = project ? (conveneBlockedByStatus?.[project.status] ?? extraConveneGate?.() ?? null) : null;

  return (
    <div>
      {showHeader && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            {runningTitle}
          </p>
          <div className="flex items-center gap-3">
            <StatusPill run={run} />
            {isOwner && (
              <RunControls
                hasKey={hasKey}
                run={run}
                blockReason={gateReason}
                convening={convening}
                conveneLabel={conveneLabel}
                onConvene={convene}
                onPause={pauseRun}
                onResume={resumeRun}
              />
            )}
          </div>
        </div>
      )}

      {run && (
        <div className="mt-6">
          <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
            <span>Budget</span>
            <span>
              <span className={overBudget ? "text-[hsl(8_60%_65%)]" : "text-foreground"}>
                ${Number(run.spent_usd).toFixed(4)}
              </span>{" "}
              / ${Number(run.budget_usd).toFixed(2)}
            </span>
          </div>
          <div className="mt-1.5 h-[2px] w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${Math.min(100, (Number(run.spent_usd) / Math.max(0.0001, Number(run.budget_usd))) * 100)}%`,
                background: overBudget ? "hsl(8 60% 55%)" : "hsl(38 65% 55%)",
              }}
            />
          </div>
        </div>
      )}

      {isOwner && !readOnly && run && !locked && (
        <FounderNoteBox run={run} onSaved={() => void loadRun()} />
      )}

      <div className="mt-10 hidden md:block">
        <TheTable
          seats={SEAT_ORDER.map((s) => ({ seat: s, meta: SEAT_META[s], row: seatMap.get(s), step: stepBySeat.get(s) }))}
          consensusFill={consensusFill}
          segments={segments}
          rubricSize={rubric.length}
          runStatus={run?.status}
          consensusRingRef={consensusPulseRef}
          round={run?.round_no ?? 1}
          completed={completedR1}
          total={totalR1}
        />
      </div>

      <div className="mt-8 md:hidden">
        <RollCall
          seats={SEAT_ORDER.map((s) => ({ seat: s, meta: SEAT_META[s], row: seatMap.get(s), step: stepBySeat.get(s) }))}
          consensusFill={consensusFill}
          runStatus={run?.status}
          round={run?.round_no ?? 1}
          completed={completedR1}
          total={totalR1}
          consensusRingRef={consensusPulseRef}
        />
      </div>

      {locked && !isLegacy && run && lockCard?.(run)}

      {isLegacy && run && (
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.06)] p-5">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[hsl(38_65%_70%)]" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] uppercase tracking-widest text-[hsl(38_65%_70%)]">
              Legacy session — not build-safe under current founder-authority rules
            </p>
            <p className="mt-1 text-sm text-foreground">
              This session predates the current founder-authority rules or its artifact was
              invalidated. Reconvene the board to produce a build-safe result.
            </p>
          </div>
        </div>
      )}

      {run?.status === "failed" && run.error && (
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.08)] p-5">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[hsl(8_60%_65%)]" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] uppercase tracking-widest text-[hsl(8_60%_65%)]">Session failed</p>
            <p className="mt-1 text-sm text-foreground">{run.error}</p>
          </div>
        </div>
      )}

      {terminal && !readOnly && isOwner && (
        <div className="mt-6 flex justify-end">
          <button
            onClick={convene}
            disabled={convening || hasKey === false || !!gateReason}
            title={gateReason ?? (hasKey === false ? "Seat the board first — add your OpenRouter key in Settings." : undefined)}
            className="rounded-md border border-[hsl(38_65%_55%/0.5)] bg-[hsl(38_65%_55%/0.08)] px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-[hsl(38_65%_70%)] hover:bg-[hsl(38_65%_55%/0.14)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {convening
              ? "Reconvening…"
              : reconveneImportLabel ?? "Convene again"}
          </button>
        </div>
      )}

      <div className="mt-10">
        <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Transcript</p>
        {runStale && runError && run && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200"
          >
            <span>
              Showing the last loaded transcript — the latest refresh failed
              ({runError}).
            </span>
            <button
              type="button"
              onClick={retryLoad}
              disabled={retrying}
              className="rounded-md border border-amber-400/50 px-2.5 py-1 font-medium text-amber-100 transition-colors hover:bg-amber-500/20 disabled:opacity-60"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {!run && runError ? (
          // Initial load failed and we have nothing to show. Never fall
          // through to the "Preparing the room…" placeholder here — that
          // would silently hide a real error.
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-6 py-8 text-sm text-destructive"
          >
            <p className="font-medium">Couldn't load the boardroom.</p>
            <p className="mt-1 text-destructive/80">{runError}</p>
            <button
              type="button"
              onClick={retryLoad}
              disabled={retrying}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-60"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : !run ? (
          <EmptyBoardroom
            hasKey={hasKey}
            isOwner={isOwner}
            onConvene={convene}
            conveneLabel={conveneLabel}
            title={emptyTitle}
            subtitle={emptySubtitle}
            blockReason={gateReason}
          />
        ) : steps.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-6 py-10 text-center text-sm text-muted-foreground">
            Preparing the room…
          </div>
        ) : (
          <div className="space-y-4">
            {steps.map((s) => (
              <TranscriptCard key={s.id} step={s} rubric={rubric} isOwner={isOwner} onRetry={() => retryStep(s.id)} />
            ))}
          </div>
        )}
      </div>


      <style>{`
        @keyframes consensusPulse { 0% { box-shadow: 0 0 0 0 hsl(38 65% 55% / 0.55); } 100% { box-shadow: 0 0 0 42px hsl(38 65% 55% / 0); } }
        .consensus-pulse { animation: consensusPulse 1.2s ease-out 1; border-radius: 9999px; }
        @keyframes transcriptEnter { 0% { opacity: 0; transform: translateY(8px); } 100% { opacity: 1; transform: translateY(0); } }
        .transcript-enter { animation: transcriptEnter 220ms ease-out both; }
        @keyframes seatSpeak { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
        .seat-speaking { animation: seatSpeak 1.6s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

// ============================== The Table ==============================

type SeatView = { seat: Seat; meta: (typeof SEAT_META)[Seat]; row: SeatRow | undefined; step: SessionStep | undefined };

function seatGlowState(step: SessionStep | undefined) {
  if (!step) return "idle";
  if (step.status === "running") return "speaking";
  if (step.status === "failed") return "failed";
  if (step.status === "completed") return "done";
  return "idle";
}

function TheTable({
  seats, consensusFill, segments, rubricSize, runStatus, consensusRingRef, round, completed, total,
}: {
  seats: SeatView[]; consensusFill: number; segments: Array<"empty" | "brass" | "oxblood">; rubricSize: number;
  runStatus: string | undefined; consensusRingRef: React.RefObject<HTMLDivElement | null>;
  round: number; completed: number; total: number;
}) {
  const W = 720, H = 360, cx = W / 2, cy = H / 2, rx = 280, ry = 120;
  const angles = [Math.PI * 1.5, 0, Math.PI * 0.5, Math.PI];
  const positions = angles.map((a) => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }));
  const ringRx = rx + 46, ringRy = ry + 46;
  const total_segments = rubricSize * 4;
  const showSegments = segments.some((s) => s !== "empty") || runStatus === "consensus" || runStatus === "chair_ruled";
  const chairRuled = runStatus === "chair_ruled";

  return (
    <div className="relative" ref={consensusRingRef}>
      <svg viewBox={`0 0 ${W} ${H + 140}`} className="w-full">
        <ellipse cx={cx} cy={cy} rx={ringRx} ry={ringRy} fill="none" stroke="hsl(40 15% 24% / 0.5)" strokeWidth="1.5" />
        {!showSegments && (
          <ellipse
            cx={cx} cy={cy} rx={ringRx} ry={ringRy} fill="none"
            stroke="hsl(38 65% 55%)" strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={`${ellipsePerimeter(ringRx, ringRy) * consensusFill} ${ellipsePerimeter(ringRx, ringRy)}`}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: "stroke-dasharray 400ms ease-out" }}
          />
        )}
        {showSegments && segments.map((seg, i) => {
          if (seg === "empty") return null;
          const seatIdx = Math.floor(i / rubricSize);
          const rubricIdx = i % rubricSize;
          const seatAngle = angles[seatIdx];
          const arcSpan = Math.PI / 3.2; // ~56° per seat cluster
          const segStep = arcSpan / rubricSize;
          const segLen = segStep * 0.72;
          const center = seatAngle - arcSpan / 2 + segStep * (rubricIdx + 0.5);
          const t0 = center - segLen / 2;
          const t1 = center + segLen / 2;
          const x0 = cx + ringRx * Math.cos(t0), y0 = cy + ringRy * Math.sin(t0);
          const x1 = cx + ringRx * Math.cos(t1), y1 = cy + ringRy * Math.sin(t1);
          // Consensus ring segments: brass is progress (primary token),
          // failure is destructive (semantic token). Chair-ruled uses a
          // muted brass to distinguish it from clean consensus.
          const stroke = seg === "brass"
            ? (chairRuled ? "hsl(38 45% 45%)" : "hsl(var(--primary))")
            : "hsl(var(--destructive))";
          return (
            <path
              key={i}
              d={`M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${ringRx} ${ringRy} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
              fill="none" stroke={stroke} strokeWidth={seg === "oxblood" ? 2.5 : 2} strokeLinecap="round"
              opacity={chairRuled ? 0.65 : 1} style={{ transition: "opacity 300ms ease-out" }}
            />
          );
        })}
        <defs>
          <radialGradient id="tableGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="hsl(38 65% 55% / 0.08)" />
            <stop offset="60%" stopColor="hsl(220 12% 14%)" />
            <stop offset="100%" stopColor="hsl(220 13% 11%)" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#tableGlow)" stroke="hsl(40 15% 24% / 0.6)" strokeWidth="1" />
        <ellipse cx={cx} cy={cy} rx={rx - 22} ry={ry - 12} fill="none" stroke="hsl(40 15% 24% / 0.3)" strokeWidth="0.75" />
        <text x={cx} y={cy - 6} textAnchor="middle" className="font-mono" fontSize="10" fill="hsl(40 10% 62%)" letterSpacing="4">ROUND {round}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="font-mono" fontSize="11" fill="hsl(40 30% 94%)">{completed} / {total} DRAFTS IN</text>
      </svg>
      <div className="pointer-events-none absolute inset-0" aria-label={`Round ${round} · ${completed} of ${total} drafts in`}>
        {seats.map((s, i) => {
          const pos = positions[i];
          const state = seatGlowState(s.step);
          const leftPct = (pos.x / W) * 100;
          const topPct = (pos.y / (H + 140)) * 100;
          return (
            <div key={s.seat} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}>
              <SeatAvatar seat={s} state={state} />
              <div className="mt-2 text-center">
                <p className="font-display text-sm text-foreground">{s.row?.display_name ?? s.meta.label}</p>
                <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{s.row?.model_id ?? "—"}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ellipsePerimeter(a: number, b: number) {
  const h = ((a - b) ** 2) / ((a + b) ** 2);
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

function SeatAvatar({ seat, state, size = 64 }: { seat: SeatView; state: string; size?: number }) {
  const hue = seat.meta.hue;
  // Status colors use the semantic `--destructive` token so a theme change
  // (or a future light mode) restyles failure state uniformly. Seat identity
  // hues stay dynamic because they encode WHICH seat is speaking, not a
  // status.
  const border = state === "failed" ? `hsl(var(--destructive))` : state === "speaking" || state === "done" ? `hsl(${hue} / 0.9)` : "hsl(40 15% 24% / 0.6)";
  const glow = state === "speaking" ? `0 0 0 6px hsl(${hue} / 0.2), 0 0 24px hsl(${hue} / 0.35)`
    : state === "done" ? `0 0 0 3px hsl(${hue} / 0.15)`
    : state === "failed" ? `0 0 0 3px hsl(var(--destructive) / 0.25)` : "none";
  return (
    <div className={`grid place-items-center rounded-full bg-surface-2 ${state === "speaking" ? "seat-speaking" : ""}`}
      style={{ width: size, height: size, border: `1px solid ${border}`, boxShadow: glow }}>
      <span className="font-display text-lg text-foreground" style={{ color: `hsl(${hue})` }}>{seat.meta.initials}</span>
    </div>
  );
}

function RollCall({
  seats, consensusFill, runStatus, round, completed, total, consensusRingRef,
}: {
  seats: SeatView[]; consensusFill: number; runStatus: string | undefined;
  round: number; completed: number; total: number; consensusRingRef: React.RefObject<HTMLDivElement | null>;
}) {
  void runStatus;
  const r = 14, c = 2 * Math.PI * r;
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Round {round} · {completed}/{total}</p>
        <div ref={consensusRingRef}>
          <svg width="36" height="36" viewBox="0 0 36 36" aria-label={`Round ${round}, ${completed} of ${total} drafts in`}>
            <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(40 15% 24% / 0.5)" strokeWidth="2" />
            <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(38 65% 55%)" strokeWidth="2" strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - consensusFill)} transform="rotate(-90 18 18)"
              style={{ transition: "stroke-dashoffset 400ms ease-out" }} />
          </svg>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {seats.map((s) => {
          const state = seatGlowState(s.step);
          return (
            <div key={s.seat} className="flex items-center gap-4 rounded-xl border border-border bg-surface-1 px-4 py-3">
              <SeatAvatar seat={s} state={state} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm text-foreground">{s.row?.display_name ?? s.meta.label}</p>
                <p className="truncate font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{s.row?.model_id ?? "—"} · {state}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FallbackChip({ meta }: { meta?: { fallback_model_used?: string; primary_model?: string } | null }) {
  if (!meta?.fallback_model_used) return null;
  const label = meta.fallback_model_used.split("/").pop() ?? meta.fallback_model_used;
  return (
    <span
      title={`Primary seat (${meta.primary_model ?? "primary"}) declined. Answered by ${meta.fallback_model_used}.`}
      className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground"
    >
      answered by {label} — primary seat declined
    </span>
  );
}

// Standing note the Chair reads at the next synthesis — the founder's voice
// in the room without pausing the run.
function FounderNoteBox({ run, onSaved }: { run: SessionRun; onSaved: () => void }) {
  const [draft, setDraft] = useState(run.founder_notes ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = draft.trim() !== (run.founder_notes ?? "").trim();
  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("boardroom_runs")
      .update({ founder_notes: draft.trim() || null })
      .eq("id", run.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("The Chair will read this at the next synthesis.");
    onSaved();
  }
  return (
    <div className="mt-6 rounded-xl border border-border/60 bg-surface-1/60 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Note to the board</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="Anything the board should weigh — a direction you hate, a feature you refuse to cut…"
        className="mt-2 w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-relaxed text-foreground/90 placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
      />
      {dirty && (
        <button
          onClick={save}
          disabled={saving}
          className="mt-2 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save note"}
        </button>
      )}
    </div>
  );
}

// ============================== Transcript ==============================

function stepRoundLabel(step: SessionStep): string {
  if (step.step_key.startsWith("r1_")) return "Round 1 — Independent drafts";
  if (step.step_key.startsWith("r2_exam_")) return "Round 2 — Cross-examination";
  const loopMatch = /_loop(\d+)/.exec(step.step_key);
  const loop = loopMatch ? Number(loopMatch[1]) : 0;
  if (step.step_key.startsWith("r3_synthesis_")) return `Round 3 — Synthesis (loop ${loop})`;
  if (step.step_key.startsWith("r3_draft_")) return `Round 3 — Synthesis (loop ${loop})`;
  if (step.step_key.startsWith("r3_extract_")) return `Round 3 — Decision log (loop ${loop})`;
  if (step.step_key.startsWith("r4_vote_")) return `Round 4 — The vote (loop ${loop})`;
  if (step.step_key === "r_final_ruling_chair") return "Final ruling — Chair rules";
  if (step.step_key === "r5_blueprint_chair") return "Blueprint — The Chair drafts the documents";
  if (step.step_key === "r5_blueprint_extract_chair") return "Blueprint — Features extract";
  if (step.step_key.startsWith("cr_exam_")) return "Change request — Cross-examination";
  if (step.step_key === "cr_verdict_chair") return "Change request — Chair's verdict";
  if (step.step_key === "batches_chair") return "Batches — The Chair sequences the build";
  if (step.step_key.startsWith("batches_review_")) return "Batches — Board review";
  if (step.step_key === "batches_revise_chair") return "Batches — Chair's revision";
  if (step.step_key === "audit_chair_merge") return "Audit — Chair merges findings";
  if (step.step_key.startsWith("audit_")) return "Audit — Independent review";
  return `Round ${step.round}`;
}

function TranscriptCard({
  step, rubric, isOwner, onRetry,
}: {
  step: SessionStep; rubric: readonly string[]; isOwner: boolean; onRetry: () => void;
}) {
  const meta = SEAT_META[step.seat];
  const roundLabel = stepRoundLabel(step);
  const failed = step.status === "failed";
  return (
    <div className={`transcript-enter rounded-xl border bg-surface-1 p-5 ${failed ? "border-l-2 border-l-destructive border-border" : "border-border"}`}>
      <div className="flex items-center gap-3">
        <div className="grid h-8 w-8 place-items-center rounded-full"
          style={{ background: `hsl(${meta.hue} / 0.12)`, border: `1px solid hsl(${meta.hue} / 0.35)`, color: `hsl(${meta.hue})` }}>
          <span className="font-display text-[11px]">{meta.initials}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm text-foreground">{meta.label}</p>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{roundLabel}</p>
        </div>
        <FallbackChip meta={step.response_json?._meta?.fallback} />
        <StepStatusChip status={step.status} />
      </div>
      <div className="mt-4">
        {step.status === "running" || step.status === "queued" ? (
          <div className="space-y-2">
            <div className="h-2 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-2 w-full animate-pulse rounded bg-surface-2" />
            <div className="h-2 w-5/6 animate-pulse rounded bg-surface-2" />
          </div>
        ) : failed ? (
          <div className="space-y-3">
            <p className="text-sm text-[hsl(8_60%_70%)]">{step.error ?? "Step failed."}</p>
            {isOwner && (
              <button onClick={onRetry} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-2">
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </button>
            )}
          </div>
        ) : (
          <StepBody step={step} rubric={rubric} />
        )}
      </div>
    </div>
  );
}

function StepBody({ step, rubric }: { step: SessionStep; rubric: readonly string[] }) {
  const json = step.response_json;
  const invalid = json && typeof json === "object" && json.invalid === true;
  if (invalid) {
    return (
      <div className="rounded-md border border-[hsl(8_60%_45%/0.35)] bg-[hsl(8_60%_45%/0.06)] p-3 font-mono text-[11px] text-[hsl(8_60%_75%)]">
        Response failed structured validation. Raw output preserved.
      </div>
    );
  }
  if (step.step_key.startsWith("r2_exam_") && json) return <Round2Body json={json} />;
  if (step.step_key.startsWith("r3_synthesis_") && json) return <Round3Body json={json} />;
  if (step.step_key.startsWith("r3_extract_") && json) return <Round3Body json={json} />;
  if (step.step_key.startsWith("r4_vote_") && json) return <Round4Body json={json} rubric={rubric} />;
  if (step.step_key === "r_final_ruling_chair" && json) return <FinalRulingBody json={json} />;
  if (step.response_text) {
    return (
      <div className="prose prose-invert max-w-[65ch] text-sm leading-[1.7] text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.response_text}</ReactMarkdown>
      </div>
    );
  }
  return <p className="text-sm text-muted-foreground">No output.</p>;
}

function severityStyle(sev: string) {
  if (sev === "blocking") return "border-l-[hsl(8_60%_55%)] text-[hsl(8_60%_80%)]";
  if (sev === "major") return "border-l-[hsl(38_65%_55%)] text-[hsl(38_65%_75%)]";
  return "border-l-[hsl(40_10%_45%)] text-muted-foreground";
}

function Round2Body({ json }: { json: any }) {
  const objections: any[] = Array.isArray(json.objections) ? json.objections : [];
  const steals: any[] = Array.isArray(json.steals) ? json.steals : [];
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {objections.map((o, i) => (
          <div key={i} className={`rounded-md border border-border border-l-2 bg-surface-2/40 px-3 py-2 text-sm ${severityStyle(String(o.severity ?? ""))}`}>
            <p className="font-mono text-[10px] uppercase tracking-widest">→ {String(o.target_seat ?? "?")} · {String(o.severity ?? "minor")}</p>
            <p className="mt-1 text-foreground/90">{String(o.text ?? "")}</p>
          </div>
        ))}
      </div>
      {steals.length > 0 && (
        <div className="space-y-1">
          {steals.map((s, i) => (
            <p key={i} className="font-mono text-[11px] text-[hsl(160_45%_62%)]">
              STEAL: <span className="text-foreground/90">{String(s.idea ?? "")}</span>
              <span className="text-muted-foreground"> — from {String(s.from_seat ?? "?")}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Round3Body({ json }: { json: any }) {
  const md = String(json.candidate_md ?? "");
  const log: any[] = Array.isArray(json.decision_log) ? json.decision_log : [];
  const steals: any[] = Array.isArray(json.steals_adopted) ? json.steals_adopted : [];
  return (
    <div className="space-y-4">
      <div className="prose prose-invert max-w-[65ch] text-sm leading-[1.7] text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
      {steals.length > 0 && (
        <div className="space-y-1">
          {steals.map((s, i) => (
            <p key={i} className="font-mono text-[11px] text-[hsl(160_45%_62%)]">
              STEAL ADOPTED: <span className="text-foreground/90">{String(s)}</span>
            </p>
          ))}
        </div>
      )}
      <details className="rounded-md border border-border bg-surface-2/30 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Decision log ({log.length})</summary>
        <div className="mt-3 space-y-2">
          {log.map((d, i) => (
            <div key={i} className="rounded border border-border/60 bg-surface-1 p-2">
              <p className="font-mono text-[10px] uppercase tracking-widest">
                {String(d.from_seat ?? "?")} · <span className={d.decision === "accepted" ? "text-[hsl(160_45%_62%)]" : "text-[hsl(8_60%_70%)]"}>{String(d.decision ?? "?")}</span>
              </p>
              <p className="mt-1 text-foreground/90">{String(d.objection ?? "")}</p>
              {d.reason && <p className="mt-1 text-xs text-muted-foreground">{String(d.reason)}</p>}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Round4Body({ json, rubric }: { json: any; rubric: readonly string[] }) {
  const scores = (json.scores ?? {}) as Record<string, number>;
  const blocking: string[] = Array.isArray(json.blocking_objections) ? json.blocking_objections : [];
  const resolutions: any[] = Array.isArray(json.objection_resolutions) ? json.objection_resolutions : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {rubric.map((k) => {
          const n = scores[k];
          const good = typeof n === "number" && n >= 8;
          return (
            <div key={k} className={`flex items-center justify-between rounded-md border px-3 py-2 font-mono text-[11px] ${good ? "border-[hsl(160_45%_42%/0.4)] text-[hsl(160_45%_62%)]" : "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_70%)]"}`}>
              <span className="uppercase tracking-widest text-muted-foreground">{k.replace(/_/g, " ")}</span>
              <span className="text-lg text-foreground">{typeof n === "number" ? n : "—"}</span>
            </div>
          );
        })}
      </div>
      {resolutions.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Objection ledger</p>
          {resolutions.map((r, i) => {
            const resolved = r?.status === "resolved";
            return (
              <div key={i} className={`rounded-md border border-l-2 px-3 py-2 ${resolved ? "border-border border-l-[hsl(160_45%_48%)]" : "border-border border-l-[hsl(8_60%_55%)]"}`}>
                <p className="text-sm text-foreground/90">
                  <span className={`font-mono text-[10px] uppercase tracking-widest ${resolved ? "text-[hsl(160_45%_62%)]" : "text-[hsl(8_60%_70%)]"}`}>
                    {resolved ? "Resolved" : "Standing"}
                  </span>{" "}
                  — {String(r?.objection ?? "")}
                </p>
                {resolved && r?.evidence_quote && (
                  <p className="mt-1 border-l border-border pl-2 text-xs italic text-muted-foreground">
                    "{String(r.evidence_quote)}"
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {blocking.length > 0 && (
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[hsl(8_60%_70%)]">Blocking objections</p>
          {blocking.map((b, i) => (
            <p key={i} className="text-sm text-foreground/90">— {b}</p>
          ))}
        </div>
      )}
      {json.comment && <p className="text-sm italic text-muted-foreground">{String(json.comment)}</p>}
    </div>
  );
}

function FinalRulingBody({ json }: { json: any }) {
  const md = String(json.final_md ?? "");
  const note = String(json.ruling_note ?? "");
  const ledger: any[] = Array.isArray(json.dissent_ledger) ? json.dissent_ledger : [];
  return (
    <div className="space-y-4">
      {note && (
        <div className="rounded-md border border-[hsl(38_65%_55%/0.35)] bg-[hsl(38_65%_55%/0.06)] p-3 text-sm text-foreground/90">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[hsl(38_65%_70%)]">Chair's ruling</p>
          <p className="mt-1">{note}</p>
        </div>
      )}
      <div className="prose prose-invert max-w-[65ch] text-sm leading-[1.7] text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </div>
      {ledger.length > 0 && (
        <details className="rounded-md border border-border bg-surface-2/30 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Dissent ledger ({ledger.length})</summary>
          <div className="mt-3 space-y-2">
            {ledger.map((d, i) => (
              <div key={i} className="rounded border border-border/60 bg-surface-1 p-2">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{String(d.seat ?? "?")}</p>
                <p className="mt-1 text-foreground/90">{String(d.objection ?? "")}</p>
                {d.chair_response && <p className="mt-1 text-xs text-muted-foreground">Chair: {String(d.chair_response)}</p>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function StepStatusChip({ status }: { status: SessionStep["status"] }) {
  const map: Record<string, { label: string; cls: string }> = {
    queued: { label: "Queued", cls: "border-border text-muted-foreground" },
    running: { label: "Speaking", cls: "border-[hsl(38_65%_55%/0.4)] text-[hsl(38_65%_70%)]" },
    completed: { label: "On record", cls: "border-[hsl(160_45%_42%/0.4)] text-[hsl(160_45%_62%)]" },
    failed: { label: "Failed", cls: "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_65%)]" },
    skipped: { label: "Skipped", cls: "border-border text-muted-foreground" },
  };
  const v = map[status] ?? map.queued;
  return <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${v.cls}`}>{v.label}</span>;
}

function StatusPill({ run }: { run: SessionRun | null }) {
  if (!run) {
    return <span className="rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Not convened</span>;
  }
  const map: Record<string, { label: string; cls: string }> = {
    queued: { label: "Queued", cls: "border-border text-muted-foreground" },
    running: { label: "In session", cls: "border-[hsl(38_65%_55%/0.4)] text-[hsl(38_65%_70%)]" },
    paused: { label: "Paused", cls: "border-border text-muted-foreground" },
    paused_budget: { label: "Paused · budget", cls: "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_65%)]" },
    consensus: { label: "Consensus", cls: "border-[hsl(38_65%_55%/0.5)] text-[hsl(38_65%_70%)]" },
    chair_ruled: { label: "Chair ruled", cls: "border-[hsl(38_65%_55%/0.5)] text-[hsl(38_65%_70%)]" },
    failed: { label: "Failed", cls: "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_65%)]" },
  };
  const v = map[run.status] ?? { label: run.status, cls: "border-border text-muted-foreground" };
  return <span className={`rounded-full border bg-surface-2/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest ${v.cls}`}>{v.label}</span>;
}

function RunControls({
  hasKey, run, blockReason, convening, conveneLabel, onConvene, onPause, onResume,
}: {
  hasKey: boolean | null; run: SessionRun | null; blockReason: string | null;
  convening: boolean; conveneLabel: string;
  onConvene: () => void; onPause: () => void; onResume: () => void;
}) {
  const canConvene = !blockReason;
  if (!run) {
    if (hasKey === false) {
      return (
        <Link to="/settings" className="inline-flex items-center gap-2 rounded-md border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15">
          <KeyRound className="h-4 w-4" /> Seat the board first
        </Link>
      );
    }
    return (
      <button onClick={onConvene} disabled={convening || !canConvene} title={blockReason ?? undefined}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60">
        <Users2 className="h-4 w-4" />
        {convening ? "Convening…" : conveneLabel}
      </button>
    );
  }
  if (run.status === "running" || run.status === "queued") {
    return (
      <button onClick={onPause} className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground hover:bg-surface-2/80">
        <Pause className="h-4 w-4" /> Pause
      </button>
    );
  }
  if (run.status === "paused_budget" || run.status === "paused") {
    return (
      <button onClick={onResume} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110">
        <Play className="h-4 w-4" /> Resume
      </button>
    );
  }
  return null;
}

function EmptyBoardroom({
  hasKey, isOwner, onConvene, conveneLabel, title, subtitle, blockReason,
}: {
  hasKey: boolean | null; isOwner: boolean; onConvene: () => void; conveneLabel: string;
  title: string; subtitle: string; blockReason: string | null;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
      <p className="font-display text-2xl text-foreground">{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">
        {isOwner ? subtitle : "The owner hasn't convened the board yet."}
      </p>
      {isOwner && hasKey === false && (
        <Link to="/settings" className="mt-6 inline-flex items-center gap-2 rounded-md border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15">
          <KeyRound className="h-4 w-4" /> Seat the board first
        </Link>
      )}
      {isOwner && hasKey !== false && (
        <button onClick={onConvene} disabled={!!blockReason} title={blockReason ?? undefined}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 disabled:opacity-60">
          <Users2 className="h-4 w-4" /> {conveneLabel}
        </button>
      )}
    </div>
  );
}

export const PLAN_RUBRIC = [
  "painful_problem", "reachable_buyer", "monetization_path",
  "buildable_scope", "differentiation", "wow_factor",
] as const;

export const DESIGN_RUBRIC = [
  "distinctiveness", "premium_feel", "usability",
  "buildable_in_lovable", "coherence", "signature_element",
] as const;
