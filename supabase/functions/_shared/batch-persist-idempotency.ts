// Idempotency helpers for finalizeBatches persistence.
//
// Live incident 0ed1f4e7 showed two concurrent orchestrator ticks both reach
// the persistence tail of finalizeBatches: worker A inserts six rows and
// marks the run "completed"; worker B's identical INSERT trips the
// (project_id, batch_no) unique constraint and the naive error handler then
// overwrites "completed" with "failed".
//
// A second live pattern (observed 2026-07-21..23 on the same project) is
// distinct: the founder revises the locked plan/design and starts a FRESH
// batches run, whose freshly-drafted set collides with an OLDER batch set
// that is still sitting untouched (never pasted into Lovable, never built,
// never compiled). That set carries the PRIOR plan_version_id, so it is not
// even visible to a readback scoped by the new plan_version_id — it must be
// detected and, if genuinely untouched, safely replaced. Silently keeping
// the stale set would hand the founder a build sequence for a plan they no
// longer have locked; silently overwriting a set the founder has already
// acted on would destroy real progress. Both must be judged explicitly.
//
// The fix decomposes into decisions we want to unit-test independently:
//   1. Given a duplicate-key conflict, do the currently persisted rows
//      exactly match the set this worker intended to write, AND are they
//      still in the safe pre-execution state (pending, uncompiled, unsent)?
//      If so it is safe to treat the conflict as success (accept_existing).
//   2. If not an exact match, but EVERY existing row for this project is
//      still in the safe pre-execution state (regardless of which plan
//      revision drafted it), the existing set is a stale, never-acted-on
//      draft — supersede it with the freshly-drafted set (supersede_stale).
//   3. If any existing row shows real progress (sent/built/compiled/outcome)
//      or belongs to a different project/user, never touch it — reject with
//      the most specific reason available.
//   4. Terminal status writes on boardroom_runs must be compare-and-set
//      against the non-terminal set so a late error path can never
//      downgrade "completed" to "failed".
//   5. projects.status only advances to "building" from the pre-build
//      set (locked/imported/auditing/validated) — a project that raced
//      further along the lifecycle is left alone.
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
  | { kind: "supersede_stale"; replaced: number }
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

function exactMatchReason(p: PlannedBatchRow, e: ExistingBatchRow): string | null {
  if (e.project_id !== p.project_id) return `project_mismatch_batch_${p.batch_no}`;
  if (e.user_id !== p.user_id) return `user_mismatch_batch_${p.batch_no}`;
  if ((e.plan_version_id ?? null) !== (p.plan_version_id ?? null)) {
    return `plan_version_mismatch_batch_${p.batch_no}`;
  }
  if (e.title !== p.title) return `title_mismatch_batch_${p.batch_no}`;
  if (e.channel !== p.channel) return `channel_mismatch_batch_${p.batch_no}`;
  if (e.prompt_md !== p.prompt_md) return `prompt_md_mismatch_batch_${p.batch_no}`;
  return null;
}

export function decideConflictOutcome(
  planned: PlannedBatchRow[],
  existing: ExistingBatchRow[],
): IdempotencyDecision {
  if (!planned.length) {
    return { kind: "reject", reason: "planned_batch_set_empty" };
  }

  // Path 1 — exact idempotent retry: same count, every existing row still
  // safe-pre-execution AND byte-identical to what this worker intended to
  // write. This is the original "two workers finished the same job" case.
  if (planned.length === existing.length) {
    const byNo = new Map<number, ExistingBatchRow>();
    for (const r of existing) byNo.set(Number(r.batch_no), r);
    let allExactSafe = true;
    for (const p of planned) {
      const e = byNo.get(Number(p.batch_no));
      if (!e || !isSafePreExecution(e) || exactMatchReason(p, e)) {
        allExactSafe = false;
        break;
      }
    }
    if (allExactSafe) return { kind: "accept_existing", count: existing.length };
  }

  // Path 2 — stale untouched draft from an OLDER plan/design version.
  //
  // Supersession only applies when EVERY existing row is:
  //   (a) still in the safe pre-execution shape (never sent / built /
  //       compiled / no compile artifacts / no outcome), AND
  //   (b) owned by the same project + user the new draft targets, AND
  //   (c) tagged with a DIFFERENT plan_version_id than the fresh draft.
  //
  // (c) is what distinguishes "the founder revised the locked plan/design
  // and this is a genuinely stale prior sequence" from "same plan revision
  // but the fresh draft drifted in wording, count, or numbering" — the
  // latter is intra-plan drift and must reject loudly at Path 3 rather
  // than silently overwriting a set the founder can still reasonably
  // expect to see.
  const plannedPlanVersion = planned[0].plan_version_id ?? null;
  const sameOwner = existing.length > 0 && existing.every((e) =>
    e.project_id === planned[0].project_id && e.user_id === planned[0].user_id
  );
  const allFromOlderPlanRevision = existing.length > 0 && existing.every((e) =>
    (e.plan_version_id ?? null) !== plannedPlanVersion
  );
  if (sameOwner && allFromOlderPlanRevision && existing.every(isSafePreExecution)) {
    return { kind: "supersede_stale", replaced: existing.length };
  }


  // Path 3 — at least one existing row has real progress, or the existing
  // set belongs to a different project/user, or there is no existing set at
  // all (readback raced or was scoped wrong upstream). Never silently touch
  // it — report the most specific reason available for debugging.
  if (!existing.length) {
    return { kind: "reject", reason: "no_existing_rows_found_on_readback" };
  }
  if (planned.length !== existing.length) {
    return {
      kind: "reject",
      reason: `batch_count_mismatch_with_progressed_rows: planned=${planned.length} existing=${existing.length}`,
    };
  }
  const byNo = new Map<number, ExistingBatchRow>();
  for (const r of existing) byNo.set(Number(r.batch_no), r);
  for (const p of planned) {
    const e = byNo.get(Number(p.batch_no));
    if (!e) return { kind: "reject", reason: `missing_batch_no:${p.batch_no}` };
    if (!isSafePreExecution(e)) {
      return {
        kind: "reject",
        reason: `batch_no_${p.batch_no}_already_progressed:status=${e.status}`,
      };
    }
    const mismatch = exactMatchReason(p, e);
    if (mismatch) return { kind: "reject", reason: mismatch };
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
