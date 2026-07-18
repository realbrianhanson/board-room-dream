import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AlertTriangle, KeyRound, Pause, Play, RotateCcw, Users2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/boardroom/$projectId")({
  component: BoardroomProjectPage,
});

type Seat = "chair" | "strategist" | "contrarian" | "inspector";

const SEAT_ORDER: Seat[] = ["chair", "strategist", "contrarian", "inspector"];

const SEAT_META: Record<
  Seat,
  { label: string; hue: string; initials: string }
> = {
  chair: { label: "The Chair", hue: "38 65% 55%", initials: "CH" },
  strategist: { label: "The Strategist", hue: "205 60% 55%", initials: "ST" },
  contrarian: { label: "The Contrarian", hue: "350 55% 52%", initials: "CO" },
  inspector: { label: "The Inspector", hue: "160 45% 48%", initials: "IN" },
};

type Project = {
  id: string;
  name: string;
  status: string;
  user_id: string;
};
type Run = {
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
  error: string | null;
  created_at: string;
};
type Step = {
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

const RUBRIC = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
  "wow_factor",
] as const;
type RubricKey = typeof RUBRIC[number];

const CONVENE_BLOCKED: Record<string, string> = {
  intake: "Finish the intake first — the board needs a validated idea.",
  killed: "This idea was killed. Revise it before reconvening.",
};

function BoardroomProjectPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [convening, setConvening] = useState(false);
  const consensusPulseRef = useRef<HTMLDivElement | null>(null);

  const loadSteps = useCallback(async (runId: string) => {
    const { data } = await supabase
      .from("run_steps")
      .select("id, run_id, step_key, round, seat, status, response_text, error, cost_usd, created_at, completed_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    setSteps((data ?? []) as Step[]);
  }, []);

  const loadRun = useCallback(async (): Promise<Run | null> => {
    const { data } = await supabase
      .from("boardroom_runs")
      .select("*")
      .eq("project_id", projectId)
      .eq("kind", "plan")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setRun((data as Run) ?? null);
    if (data) await loadSteps(data.id);
    return (data as Run) ?? null;
  }, [projectId, loadSteps]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id ?? null;

      const { data: proj, error: pErr } = await supabase
        .from("projects")
        .select("id, name, status, user_id")
        .eq("id", projectId)
        .maybeSingle();
      if (cancelled) return;
      if (pErr || !proj) {
        toast.error("Project not found");
        navigate({ to: "/boardroom" });
        return;
      }
      setProject(proj as Project);
      setIsOwner(!!uid && uid === (proj as Project).user_id);

      const { data: seatRows } = await supabase
        .from("model_registry")
        .select("seat, display_name, model_id, enabled");
      if (!cancelled) setSeats((seatRows ?? []) as SeatRow[]);

      // Check for OpenRouter key (only meaningful for owner)
      if (uid && uid === (proj as Project).user_id) {
        const { data: keyRes } = await supabase.functions.invoke("key-vault", {
          body: { action: "list" },
        });
        if (!cancelled) {
          const rows: Array<{ provider: string; status: string }> = keyRes?.keys ?? [];
          const or = rows.find((k) => k.provider === "openrouter");
          setHasKey(!!or && or.status !== "invalid");
        }
      }

      await loadRun();
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, navigate, loadRun]);

  // Realtime subscriptions
  useEffect(() => {
    const runsChannel = supabase
      .channel(`boardroom_runs:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "boardroom_runs", filter: `project_id=eq.${projectId}` },
        (payload) => {
          const next = payload.new as Run;
          if (!next) return;
          setRun((prev) => {
            if (!prev || prev.id === next.id || new Date(next.created_at) > new Date(prev.created_at)) {
              return next;
            }
            return prev;
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(runsChannel);
    };
  }, [projectId]);

  useEffect(() => {
    if (!run?.id) return;
    const runId = run.id;
    const stepsChannel = supabase
      .channel(`run_steps:${runId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "run_steps", filter: `run_id=eq.${runId}` },
        () => {
          loadSteps(runId);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(stepsChannel);
    };
  }, [run?.id, loadSteps]);

  // Consensus pulse trigger
  useEffect(() => {
    if (run?.status === "consensus" && consensusPulseRef.current) {
      const el = consensusPulseRef.current;
      el.classList.remove("consensus-pulse");
      // reflow
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
    const m = new Map<Seat, Step>();
    for (const s of steps) {
      if (SEAT_ORDER.includes(s.seat)) m.set(s.seat, s);
    }
    return m;
  }, [steps]);

  const completedR1 = steps.filter((s) => s.round === 1 && s.status === "completed").length;
  const totalR1 = Math.max(4, steps.filter((s) => s.round === 1).length || 4);
  const consensusFill = run?.status === "consensus" ? 1 : completedR1 / totalR1;

  async function convene() {
    if (!project) return;
    if (hasKey === false) {
      navigate({ to: "/settings" });
      return;
    }
    const blocked = CONVENE_BLOCKED[project.status];
    if (blocked) {
      toast.error(blocked);
      return;
    }
    setConvening(true);
    try {
      const { data, error } = await supabase.functions.invoke("boardroom-orchestrator", {
        body: { action: "start_run", project_id: project.id, kind: "plan" },
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
    const { error } = await supabase.functions.invoke("boardroom-orchestrator", {
      body: { action: "pause", run_id: run.id },
    });
    if (error) toast.error(error.message);
  }
  async function resumeRun() {
    if (!run) return;
    const { error } = await supabase.functions.invoke("boardroom-orchestrator", {
      body: { action: "resume", run_id: run.id },
    });
    if (error) toast.error(error.message);
    else toast.success("Session resumed.");
  }
  async function retryStep(stepId: string) {
    if (!run) return;
    const { error } = await supabase.functions.invoke("boardroom-orchestrator", {
      body: { action: "retry_step", run_id: run.id, step_id: stepId },
    });
    if (error) toast.error(error.message);
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-16">
        <div className="h-64 animate-pulse rounded-xl bg-surface-1" />
      </div>
    );
  }

  const overBudget = run && Number(run.spent_usd) >= Number(run.budget_usd) * 0.8;
  const awaitingProtocol = run?.status === "paused" && run.consensus?.awaiting === "batch6_protocol";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 md:py-14">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/boardroom"
            className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground"
          >
            ← Boardroom
          </Link>
          <h1 className="mt-3 truncate font-display text-3xl leading-tight text-foreground md:text-4xl">
            {project.name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill run={run} />
          {isOwner && <RunControls
            hasKey={hasKey}
            run={run}
            project={project}
            convening={convening}
            onConvene={convene}
            onPause={pauseRun}
            onResume={resumeRun}
          />}
        </div>
      </div>

      {/* Budget meter */}
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

      {/* THE TABLE (desktop) */}
      <div className="mt-10 hidden md:block">
        <TheTable
          seats={SEAT_ORDER.map((s) => ({
            seat: s,
            meta: SEAT_META[s],
            row: seatMap.get(s),
            step: stepBySeat.get(s),
          }))}
          consensusFill={consensusFill}
          consensusRingRef={consensusPulseRef}
          round={run?.round_no ?? 1}
          completed={completedR1}
          total={totalR1}
        />
      </div>

      {/* Mobile: vertical roll call */}
      <div className="mt-8 md:hidden">
        <RollCall
          seats={SEAT_ORDER.map((s) => ({
            seat: s,
            meta: SEAT_META[s],
            row: seatMap.get(s),
            step: stepBySeat.get(s),
          }))}
          consensusFill={consensusFill}
          round={run?.round_no ?? 1}
          completed={completedR1}
          total={totalR1}
          consensusRingRef={consensusPulseRef}
        />
      </div>

      {/* Interstitial when awaiting Batch 6 */}
      {awaitingProtocol && (
        <div className="mt-10 rounded-xl border border-border bg-surface-1/70 p-6 text-center">
          <p className="font-display text-xl text-foreground">Round 1 complete.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The cross-examination convenes in the next build batch. The four independent drafts remain readable below.
          </p>
        </div>
      )}

      {/* Failed run banner */}
      {run?.status === "failed" && run.error && (
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.08)] p-5">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[hsl(8_60%_65%)]" />
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-widest text-[hsl(8_60%_65%)]">
              Session failed
            </p>
            <p className="mt-1 text-sm text-foreground">{run.error}</p>
          </div>
        </div>
      )}

      {/* Transcript */}
      <div className="mt-10">
        <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          Transcript
        </p>
        {!run ? (
          <EmptyBoardroom hasKey={hasKey} isOwner={isOwner} onConvene={convene} />
        ) : steps.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-6 py-10 text-center text-sm text-muted-foreground">
            Preparing the room…
          </div>
        ) : (
          <div className="space-y-4">
            {steps.map((s) => (
              <TranscriptCard
                key={s.id}
                step={s}
                isOwner={isOwner}
                onRetry={() => retryStep(s.id)}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes consensusPulse {
          0% { box-shadow: 0 0 0 0 hsl(38 65% 55% / 0.55); }
          100% { box-shadow: 0 0 0 42px hsl(38 65% 55% / 0); }
        }
        .consensus-pulse { animation: consensusPulse 1.2s ease-out 1; border-radius: 9999px; }
        @keyframes transcriptEnter {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .transcript-enter { animation: transcriptEnter 220ms ease-out both; }
        @keyframes seatSpeak {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 1; }
        }
        .seat-speaking { animation: seatSpeak 1.6s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

// ============================== The Table ==============================

type SeatView = {
  seat: Seat;
  meta: (typeof SEAT_META)[Seat];
  row: SeatRow | undefined;
  step: Step | undefined;
};

function seatGlowState(step: Step | undefined) {
  if (!step) return "idle";
  if (step.status === "running") return "speaking";
  if (step.status === "failed") return "failed";
  if (step.status === "completed") return "done";
  return "idle";
}

function TheTable({
  seats,
  consensusFill,
  consensusRingRef,
  round,
  completed,
  total,
}: {
  seats: SeatView[];
  consensusFill: number;
  consensusRingRef: React.RefObject<HTMLDivElement | null>;
  round: number;
  completed: number;
  total: number;
}) {
  // Ellipse geometry
  const W = 720;
  const H = 360;
  const cx = W / 2;
  const cy = H / 2;
  const rx = 280;
  const ry = 120;
  // Seat positions around ellipse (top, right, bottom, left)
  const angles = [Math.PI * 1.5, 0, Math.PI * 0.5, Math.PI]; // chair, strategist, contrarian, inspector positions
  const positions = angles.map((a) => ({
    x: cx + rx * Math.cos(a),
    y: cy + ry * Math.sin(a),
  }));

  // Consensus ring: outer ellipse path with dasharray progress
  const ringRx = rx + 46;
  const ringRy = ry + 46;
  const ringPerim = ellipsePerimeter(ringRx, ringRy);

  return (
    <div className="relative" ref={consensusRingRef}>
      <svg viewBox={`0 0 ${W} ${H + 140}`} className="w-full">
        {/* Consensus ring */}
        <ellipse
          cx={cx}
          cy={cy}
          rx={ringRx}
          ry={ringRy}
          fill="none"
          stroke="hsl(40 15% 24% / 0.5)"
          strokeWidth="1.5"
        />
        <ellipse
          cx={cx}
          cy={cy}
          rx={ringRx}
          ry={ringRy}
          fill="none"
          stroke="hsl(38 65% 55%)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={`${ringPerim * consensusFill} ${ringPerim}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: "stroke-dasharray 400ms ease-out" }}
        />

        {/* The elliptical table */}
        <defs>
          <radialGradient id="tableGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="hsl(38 65% 55% / 0.08)" />
            <stop offset="60%" stopColor="hsl(220 12% 14%)" />
            <stop offset="100%" stopColor="hsl(220 13% 11%)" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#tableGlow)" stroke="hsl(40 15% 24% / 0.6)" strokeWidth="1" />
        <ellipse cx={cx} cy={cy} rx={rx - 22} ry={ry - 12} fill="none" stroke="hsl(40 15% 24% / 0.3)" strokeWidth="0.75" />

        {/* Round label */}
        <text
          x={cx}
          y={cy - 6}
          textAnchor="middle"
          className="font-mono"
          fontSize="10"
          fill="hsl(40 10% 62%)"
          letterSpacing="4"
        >
          ROUND {round}
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="font-mono"
          fontSize="11"
          fill="hsl(40 30% 94%)"
        >
          {completed} / {total} DRAFTS IN
        </text>
      </svg>

      {/* Seat avatars positioned absolutely over SVG */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-label={`Round ${round} · ${completed} of ${total} drafts in`}
      >
        {seats.map((s, i) => {
          const pos = positions[i];
          const state = seatGlowState(s.step);
          const leftPct = (pos.x / W) * 100;
          const topPct = (pos.y / (H + 140)) * 100;
          return (
            <div
              key={s.seat}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            >
              <SeatAvatar seat={s} state={state} />
              <div className="mt-2 text-center">
                <p className="font-display text-sm text-foreground">
                  {s.row?.display_name ?? s.meta.label}
                </p>
                <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                  {s.row?.model_id ?? "—"}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ellipsePerimeter(a: number, b: number) {
  // Ramanujan approximation
  const h = ((a - b) ** 2) / ((a + b) ** 2);
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

function SeatAvatar({ seat, state, size = 64 }: { seat: SeatView; state: string; size?: number }) {
  const hue = seat.meta.hue;
  const border =
    state === "failed"
      ? `hsl(8 60% 55%)`
      : state === "speaking" || state === "done"
      ? `hsl(${hue} / 0.9)`
      : "hsl(40 15% 24% / 0.6)";
  const glow =
    state === "speaking"
      ? `0 0 0 6px hsl(${hue} / 0.2), 0 0 24px hsl(${hue} / 0.35)`
      : state === "done"
      ? `0 0 0 3px hsl(${hue} / 0.15)`
      : state === "failed"
      ? `0 0 0 3px hsl(8 60% 55% / 0.25)`
      : "none";
  return (
    <div
      className={`grid place-items-center rounded-full bg-surface-2 ${state === "speaking" ? "seat-speaking" : ""}`}
      style={{
        width: size,
        height: size,
        border: `1px solid ${border}`,
        boxShadow: glow,
      }}
    >
      <span className="font-display text-lg text-foreground" style={{ color: `hsl(${hue})` }}>
        {seat.meta.initials}
      </span>
    </div>
  );
}

function RollCall({
  seats,
  consensusFill,
  round,
  completed,
  total,
  consensusRingRef,
}: {
  seats: SeatView[];
  consensusFill: number;
  round: number;
  completed: number;
  total: number;
  consensusRingRef: React.RefObject<HTMLDivElement | null>;
}) {
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          Round {round} · {completed}/{total}
        </p>
        <div ref={consensusRingRef}>
          <svg width="36" height="36" viewBox="0 0 36 36" aria-label={`Round ${round}, ${completed} of ${total} drafts in`}>
            <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(40 15% 24% / 0.5)" strokeWidth="2" />
            <circle
              cx="18"
              cy="18"
              r={r}
              fill="none"
              stroke="hsl(38 65% 55%)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - consensusFill)}
              transform="rotate(-90 18 18)"
              style={{ transition: "stroke-dashoffset 400ms ease-out" }}
            />
          </svg>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {seats.map((s) => {
          const state = seatGlowState(s.step);
          return (
            <div
              key={s.seat}
              className="flex items-center gap-4 rounded-xl border border-border bg-surface-1 px-4 py-3"
            >
              <SeatAvatar seat={s} state={state} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm text-foreground">
                  {s.row?.display_name ?? s.meta.label}
                </p>
                <p className="truncate font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {s.row?.model_id ?? "—"} · {state}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================== Transcript ==============================

function TranscriptCard({
  step,
  isOwner,
  onRetry,
}: {
  step: Step;
  isOwner: boolean;
  onRetry: () => void;
}) {
  const meta = SEAT_META[step.seat];
  const roundLabel =
    step.round === 1 ? "Round 1 — Independent drafts" : `Round ${step.round}`;
  const failed = step.status === "failed";
  return (
    <div
      className={`transcript-enter rounded-xl border bg-surface-1 p-5 ${
        failed ? "border-l-2 border-l-[hsl(8_60%_55%)] border-border" : "border-border"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className="grid h-8 w-8 place-items-center rounded-full"
          style={{
            background: `hsl(${meta.hue} / 0.12)`,
            border: `1px solid hsl(${meta.hue} / 0.35)`,
            color: `hsl(${meta.hue})`,
          }}
        >
          <span className="font-display text-[11px]">{meta.initials}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm text-foreground">{meta.label}</p>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {roundLabel}
          </p>
        </div>
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
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-2"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </button>
            )}
          </div>
        ) : step.response_text ? (
          <div
            className="prose prose-invert max-w-[65ch] text-sm leading-[1.7] text-foreground/90"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.response_text}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No output.</p>
        )}
      </div>
    </div>
  );
}

function StepStatusChip({ status }: { status: Step["status"] }) {
  const map: Record<string, { label: string; cls: string }> = {
    queued: { label: "Queued", cls: "border-border text-muted-foreground" },
    running: {
      label: "Speaking",
      cls: "border-[hsl(38_65%_55%/0.4)] text-[hsl(38_65%_70%)]",
    },
    completed: {
      label: "On record",
      cls: "border-[hsl(160_45%_42%/0.4)] text-[hsl(160_45%_62%)]",
    },
    failed: {
      label: "Failed",
      cls: "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_65%)]",
    },
    skipped: { label: "Skipped", cls: "border-border text-muted-foreground" },
  };
  const v = map[status] ?? map.queued;
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${v.cls}`}>
      {v.label}
    </span>
  );
}

// ============================== Header bits ==============================

function StatusPill({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <span className="rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Not convened
      </span>
    );
  }
  const map: Record<string, { label: string; cls: string }> = {
    queued: { label: "Queued", cls: "border-border text-muted-foreground" },
    running: {
      label: "In session",
      cls: "border-[hsl(38_65%_55%/0.4)] text-[hsl(38_65%_70%)]",
    },
    paused: { label: "Awaiting protocol", cls: "border-border text-muted-foreground" },
    paused_budget: {
      label: "Paused · budget",
      cls: "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_65%)]",
    },
    consensus: {
      label: "Consensus",
      cls: "border-[hsl(38_65%_55%/0.5)] text-[hsl(38_65%_70%)]",
    },
    chair_ruled: {
      label: "Chair ruled",
      cls: "border-[hsl(38_65%_55%/0.5)] text-[hsl(38_65%_70%)]",
    },
    failed: {
      label: "Failed",
      cls: "border-[hsl(8_60%_45%/0.4)] text-[hsl(8_60%_65%)]",
    },
  };
  const v = map[run.status] ?? { label: run.status, cls: "border-border text-muted-foreground" };
  return (
    <span className={`rounded-full border bg-surface-2/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest ${v.cls}`}>
      {v.label}
    </span>
  );
}

function RunControls({
  hasKey,
  run,
  project,
  convening,
  onConvene,
  onPause,
  onResume,
}: {
  hasKey: boolean | null;
  run: Run | null;
  project: Project;
  convening: boolean;
  onConvene: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const blockReason = CONVENE_BLOCKED[project.status];
  const canConvene = !blockReason;

  if (!run) {
    if (hasKey === false) {
      return (
        <Link
          to="/settings"
          className="inline-flex items-center gap-2 rounded-md border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15"
        >
          <KeyRound className="h-4 w-4" />
          Seat the board first
        </Link>
      );
    }
    return (
      <button
        onClick={onConvene}
        disabled={convening || !canConvene}
        title={blockReason ?? undefined}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Users2 className="h-4 w-4" />
        {convening ? "Convening…" : "Convene the board"}
      </button>
    );
  }

  if (run.status === "running" || run.status === "queued") {
    return (
      <button
        onClick={onPause}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground hover:bg-surface-2/80"
      >
        <Pause className="h-4 w-4" />
        Pause
      </button>
    );
  }
  if (run.status === "paused_budget" || (run.status === "paused" && run.consensus?.awaiting !== "batch6_protocol")) {
    return (
      <button
        onClick={onResume}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
      >
        <Play className="h-4 w-4" />
        Resume
      </button>
    );
  }
  return null;
}

function EmptyBoardroom({
  hasKey,
  isOwner,
  onConvene,
}: {
  hasKey: boolean | null;
  isOwner: boolean;
  onConvene: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
      <p className="font-display text-2xl text-foreground">The room is empty.</p>
      <p className="mt-2 text-sm text-muted-foreground">
        {isOwner
          ? "Convene the board to open the first round of independent drafts."
          : "The owner hasn't convened the board yet."}
      </p>
      {isOwner && hasKey === false && (
        <Link
          to="/settings"
          className="mt-6 inline-flex items-center gap-2 rounded-md border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15"
        >
          <KeyRound className="h-4 w-4" />
          Seat the board first
        </Link>
      )}
      {isOwner && hasKey !== false && (
        <button
          onClick={onConvene}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
        >
          <Users2 className="h-4 w-4" />
          Convene the board
        </button>
      )}
    </div>
  );
}
