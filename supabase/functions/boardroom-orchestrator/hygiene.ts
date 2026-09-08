// deno-lint-ignore-file no-explicit-any
// Terminal-parent hygiene primitives. Extracted from index.ts so they can be
// unit-tested in isolation without booting Deno.serve or triggering RPC
// registration side-effects.
//
// Design rules encoded here:
//  - Every requeue path (timeout, transport, validation, stale-with-started,
//    legacy null-start) MUST funnel through requeue_step_if_parent_active so
//    a step is never resurrected under a terminal parent.
//  - failRun is FIRST-TERMINAL-WINS: two concurrent failure paths cannot
//    overwrite each other's error/audit-row/sibling state.
import { nextStatusAfterZeroBatchFailure } from "../_shared/zero-batch-recovery.ts";


export const TERMINAL_RUN_STATUSES = [
  "failed",
  "completed",
  "consensus",
  "chair_ruled",
] as const;

export type RequeueOutcome =
  | "requeued"
  | "cancelled_parent_terminal"
  | "not_found";

export async function requeueStepIfParentActive(
  admin: any,
  stepId: string,
  newRequest: any,
  newError: string,
): Promise<RequeueOutcome> {
  const { data, error } = await admin.rpc("requeue_step_if_parent_active", {
    p_step_id: stepId,
    p_new_request: newRequest,
    p_new_error: newError,
  });
  if (error) {
    throw new Error(
      `requeue_step_if_parent_active failed: ${error.message ?? error}`,
    );
  }
  const out = String(data ?? "");
  return (out === "requeued" || out === "cancelled_parent_terminal")
    ? out
    : "not_found";
}

// First-terminal-wins run failure. A late concurrent failure path whose step
// was already terminalized used to overwrite the parent run's original
// error/audit-row/sibling state — masking the true first failure with a
// tail-race one (e.g. "transport_retry_exhausted" clobbering "SeatUnavailable").
//
// This transition is now atomic:
//   1) UPDATE parent SET status='failed', error=? WHERE id=? AND status NOT IN (terminal)
//      RETURNING id — an empty result means the parent is already terminal
//      and we MUST NOT touch it (no sibling terminalization, no audit-row
//      rewrite). Returns "lost_terminal".
//   2) On win: terminalize queued/running siblings and, for audit runs,
//      the paired audits row.
export async function failRun(
  admin: any,
  run: { id: string; kind?: string; project_id?: string; consensus?: { audit_id?: string } | null },
  errorMsg: string,
): Promise<"won" | "lost_terminal"> {
  const { data, error } = await admin
    .from("boardroom_runs")
    .update({ status: "failed", error: errorMsg })
    .eq("id", run.id)
    .not("status", "in", `(${TERMINAL_RUN_STATUSES.join(",")})`)
    .select("id");
  if (error) throw new Error(`failRun update failed: ${error.message ?? error}`);
  const won = Array.isArray(data) && data.length > 0;
  if (!won) return "lost_terminal";

  await admin
    .from("run_steps")
    .update({
      status: "failed",
      error: "cancelled_parent_terminal",
      completed_at: new Date().toISOString(),
    })
    .eq("run_id", run.id)
    .in("status", ["queued", "running"]);

  const auditId: string | undefined = run?.consensus?.audit_id ?? undefined;
  if (run?.kind === "audit" && auditId) {
    await admin
      .from("audits")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", auditId);

    // AUDIT-FINALIZATION-R2 + lifecycle-R1: audit-runner sets
    // projects.status='auditing' when a final audit starts and records
    // previous_project_status on the audits row + run.consensus. Restore
    // that exact prior status on failure so the Dashboard never leaves
    // an imported project stuck at 'auditing'. Guarded by
    // .eq("status","auditing") so we never clobber a project that
    // advanced concurrently.
    if (run?.project_id) {
      try {
        const nextStatus = await priorProjectStatusForAudit(admin, run, auditId);
        await admin
          .from("projects")
          .update({ status: nextStatus })
          .eq("id", run.project_id)
          .eq("status", "auditing");
      } catch { /* best-effort reconciliation */ }
    }
  }

  // Zero-batch failure reconciliation: a failed 'batches' run that produced
  // no batches would leave projects.status='auditing' or similar, which
  // the Dashboard would misread as "Review findings". Reset to a truthful
  // state via the shared pure selector — but guard against clobbering a
  // project that concurrently advanced past the pre-build lifecycle. A
  // 'batches' run only executes while status is 'locked' (or 'imported'
  // for the import-improvement path), so restrict compare-and-set to those.
  if (run?.kind === "batches" && run?.project_id) {
    try {
      const { count: batchCount } = await admin
        .from("batches")
        .select("id", { count: "exact", head: true })
        .eq("project_id", run.project_id);
      if ((batchCount ?? 0) === 0) {
        const { data: safePlan } = await admin
          .from("plan_versions")
          .select("id")
          .eq("project_id", run.project_id)
          .eq("kind", "plan")
          .eq("is_build_safe", true)
          .limit(1)
          .maybeSingle();
        const { data: project } = await admin
          .from("projects")
          .select("is_import")
          .eq("id", run.project_id)
          .maybeSingle();
        const nextStatus = nextStatusAfterZeroBatchFailure({
          hasSafePlan: !!safePlan,
          isImport: !!project?.is_import,
        });
        await admin
          .from("projects")
          .update({ status: nextStatus, current_batch_no: 1 })
          .eq("id", run.project_id)
          .in("status", ["locked", "imported", "auditing"]);
      }
    } catch { /* best-effort reconciliation */ }
  }

  return "won";
}



// Legacy/pre-migration orphans: rows stuck in status='running' with a NULL
// started_at (every live claim now stamps started_at). Before this fix a bulk
// UPDATE flipped them straight back to 'queued' without asking who their
// parent was — resurrecting work under runs that had already been failed.
//
// Route every row through requeue_step_if_parent_active so a terminal parent
// yields cancelled_parent_terminal and an active/recoverable parent
// (queued/running/paused/paused_budget) is safely requeued.
export async function requeueLegacyNullStartOrphans(
  admin: any,
  staleCutoffIso: string,
): Promise<{ processed: number; requeued: number; cancelled: number; not_found: number }> {
  const { data: orphans } = await admin
    .from("run_steps")
    .select("id, request")
    .eq("status", "running")
    .is("started_at", null)
    .lt("created_at", staleCutoffIso);
  let requeued = 0;
  let cancelled = 0;
  let not_found = 0;
  for (const st of (orphans ?? []) as Array<{ id: string; request: any }>) {
    const outcome = await requeueStepIfParentActive(
      admin,
      st.id,
      { ...(st.request ?? {}) },
      "requeued_stale_null_start",
    );
    if (outcome === "requeued") requeued++;
    else if (outcome === "cancelled_parent_terminal") cancelled++;
    else not_found++;
  }
  return {
    processed: (orphans ?? []).length,
    requeued,
    cancelled,
    not_found,
  };
}

// ============================== Validation retry budget ==============================

// Chair steps that emit a whole document / full batch set inside JSON. They
// may widen to 10,000 visible tokens on a truncated retry — the ceiling that
// still finishes inside the proxy's non-streaming abort at the observed
// ~90-110 tok/s. Everything else (votes, reviews, map chunks) caps at 6,000.
const WIDE_RETRY_STEP_RE =
  /^(batches_chair|batches_revise_chair|audit_chair_merge|r_final_ruling_chair|cr_verdict_chair|cr_revise_chair)$/;
export const VALIDATION_RETRY_MAX_TOKENS_CHAIR = 10_000;
export const VALIDATION_RETRY_MAX_TOKENS_OTHER = 6_000;

export type ValidationRetryBudget = {
  reasoning_effort: "low";
  max_tokens?: number;
};

// Pure. The single correction pass used to re-send the identical max_tokens
// and reasoning_effort that just failed — a reasoning-eaten cap therefore
// failed identically and the second miss killed the run (RC-1). Every retry
// now runs at low reasoning; a TRUNCATED retry additionally doubles the
// visible cap, bounded per step class. When the base request carried no cap
// (or 0) the retry stays uncapped — `max_tokens` is left undefined so the
// spread does not introduce a 0/NaN key.
export function validationRetryBudget(
  step: { step_key?: string | null; request?: any },
  truncated: boolean,
): ValidationRetryBudget {
  if (!truncated) return { reasoning_effort: "low" };
  const prior = Number(step?.request?.max_tokens) || 0;
  const ceiling = WIDE_RETRY_STEP_RE.test(String(step?.step_key ?? ""))
    ? VALIDATION_RETRY_MAX_TOKENS_CHAIR
    : VALIDATION_RETRY_MAX_TOKENS_OTHER;
  const bumped = Math.min(prior * 2, ceiling) || undefined;
  return bumped ? { max_tokens: bumped, reasoning_effort: "low" } : { reasoning_effort: "low" };
}

// ============================== Timeout requeue payloads ==============================

// Pure. A step whose primary model hit the proxy abort is requeued on the
// reserve — but the reserve used to be asked for the IDENTICAL job (same
// prompt, same effort, same cap) under the identical clock, so it timed out
// too and the run died (RC-4). The requeue now forces low reasoning: the
// hidden thinking is what the wall clock could not fit. max_tokens is kept
// on purpose — a smaller cap would cut a genuinely long document and the
// markdown path would then lock a truncated plan.
export function timeoutRequeueRequest(request: any): any {
  const base = request ?? {};
  return {
    ...base,
    _timeout_attempts: Number(base._timeout_attempts ?? 0) + 1,
    // Never switch back to the timed-out primary — the reserve answers next.
    force_fallback: true,
    reasoning_effort: "low",
  };
}

// Pure. The watchdog rescue for a step whose invocation died before
// executeStep could requeue it: same cheaper-reserve rule as above, with the
// watchdog's own attempt counter and its sticky fallback pin (once forced,
// never back to the primary; the first rescue also forces it).
export function staleRequeueRequest(request: any, attempts: number): any {
  const base = request ?? {};
  const alreadyForced = !!base.force_fallback;
  return {
    ...base,
    _attempts: attempts,
    force_fallback: alreadyForced || attempts >= 1,
    reasoning_effort: "low",
  };
}

// ============================== Audit failure locality ==============================

// The status a failed final audit hands the project back to: what
// audit-runner recorded when it flipped the project to 'auditing'
// (run.consensus first, then the audits row), else the same zero-batch
// selector the batches path uses. Shared by failRun (rewind on failure) and
// reverseAuditFailure (re-enter 'auditing' on resume) so the two agree.
export async function priorProjectStatusForAudit(
  admin: any,
  run: { project_id?: string; consensus?: any },
  auditId: string,
): Promise<string> {
  let prev: string | null = run?.consensus?.previous_project_status ?? null;
  if (!prev) {
    const { data: auditRow } = await admin
      .from("audits")
      .select("previous_project_status")
      .eq("id", auditId)
      .maybeSingle();
    prev = auditRow?.previous_project_status ?? null;
  }
  if (prev) return prev;
  const { data: safePlan } = await admin
    .from("plan_versions")
    .select("id")
    .eq("project_id", run.project_id)
    .eq("kind", "plan")
    .eq("is_build_safe", true)
    .limit(1)
    .maybeSingle();
  const { data: project } = await admin
    .from("projects")
    .select("is_import")
    .eq("id", run.project_id)
    .maybeSingle();
  return nextStatusAfterZeroBatchFailure({
    hasSafePlan: !!safePlan,
    isImport: !!project?.is_import,
  });
}

// An audit map chunk is one of up to ~70 independent seat reviews; losing one
// costs a coverage note, not the run. Everything else (chair merge, every
// board round, batches) is structurally required and stays run-fatal.
export function isStepLocalFailure(run: any, step: any): boolean {
  return run?.kind === "audit" &&
    /^audit_(inspector|contrarian|strategist)(_c\d+)?$/.test(String(step?.step_key ?? ""));
}

// Minimum share of seat reviews that must have completed before the Chair
// merges. Below this — or with any chunk that no seat finished — a merge
// would produce a false "clean" verdict over code nobody read.
export const AUDIT_COVERAGE_FLOOR = 0.8;

export type AuditSeatCoverage = {
  ok: boolean;
  completed: number;
  total: number;
  missing: string[];
  reason: string | null;
};

// Pure. Groups seat steps by their `_cN` chunk suffix (single-chunk audits
// have no suffix and form one group) and decides whether the merge may run.
export function auditSeatCoverage(seatSteps: Array<{ step_key?: string; status?: string }>): AuditSeatCoverage {
  const total = seatSteps.length;
  const completed = seatSteps.filter((s) => s.status === "completed").length;
  const missing = seatSteps.filter((s) => s.status !== "completed").map((s) => String(s.step_key ?? ""));
  if (total === 0) return { ok: false, completed, total, missing, reason: "no seat steps" };
  const chunks = new Map<string, { completed: number; total: number }>();
  for (const s of seatSteps) {
    const m = /_c(\d+)$/.exec(String(s.step_key ?? ""));
    const id = m ? `c${m[1]}` : "single";
    const c = chunks.get(id) ?? { completed: 0, total: 0 };
    c.total++;
    if (s.status === "completed") c.completed++;
    chunks.set(id, c);
  }
  const dead = [...chunks.entries()].filter(([, c]) => c.completed === 0).map(([id]) => id);
  if (dead.length) {
    return { ok: false, completed, total, missing, reason: `no seat completed chunk ${dead.join(", ")}` };
  }
  if (completed / total < AUDIT_COVERAGE_FLOOR) {
    return {
      ok: false,
      completed,
      total,
      missing,
      reason: `${completed} of ${total} seat reviews completed (floor ${Math.round(AUDIT_COVERAGE_FLOOR * 100)}%)`,
    };
  }
  return { ok: true, completed, total, missing, reason: null };
}

// ============================== Resume / retry request reset ==============================

// Errors after which the reserve model must stay pinned on a resumed step:
// the primary already proved it cannot answer in time.
const KEEP_FALLBACK_ERRORS = new Set(["timeout_failover_exhausted", "stuck_model_call"]);

// Pure. A retried/resumed step used to keep its stored request verbatim, so
// `_validation_attempts: 1` gave it zero correction passes, `force_fallback`
// kept it on the reserve, and the appended correction turn (with the
// truncated echo) was re-sent. Reset every attempt marker, drop the reserve
// pin unless the error proves the primary is stuck, and strip the
// correction turn so the step starts exactly as it was first queued.
export function resetRequestForResume(request: any, error: string | null | undefined): any {
  const req: any = { ...(request ?? {}) };
  req._validation_attempts = 0;
  req._attempts = 0;
  req._timeout_attempts = 0;
  req._transport_attempts = 0;
  req._infra_attempts = 0;
  if (!KEEP_FALLBACK_ERRORS.has(String(error ?? ""))) delete req.force_fallback;
  const mode = req._validation_retry_mode;
  delete req._validation_retry_mode;
  if (Array.isArray(req.messages)) {
    const msgs = req.messages as Array<{ role?: string }>;
    const n = msgs.length;
    if (mode === "without_echo" && n >= 2 && msgs[n - 1]?.role === "user") {
      req.messages = msgs.slice(0, n - 1);
    } else if (
      // A markdown continuation replays the text so far as an assistant turn
      // plus the continue instruction — the same two-turn tail as an echo.
      (mode === "with_echo" || mode === "continuation") && n >= 3 &&
      msgs[n - 1]?.role === "user" && msgs[n - 2]?.role === "assistant"
    ) {
      req.messages = msgs.slice(0, n - 2);
    }
  }
  return req;
}

// Undo failRun's audit-side effects when a failed audit run is resumed: the
// audits row goes back to 'running' and, for a final audit, the project
// re-enters 'auditing' — but only from the exact status failRun rewound it
// to, so a project that moved on in the meantime is left alone.
export async function reverseAuditFailure(
  admin: any,
  run: { id: string; kind?: string; project_id?: string; consensus?: any },
): Promise<void> {
  const auditId: string | undefined = run?.consensus?.audit_id ?? undefined;
  if (run?.kind !== "audit" || !auditId) return;
  await admin
    .from("audits")
    .update({ status: "running", completed_at: null })
    .eq("id", auditId);
  if (run?.consensus?.audit_kind === "final_az" && run?.project_id) {
    try {
      const prev = await priorProjectStatusForAudit(admin, run, auditId);
      await admin
        .from("projects")
        .update({ status: "auditing" })
        .eq("id", run.project_id)
        .eq("status", prev);
    } catch { /* best-effort reconciliation */ }
  }
}

// ============================== Resume plan ==============================

export type ResumePlan = {
  // The audit_chair_merge row, when the run is an audit and has one.
  chair: any | null;
  // The merge row has no usable output (failed / cancelled, or a legacy run
  // whose completed merge the validator rejected): delete it and queue a
  // fresh merge once the seats are terminal.
  chairDead: boolean;
  // The merge completed and only finalizeAudit failed after it: keep every
  // row as is and let the tick re-enter finalizeAudit.
  finalizeRetry: boolean;
  // Failed rows to flip back to queued (never the dead chair row).
  requeue: any[];
};

// Pure. Decides what resume_failed touches. Seat chunks that failed alone
// are requeued only while their findings can still reach a merge; once the
// merge has completed with usable output, re-running a seat would be paid
// work nothing consumes, so a finalize retry requeues nothing.
export function planResumeFailed(
  run: { kind?: string; error?: string | null },
  steps: any[],
): ResumePlan {
  const chair = run?.kind === "audit"
    ? (steps.find((x: any) => x?.step_key === "audit_chair_merge") ?? null)
    : null;
  const chairDead = !!chair && (
    chair.status === "failed" ||
    String(run?.error ?? "").startsWith("audit_chair_merge failed validation")
  );
  const finalizeRetry = !!chair && chair.status === "completed" && !chairDead;
  const requeue = finalizeRetry
    ? []
    : steps.filter((st: any) => st?.status === "failed" && st.id !== chair?.id);
  return { chair, chairDead, finalizeRetry, requeue };
}

// ============================== Seat cap pause (RC-10) ==============================

// Pure. A seat that hits model_registry.max_cost_per_run used to fail the
// whole run (every other seat's paid work lost). It now pauses exactly like
// the run budget: the step goes back to queued, the run to paused_budget,
// and a spend_cap alert names the seat. The proxy re-checks the seat cap
// before any call, so a resume with the cap unchanged pauses again without
// spending; an admin raises the seat's cap in Settings first.
export type SeatCapPause = {
  step: { status: "queued"; error: "seat_cap" };
  run: { status: "paused_budget"; error: string };
  alert: { scope: "seat"; seat: string; cap_usd: number; spent_usd: number; run_kind: string | null };
};

export function seatCapPause(
  e: { seat: string; cap: number; spent: number },
  run: { kind?: string | null } | null | undefined,
): SeatCapPause {
  const seat = String(e.seat ?? "unknown");
  const cap = Number(e.cap) || 0;
  const spent = Number(e.spent) || 0;
  return {
    step: { status: "queued", error: "seat_cap" },
    run: {
      status: "paused_budget",
      error:
        `Seat cap hit — the ${seat} spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} per-run cap. ` +
        `Raise the ${seat} cap in Settings, then resume this run.`,
    },
    alert: { scope: "seat", seat, cap_usd: cap, spent_usd: spent, run_kind: run?.kind ?? null },
  };
}

// ============================== Transient infrastructure errors ==============================

// Database RPC failures around a model call are not a verdict on the step:
// the claim RPC failing leaves the step queued for the next tick, and a
// ledger RPC failing after the model answered means the answer was lost,
// not that the seat cannot answer. Both used to fail the run outright.
const TRANSIENT_INFRA_PREFIXES = ["claim_run_step_with_capacity failed", "record_model_call_atomic failed"];

export function isTransientInfraError(message: unknown): boolean {
  const m = String(message ?? "");
  return TRANSIENT_INFRA_PREFIXES.some((p) => m.startsWith(p));
}

// Fresh retries a step gets on the same model after a transient infra error
// before it is failed like any other error. Bounded so a persistently broken
// RPC cannot re-buy the same call forever.
export const INFRA_REQUEUE_MAX = 2;

export type InfraDecision =
  | { action: "requeue"; attempts: number; request: any }
  | { action: "terminal"; attempts: number };

// Pure. Mirrors decideTransportRequeue: same model, attempt counter carried
// on the request so it survives the requeue.
export function decideInfraRequeue(step: { request?: any }): InfraDecision {
  const prior = Number(step?.request?._infra_attempts ?? 0) || 0;
  const attempts = prior + 1;
  if (prior >= INFRA_REQUEUE_MAX) return { action: "terminal", attempts };
  return { action: "requeue", attempts, request: { ...(step?.request ?? {}), _infra_attempts: attempts } };
}

// ============================== Tick hygiene (RC-5) ==============================

// A step 'running' this long belongs to an invocation that no longer exists:
// the proxy aborts every model call at ~105 s and the platform kills an
// isolate at ~150 s, so 160 s is past both. The watchdog used to wait 3 min.
export const STALE_RUNNING_STEP_MS = 160_000;

// A run that has been 'running' with nothing queued or in flight for this
// long, and that afterStepComplete cannot advance, is dead: the seeding window
// is seconds, and every legitimate wait holds a queued/running step.
export const STALLED_RUN_MS = 5 * 60 * 1000;

export type RunStepsPhase = "no_steps" | "queued" | "running" | "settled";

// Pure. What the advance function should do with a run's steps. `no_steps`
// means the run is still being seeded (or was orphaned before its first step
// landed) — advancing it would queue Round 2 against zero drafts or, for a
// batches run, fail it for a draft that has not been inserted yet.
export function runStepsPhase(steps: Array<{ status?: string }>): RunStepsPhase {
  if (!steps.length) return "no_steps";
  if (steps.some((s) => s.status === "queued")) return "queued";
  if (steps.some((s) => s.status === "running")) return "running";
  return "settled";
}

export function hasActiveSteps(steps: Array<{ status?: string }>): boolean {
  return steps.some((s) => s.status === "queued" || s.status === "running");
}

// A run inserted as 'paused' by start_run / regenerate_batches / beginAudit
// becomes 'queued' only after its first steps exist. An invocation that dies
// in between leaves a paused run with ZERO steps holding the one-active-per-
// kind slot forever: no tick path touches paused runs, and a user pause does
// not look like this in practice (the UI offers Pause only on a run it can
// already see working, which means its steps exist).
// Pure. True when the run has sat paused and stepless for STALLED_RUN_MS.
export function isAbandonedSeed(
  run: { status?: string; created_at?: string | null },
  steps: Array<{ status?: string }>,
  nowMs: number = Date.now(),
): boolean {
  if (run?.status !== "paused" || steps.length > 0) return false;
  const created = Date.parse(String(run?.created_at ?? ""));
  if (!Number.isFinite(created)) return false;
  return nowMs - created >= STALLED_RUN_MS;
}

export type OrphanSweepResult = { candidate_runs: number; terminal_runs: number; cancelled: number };

// Bounded orphan sweep. A queued/running step whose parent run is already
// terminal is invisible to every other path (the watchdog scans 'running'
// steps only, the tick scans active runs only) and would sit there forever —
// run cfa73001's batches_chair step did exactly that. The UPDATE is scoped to
// steps under runs that are terminal right now; it never touches a step
// whose parent is active, paused, or being seeded.
export async function sweepOrphanSteps(admin: any, limit = 500): Promise<OrphanSweepResult> {
  const { data: active } = await admin
    .from("run_steps")
    .select("run_id")
    .in("status", ["queued", "running"])
    .limit(limit);
  const runIds = [...new Set(((active ?? []) as Array<{ run_id: string }>).map((s) => s.run_id))];
  if (!runIds.length) return { candidate_runs: 0, terminal_runs: 0, cancelled: 0 };

  const { data: terminalRuns } = await admin
    .from("boardroom_runs")
    .select("id")
    .in("id", runIds)
    .in("status", [...TERMINAL_RUN_STATUSES]);
  const terminalIds = ((terminalRuns ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (!terminalIds.length) return { candidate_runs: runIds.length, terminal_runs: 0, cancelled: 0 };

  const { data, error } = await admin
    .from("run_steps")
    .update({
      status: "failed",
      error: "cancelled_parent_terminal",
      completed_at: new Date().toISOString(),
    })
    .in("run_id", terminalIds)
    .in("status", ["queued", "running"])
    .select("id");
  if (error) throw new Error(`orphan sweep failed: ${error.message ?? error}`);
  return {
    candidate_runs: runIds.length,
    terminal_runs: terminalIds.length,
    cancelled: Array.isArray(data) ? data.length : 0,
  };
}
