// Idempotency helpers for finalizeBatches persistence.
//
// Live incident 0ed1f4e7 showed two concurrent orchestrator ticks both reach
// the persistence tail of finalizeBatches: worker A inserts six rows and
// marks the run "completed"; worker B's identical INSERT trips the
// (project_id, batch_no) unique constraint and the naive error handler then
// overwrites "completed" with "failed".
//
// The fix decomposes into two decisions we want to unit-test independently:
//   1. Given a duplicate-key conflict, do the currently persisted rows
//      exactly match the set this worker intended to write, AND are they
//      still in the safe pre-execution state (pending, uncompiled, unsent)?
//      If so it is safe to treat the conflict as success. Any mismatch —
//      content, plan, user, batch numbers, progressed status, compile
//      metadata — must fail loudly.
//   2. Terminal status writes on boardroom_runs must be compare-and-set
//      against the non-terminal set so a late error path can never
//      downgrade "completed" to "failed".
//
// This module is pure (no supabase/deno imports) so it runs under both
// deno test and vitest without a runtime.

export type PlannedBatchRow = {
  project_id: string;
  user_id: string;
  plan_version_id: string | null;
  batch_no: number;
  title: string;
  channel: string;
  prompt_md: string;
  status: "pending";
  is_fix: false;
};

export type ExistingBatchRow = {
  project_id: string;
  user_id: string;
  plan_version_id: string | null;
  batch_no: number;
  title: string;
  channel: string;
  prompt_md: string;
  status: string;
  is_fix: boolean;
  sent_at: string | null;
  built_at: string | null;
  compiled_at: string | null;
  outcome_md: string | null;
  // Compile artifacts. The batch-compiler can populate any of these
  // independently of `compiled_at` (e.g. a partial write during a failed
  // compile, or a schema shift that seeds compile_meta without a full
  // rewrite). Any non-empty value disqualifies the row from safe-pre-
  // execution because it means downstream work has already looked at it.
  compiled_prompt_md: string | null;
  compiled_verification_prompt_md: string | null;
  compile_meta: unknown;
};

export type IdempotencyDecision =
  | { kind: "accept_existing"; count: number }
  | { kind: "reject"; reason: string };

// Rows are considered safe pre-execution when they carry the exact
// pending/uncompiled/unsent shape finalizeBatches writes. Any deviation
// (sent, built, compiled_at, any compile artifact recorded, outcome
// recorded, fix lineage, non-pending status) means downstream work has
// already touched them and we must not silently paper over the conflict.
export function isSafePreExecution(row: ExistingBatchRow): boolean {
  const compileMetaEmpty = row.compile_meta === null ||
    row.compile_meta === undefined ||
    (typeof row.compile_meta === "object" &&
      row.compile_meta !== null &&
      Object.keys(row.compile_meta as Record<string, unknown>).length === 0);
  return row.status === "pending" &&
    row.is_fix === false &&
    row.sent_at === null &&
    row.built_at === null &&
    row.compiled_at === null &&
    (row.compiled_prompt_md === null || row.compiled_prompt_md === "") &&
    (row.compiled_verification_prompt_md === null ||
      row.compiled_verification_prompt_md === "") &&
    compileMetaEmpty &&
    (row.outcome_md === null || row.outcome_md === "");
}

export function decideConflictOutcome(
  planned: PlannedBatchRow[],
  existing: ExistingBatchRow[],
): IdempotencyDecision {
  if (!planned.length) {
    return { kind: "reject", reason: "planned_batch_set_empty" };
  }
  if (planned.length !== existing.length) {
    return {
      kind: "reject",
      reason: `batch_count_mismatch: planned=${planned.length} existing=${existing.length}`,
    };
  }
  const byNo = new Map<number, ExistingBatchRow>();
  for (const r of existing) byNo.set(Number(r.batch_no), r);
  for (const p of planned) {
    const e = byNo.get(Number(p.batch_no));
    if (!e) {
      return { kind: "reject", reason: `missing_batch_no:${p.batch_no}` };
    }
    if (!isSafePreExecution(e)) {
      return {
        kind: "reject",
        reason: `batch_no_${p.batch_no}_already_progressed:status=${e.status}`,
      };
    }
    if (e.project_id !== p.project_id) {
      return { kind: "reject", reason: `project_mismatch_batch_${p.batch_no}` };
    }
    if (e.user_id !== p.user_id) {
      return { kind: "reject", reason: `user_mismatch_batch_${p.batch_no}` };
    }
    if ((e.plan_version_id ?? null) !== (p.plan_version_id ?? null)) {
      return { kind: "reject", reason: `plan_version_mismatch_batch_${p.batch_no}` };
    }
    if (e.title !== p.title) {
      return { kind: "reject", reason: `title_mismatch_batch_${p.batch_no}` };
    }
    if (e.channel !== p.channel) {
      return { kind: "reject", reason: `channel_mismatch_batch_${p.batch_no}` };
    }
    if (e.prompt_md !== p.prompt_md) {
      return { kind: "reject", reason: `prompt_md_mismatch_batch_${p.batch_no}` };
    }
  }
  return { kind: "accept_existing", count: existing.length };
}

// Postgres unique_violation SQLSTATE. Supabase/PostgREST surfaces the code
// on the error object; some transports also expose it inside message text.
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: string; message?: string };
  if (anyErr.code === "23505") return true;
  const msg = String(anyErr.message ?? "").toLowerCase();
  return msg.includes("duplicate key value") ||
    msg.includes("batches_project_id_batch_no_key");
}
