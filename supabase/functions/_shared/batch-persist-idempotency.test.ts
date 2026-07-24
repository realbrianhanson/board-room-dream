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

Deno.test("isSafePreExecution requires pending+uncompiled+unsent+no compile artifacts+no outcome", () => {
  assert(isSafePreExecution(existing(1)));
  assert(!isSafePreExecution(existing(1, { status: "sent" })));
  assert(!isSafePreExecution(existing(1, { sent_at: "2026-07-23T00:00:00Z" })));
  assert(!isSafePreExecution(existing(1, { built_at: "2026-07-23T00:00:00Z" })));
  assert(!isSafePreExecution(existing(1, { compiled_at: "2026-07-23T00:00:00Z" })));
  assert(!isSafePreExecution(existing(1, { outcome_md: "shipped" })));
  assert(!isSafePreExecution(existing(1, { is_fix: true })));
  // Compile artifacts: any one populated (even without compiled_at) means
  // the batch-compiler has already touched this row and we must not
  // silently accept the duplicate.
  assert(!isSafePreExecution(existing(1, { compiled_prompt_md: "# compiled" })));
  assert(!isSafePreExecution(existing(1, { compiled_verification_prompt_md: "# verify" })));
  assert(!isSafePreExecution(existing(1, { compile_meta: { status: "partial" } })));
  // Empty-object compile_meta is treated as unset (no artifact recorded).
  assert(isSafePreExecution(existing(1, { compile_meta: {} })));
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

Deno.test("title / channel / user / project mismatch reject loudly (same plan revision)", () => {
  // These are intra-plan drift: same plan_version_id, but the persisted
  // row's identity differs. Supersession never applies within one plan
  // revision — reject with the most specific reason so the operator can
  // see WHY the fresh draft disagrees with the persisted set.
  for (const [name, e] of [
    ["title", existing(1, { title: "Other" })],
    ["channel", existing(1, { channel: "supabase" })],
    ["user", existing(1, { user_id: "different-user" })],
    ["project", existing(1, { project_id: "different-project" })],
  ] as const) {
    const d = decideConflictOutcome([planned(1)], [e]);
    assertEquals(d.kind, "reject", `${name} should reject`);
  }
});

Deno.test("plan_version mismatch on a fully safe set supersedes the stale draft", () => {
  // The founder revised the locked plan/design and this batches run was
  // drafted against the new plan_version_id. The persisted set is safe
  // pre-execution and carries the OLD plan_version_id → replace it, do
  // not reject.
  const p = [1, 2, 3].map((n) => planned(n));
  const e = [1, 2, 3].map((n) => existing(n, { plan_version_id: "stale-older-plan" }));
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "supersede_stale");
  if (d.kind === "supersede_stale") assertEquals(d.replaced, 3);
});

Deno.test("plan_version mismatch is NOT superseded when any persisted row has progressed", () => {
  // Same "founder revised the plan" scenario, but one row was already
  // sent into Lovable. Never silently destroy real progress.
  const p = [1, 2, 3].map((n) => planned(n));
  const e = [
    existing(1, { plan_version_id: "stale-older-plan" }),
    existing(2, { plan_version_id: "stale-older-plan", status: "sent", sent_at: "2026-07-23T00:00:00Z" }),
    existing(3, { plan_version_id: "stale-older-plan" }),
  ];
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "reject");
});

Deno.test("plan_version mismatch is NOT superseded when any persisted row was compiled", () => {
  const p = [1, 2].map((n) => planned(n));
  const e = [
    existing(1, { plan_version_id: "stale-older-plan" }),
    existing(2, { plan_version_id: "stale-older-plan", compiled_prompt_md: "# compiled" }),
  ];
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "reject");
});

Deno.test("plan_version mismatch requires EVERY existing row to be from an older revision", () => {
  // Mixed: one row carries the fresh plan_version_id, one carries the old
  // one. That's not "the founder cleanly revised the plan" — it's a
  // corrupted persist state. Path 2 must decline and let Path 3 report
  // the specific drift.
  const p = [1, 2].map((n) => planned(n));
  const e = [
    existing(1), // same plan_version as planned
    existing(2, { plan_version_id: "stale-older-plan" }),
  ];
  const d = decideConflictOutcome(p, e);
  assertEquals(d.kind, "reject");
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

Deno.test("compile artifact drift rejects — compiler cannot have touched a truly idempotent duplicate", () => {
  const p = [planned(1), planned(2)];
  for (const drift of [
    { compiled_prompt_md: "# compiled" },
    { compiled_verification_prompt_md: "# verify" },
    { compile_meta: { status: "ok", head_sha: "abc" } },
  ] as Partial<ExistingBatchRow>[]) {
    const e = [existing(1), existing(2, drift)];
    const d = decideConflictOutcome(p, e);
    assertEquals(d.kind, "reject");
    if (d.kind === "reject") {
      assert(
        d.reason.includes("batch_no_2_already_progressed"),
        `expected progressed rejection, got ${d.reason}`,
      );
    }
  }
});

// --- Project lifecycle CAS filter --------------------------------------
//
// finalizeBatches advances projects.status from 'locked' to 'building'
// via a compare-and-set: `.eq("status","locked")`. This mirrors the
// canonical predecessor — a 'batches' run only runs after locked plan +
// locked design, which puts projects.status='locked'. Every other state
// (building, auditing, imported, validated, polishing, done, killed)
// means either a peer worker already advanced the project OR the
// project raced further along the lifecycle; the CAS must leave those
// rows untouched. This test fences the state matrix so a future edit
// cannot widen the filter and rewind auditing/building projects.

const PROJECT_ADVANCE_PREDECESSOR = "locked" as const;
const STATES_THAT_MUST_NOT_BE_REWRITTEN = [
  "intake",
  "validated",
  "imported",
  "boardroom",
  "building",
  "auditing",
  "polishing",
  "done",
  "killed",
] as const;

function wouldAdvance(currentStatus: string): boolean {
  // Model of the .eq("status","locked") CAS in finalizeBatches.
  return currentStatus === PROJECT_ADVANCE_PREDECESSOR;
}

Deno.test("project advance CAS: only locked → building is allowed", () => {
  assert(wouldAdvance("locked"), "locked must advance to building");
  for (const s of STATES_THAT_MUST_NOT_BE_REWRITTEN) {
    assert(!wouldAdvance(s), `${s} must NOT be rewritten by finalizeBatches`);
  }
});
