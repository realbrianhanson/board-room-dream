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
  }

  // Zero-batch failure reconciliation: a failed 'batches' run that produced
  // no batches would leave projects.status='auditing' or similar, which
  // the Dashboard would misread as "Review findings". Reset to a truthful
  // state: 'locked' when a build-safe plan exists, 'imported' otherwise.
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
        const nextStatus = safePlan ? "locked" : (project?.is_import ? "imported" : "validated");
        await admin
          .from("projects")
          .update({ status: nextStatus, current_batch_no: 1 })
          .eq("id", run.project_id);
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
