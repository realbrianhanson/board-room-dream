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
        let prev: string | null =
          (run?.consensus as any)?.previous_project_status ?? null;
        if (!prev) {
          const { data: auditRow } = await admin
            .from("audits")
            .select("previous_project_status")
            .eq("id", auditId)
            .maybeSingle();
          prev = auditRow?.previous_project_status ?? null;
        }
        let nextStatus = prev;
        if (!nextStatus) {
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
          nextStatus = nextStatusAfterZeroBatchFailure({
            hasSafePlan: !!safePlan,
            isImport: !!project?.is_import,
          });
        }
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
