// Smoke mode: the cheapest run of every kind that still exercises the whole
// pipeline end to end (RC-9). Before this, every code change was validated
// with a ~$7 full audit. A smoke audit reads ONE chunk with ONE seat and still
// merges; a smoke batches run drafts THREE batches and gets ONE review; a
// smoke plan/design skips the revision loops and the repo sample. Every seat
// call is served by the cheap "smoke" registry row when one is enabled, else
// by the inspector's model.
//
// Pure helpers only — no I/O — so the orchestrator, audit-runner, queues and
// proxy all decide the same way and the decisions are unit-testable.
import { batchPromptPolicy, type BatchPromptPolicy } from "./batch-count-policy.ts";

export const SMOKE_BUDGET_USD = 1.0;

/** Revision loops before the Chair rules: three normally, none in smoke mode. */
export const FULL_LOOP_CAP = 3;
export const SMOKE_LOOP_CAP = 1;

export type AuditMapSeat = "inspector" | "contrarian" | "strategist";
export type BatchesReviewSeat = "inspector" | "contrarian";

const ALL_AUDIT_MAP_SEATS: readonly AuditMapSeat[] = ["inspector", "contrarian", "strategist"];
const ALL_BATCHES_REVIEW_SEATS: readonly BatchesReviewSeat[] = ["inspector", "contrarian"];

/** True when the run was started with `smoke: true` (stored on run.consensus). */
export function isSmokeRun(run: { consensus?: unknown } | null | undefined): boolean {
  const c = run?.consensus as { smoke?: unknown } | null | undefined;
  return c?.smoke === true;
}

/**
 * Several stages replace run.consensus wholesale (plan lock, terminal
 * writes). Carry the smoke marker across so later steps (the blueprint) still
 * resolve to the smoke model and the finished row still says it was a smoke.
 */
export function keepSmoke<T extends Record<string, unknown>>(
  run: { consensus?: unknown } | null | undefined,
  meta: T,
): T & { smoke?: boolean } {
  return isSmokeRun(run) ? { ...meta, smoke: true } : meta;
}

/** start_run budget per kind; smoke runs are capped at $1 whatever the kind. */
export function runBudgetUsd(kind: string, smoke: boolean): number {
  if (smoke) return SMOKE_BUDGET_USD;
  return kind === "test" ? 0.25 : kind === "change_request" ? 3.0 : kind === "batches" ? 3.0 : 10.0;
}

/** audit-runner budget: 5 for a batch audit, 12 for a final audit, 1 in smoke mode. */
export function auditBudgetUsd(kind: "batch" | "final_az", smoke: boolean): number {
  if (smoke) return SMOKE_BUDGET_USD;
  return kind === "final_az" ? 12.0 : 5.0;
}

/** A smoke audit maps exactly one chunk (the first); a full audit maps them all. */
export function auditChunksForRun<T>(chunks: T[], smoke: boolean): T[] {
  return smoke ? chunks.slice(0, 1) : chunks;
}

/** A smoke audit queues only the inspector per chunk; the merge still runs. */
export function auditMapSeats(smoke: boolean): readonly AuditMapSeat[] {
  return smoke ? ["inspector"] : ALL_AUDIT_MAP_SEATS;
}

/** A smoke batches run gets one reviewer (the inspector) instead of two. */
export function batchesReviewSeats(smoke: boolean): readonly BatchesReviewSeat[] {
  return smoke ? ["inspector"] : ALL_BATCHES_REVIEW_SEATS;
}

/** `nextLoop < loopCap(smoke)` decides whether Round 3 is re-queued. */
export function loopCap(smoke: boolean): number {
  return smoke ? SMOKE_LOOP_CAP : FULL_LOOP_CAP;
}

// Smoke batches reuse the import policy's floor (three batches, the smallest
// count the validator accepts) and pin the ceiling to it: the run exists to
// prove the draft -> review -> persist path, not to plan a build.
export function smokeBatchPromptPolicy(): BatchPromptPolicy {
  const base = batchPromptPolicy(true);
  return {
    ...base,
    maxBatches: base.minBatches,
    rangeText: String(base.minBatches),
    rangePrompt:
      `SMOKE REHEARSAL: produce exactly ${base.minBatches} dependency-safe, single-concern build batches covering the highest-priority slice of the locked plan. This is a pipeline rehearsal, not the real build sequence — do NOT pad beyond ${base.minBatches}.`,
    countRule: `Exactly ${base.minBatches} batches (smoke rehearsal) — never more.`,
  };
}

// Which registry row serves a smoke call. The founder decides whether a
// "smoke" row exists at all (no migration seeds one); until it does, smoke
// runs ride the inspector's model. Only ENABLED rows count. Null when neither
// is usable — the caller keeps the seat's own model and says so in _meta.
export type SmokeSourceRow = { seat: string; model_id: string; enabled: boolean; fallback_model_id?: string | null };
export type SmokeSource<T extends SmokeSourceRow> = { row: T; source: "smoke" | "inspector" };

export function resolveSmokeSource<T extends SmokeSourceRow>(rows: readonly T[]): SmokeSource<T> | null {
  const usable = (seat: string) =>
    rows.find((r) => r && r.seat === seat && r.enabled === true && typeof r.model_id === "string" && r.model_id.trim() !== "");
  const smoke = usable("smoke");
  if (smoke) return { row: smoke, source: "smoke" };
  const inspector = usable("inspector");
  if (inspector) return { row: inspector, source: "inspector" };
  return null;
}
