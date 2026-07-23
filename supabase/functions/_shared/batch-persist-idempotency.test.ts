// Regression tests for BATCH-PERSIST-IDEMPOTENCY-R1.
//
// Live run 0ed1f4e7-57e1-48bf-8f27-adbd4e9778f0: six batches were persisted
// by one orchestrator tick and then a second tick's duplicate insert
// tripped batches_project_id_batch_no_key. The old finalizeBatches handler
// treated that as a fatal error and overwrote the peer's "completed"
// terminal write with "failed". These tests fence the decision logic
// (decideConflictOutcome / isUniqueViolation) that keeps duplicate
// finalization idempotent while still failing loudly on genuine drift.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideConflictOutcome,
  isSafePreExecution,
  isUniqueViolation,
  type ExistingBatchRow,
  type PlannedBatchRow,
} from "./batch-persist-idempotency.ts";

const PROJECT = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const PLAN = "8092b7f8-99ea-48c5-b612-56220ef610f8";

function planned(no: number, overrides: Partial<PlannedBatchRow> = {}): PlannedBatchRow {
  return {
    project_id: PROJECT,
    user_id: USER,
    plan_version_id: PLAN,
    batch_no: no,
    title: `Batch ${no}`,
    channel: "lovable",
    prompt_md: `# batch ${no}\ncontent`,
    status: "pending",
    is_fix: false,
    ...overrides,
  };
}

function existing(no: number, overrides: Partial<ExistingBatchRow> = {}): ExistingBatchRow {
  return {
    project_id: PROJECT,
    user_id: USER,
    plan_version_id: PLAN,
    batch_no: no,
    title: `Batch ${no}`,
    channel: "lovable",
    prompt_md: `# batch ${no}\ncontent`,
    status: "pending",
    is_fix: false,
    sent_at: null,
    built_at: null,
    compiled_at: null,
    compiled_prompt_md: null,
    compiled_verification_prompt_md: null,
    compile_meta: null,
    outcome_md: null,
    ...overrides,
  };
}

Deno.test("isUniqueViolation recognises pg 23505 and message-shaped variants", () => {
  assert(isUniqueViolation({ code: "23505", message: "duplicate key" }));
  assert(isUniqueViolation({
    message:
      'duplicate key value violates unique constraint "batches_project_id_batch_no_key"',
  }));
  assert(!isUniqueViolation({ code: "42P01", message: "relation missing" }));
  assert(!isUniqueViolation(null));
  assert(!isUniqueViolation("boom"));
});

Deno.test("isSafePreExecution requires pending+uncompiled+unsent+no outcome", () => {
  assert(isSafePreExecution(existing(1)));
  assert(!isSafePreExecution(existing(1, { status: "sent" })));
  assert(!isSafePreExecution(existing(1, { sent_at: "2026-07-23T00:00:00Z" })));
  assert(!isSafePreExecution(existing(1, { built_at: "2026-07-23T00:00:00Z" })));
  assert(!isSafePreExecution(existing(1, { compiled_at: "2026-07-23T00:00:00Z" })));
  assert(!isSafePreExecution(existing(1, { outcome_md: "shipped" })));
  assert(!isSafePreExecution(existing(1, { is_fix: true })));
});

Deno.test("identical duplicate finalization is accepted (idempotent success)", () => {
  const p = [1, 2, 3, 4, 5, 6].map((n) => planned(n));
  const e = [1, 2, 3, 4, 5, 6].map((n) => existing(n));
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "accept_existing");
  if (d.kind === "accept_existing") assertEquals(d.count, 6);
});

Deno.test("prompt_md drift rejects the conflict (no silent overwrite)", () => {
  const p = [1, 2, 3].map((n) => planned(n));
  const e = [1, 2, 3].map((n) =>
    existing(n, n === 2 ? { prompt_md: "# different\ncontent" } : {})
  );
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "reject");
  if (d.kind === "reject") assert(d.reason.includes("prompt_md_mismatch_batch_2"));
});

Deno.test("title / channel / plan / user mismatch each reject loudly", () => {
  for (const [name, e] of [
    ["title", existing(1, { title: "Other" })],
    ["channel", existing(1, { channel: "supabase" })],
    ["plan_version", existing(1, { plan_version_id: "different-plan" })],
    ["user", existing(1, { user_id: "different-user" })],
    ["project", existing(1, { project_id: "different-project" })],
  ] as const) {
    const d = decideConflictOutcome([planned(1)], [e]);
    assertEquals(d.kind, "reject", `${name} should reject`);
  }
});

Deno.test("partial persisted set rejects — no silent fill-in", () => {
  const p = [1, 2, 3, 4, 5, 6].map((n) => planned(n));
  const e = [1, 2, 3].map((n) => existing(n));
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "reject");
  if (d.kind === "reject") assert(d.reason.startsWith("batch_count_mismatch"));
});

Deno.test("unexpected batch_no in persisted set rejects", () => {
  const p = [1, 2, 3].map((n) => planned(n));
  // Same length but the numbering diverges — batch_no 5 is not planned.
  const e = [existing(1), existing(2), existing(5)];
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "reject");
  if (d.kind === "reject") assert(d.reason.includes("missing_batch_no:3"));
});

Deno.test("progressed row (sent/built/compiled) rejects — protects owner work", () => {
  const p = [1, 2].map((n) => planned(n));
  for (const drift of [
    { status: "sent" },
    { status: "built", built_at: "2026-07-23T00:00:00Z" },
    { compiled_at: "2026-07-23T00:00:00Z" },
    { outcome_md: "owner ran this" },
  ] as Partial<ExistingBatchRow>[]) {
    const e = [existing(1), existing(2, drift)];
    const d = decideConflictOutcome(p, e);
    assertEquals(d.kind, "reject");
    if (d.kind === "reject") assert(d.reason.includes("batch_no_2_already_progressed") || d.reason.includes("mismatch"));
  }
});

Deno.test("empty planned set never accepts", () => {
  const d = decideConflictOutcome([], []);
  assertEquals(d.kind, "reject");
});
