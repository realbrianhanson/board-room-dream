// Deno tests for terminal-parent hygiene primitives. Uses a minimal in-memory
// stand-in for supabase-js query builders — enough to prove first-terminal-
// wins semantics and legacy-orphan routing without booting the real client.
import { assertEquals } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  AUDIT_COVERAGE_FLOOR,
  auditSeatCoverage,
  decideInfraRequeue,
  failRun,
  INFRA_REQUEUE_MAX,
  isTransientInfraError,
  seatCapPause,
  hasActiveSteps,
  hasRunningSteps,
  isAbandonedSeed,
  runStepsPhase,
  STALE_RUNNING_STEP_MS,
  STALLED_RUN_MS,
  sweepOrphanSteps,
  isStepLocalFailure,
  planResumeFailed,
  requeueLegacyNullStartOrphans,
  requeueStepIfParentActive,
  resetRequestForResume,
  reverseAuditFailure,
  staleRequeueRequest,
  timeoutRequeueRequest,
  TERMINAL_RUN_STATUSES,
  VALIDATION_RETRY_MAX_TOKENS_CHAIR,
  VALIDATION_RETRY_MAX_TOKENS_OTHER,
  validationRetryBudget,
} from "./hygiene.ts";

type Run = { id: string; status: string; error: string | null; kind?: string; consensus?: any };
type Step = {
  id: string;
  run_id: string;
  status: string;
  started_at: string | null;
  created_at: string;
  error: string | null;
  request?: any;
};

function makeFakeAdmin(state: { runs: Run[]; steps: Step[]; audits: any[]; rpcCalls: any[]; plans?: any[]; projects?: any[] }) {
  const admin: any = {};

  admin.rpc = (name: string, args: any) => {
    state.rpcCalls.push({ name, args });
    if (name !== "requeue_step_if_parent_active") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    }
    const step = state.steps.find((s) => s.id === args.p_step_id);
    if (!step) return Promise.resolve({ data: "not_found", error: null });
    const parent = state.runs.find((r) => r.id === step.run_id);
    if (!parent) return Promise.resolve({ data: "not_found", error: null });
    const active = ["queued", "running", "paused", "paused_budget"].includes(parent.status);
    if (active) {
      step.status = "queued";
      step.started_at = null;
      step.error = args.p_new_error ?? step.error;
      if (args.p_new_request) step.request = args.p_new_request;
      return Promise.resolve({ data: "requeued", error: null });
    }
    step.status = "failed";
    step.error = "cancelled_parent_terminal";
    return Promise.resolve({ data: "cancelled_parent_terminal", error: null });
  };

  admin.from = (table: string) => {
    const ctx: any = { table, filters: [] as Array<(row: any) => boolean>, notFilters: [] as Array<(row: any) => boolean>, pending: null as any };
    const applyFilters = (rows: any[]) =>
      rows.filter((r) => ctx.filters.every((f: any) => f(r)) && ctx.notFilters.every((f: any) => f(r)));
    const rows = () =>
      table === "boardroom_runs" ? state.runs :
      table === "run_steps" ? state.steps :
      table === "audits" ? state.audits :
      table === "plan_versions" ? (state.plans ?? []) :
      table === "projects" ? (state.projects ?? []) :
      table === "batches" ? [] : [];


    ctx.select = (_cols?: string) => {
      ctx.mode = "select";
      const thenable = {
        then: (resolve: any) => resolve({ data: applyFilters(rows()), error: null }),
      };
      return Object.assign(ctx, thenable);
    };
    ctx.update = (patch: any) => { ctx.mode = "update"; ctx.pending = patch; return ctx; };
    ctx.insert = (_row: any) => { ctx.mode = "insert"; return Promise.resolve({ data: null, error: null }); };
    ctx.eq = (col: string, val: any) => { ctx.filters.push((r: any) => r[col] === val); return ctx; };
    ctx.is = (col: string, val: any) => { ctx.filters.push((r: any) => r[col] === val); return ctx; };
    ctx.in = (col: string, vals: any[]) => { ctx.filters.push((r: any) => vals.includes(r[col])); return ctx; };
    ctx.lt = (col: string, val: any) => { ctx.filters.push((r: any) => r[col] < val); return ctx; };
    ctx.limit = (_n: number) => ctx;
    ctx.maybeSingle = () => ({ then: (resolve: any) => resolve({ data: applyFilters(rows())[0] ?? null, error: null }) });
    ctx.not = (col: string, op: string, val: any) => {
      if (op === "in") {
        const list = String(val).replace(/^\(|\)$/g, "").split(",");
        ctx.notFilters.push((r: any) => !list.includes(String(r[col])));
      }
      return ctx;
    };

    // Terminal .select() after .update() returns affected rows.
    const commitUpdate = () => {
      const affected = applyFilters(rows());
      for (const r of affected) Object.assign(r, ctx.pending);
      return affected;
    };
    const origSelect = ctx.select;
    ctx.select = (cols?: string) => {
      if (ctx.mode === "update") {
        const affected = commitUpdate();
        return { then: (resolve: any) => resolve({ data: affected, error: null }) } as any;
      }
      return origSelect(cols);
    };
    // Bare await on ctx after update (no .select) still commits.
    ctx.then = (resolve: any) => {
      if (ctx.mode === "update") {
        const affected = commitUpdate();
        return resolve({ data: affected, error: null });
      }
      return resolve({ data: applyFilters(rows()), error: null });
    };
    return ctx;
  };

  return admin;
}

Deno.test("TERMINAL_RUN_STATUSES matches the SQL contract", () => {
  assertEquals([...TERMINAL_RUN_STATUSES].sort(), ["chair_ruled", "completed", "consensus", "failed"]);
});

Deno.test("failRun: first terminal wins — second attempt preserves original error", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "audit", consensus: { audit_id: "a1" } }],
    steps: [
      { id: "s1", run_id: "r1", status: "running", started_at: "t", created_at: "t", error: null },
      { id: "s2", run_id: "r1", status: "queued", started_at: null, created_at: "t", error: null },
    ],
    audits: [{ id: "a1", status: "running", completed_at: null }],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  const first = await failRun(admin, state.runs[0], "seat_unavailable");
  assertEquals(first, "won");
  assertEquals(state.runs[0].status, "failed");
  assertEquals(state.runs[0].error, "seat_unavailable");
  // Siblings terminalized
  for (const s of state.steps) assertEquals(s.status, "failed");
  assertEquals(state.audits[0].status, "failed");

  const second = await failRun(admin, state.runs[0], "transport_retry_exhausted");
  assertEquals(second, "lost_terminal");
  assertEquals(state.runs[0].error, "seat_unavailable", "original error must survive");
});

Deno.test("failRun: two concurrent losers cannot overwrite winner", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "plan" }],
    steps: [],
    audits: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  const [a, b, c] = await Promise.all([
    failRun(admin, state.runs[0], "err_a"),
    failRun(admin, state.runs[0], "err_b"),
    failRun(admin, state.runs[0], "err_c"),
  ]);
  const wins = [a, b, c].filter((x) => x === "won").length;
  assertEquals(wins, 1, "exactly one call wins the terminal transition");
  // Winner's error survives; it is whichever ran first in this fake — the
  // point is only ONE update took effect.
  assertEquals(["err_a", "err_b", "err_c"].includes(state.runs[0].error!), true);
});

Deno.test("requeueStepIfParentActive: active parent -> requeued", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null }],
    steps: [{ id: "s1", run_id: "r1", status: "running", started_at: "t", created_at: "t", error: null }],
    audits: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  const out = await requeueStepIfParentActive(admin, "s1", { retry: 1 }, "requeued_timeout");
  assertEquals(out, "requeued");
  assertEquals(state.steps[0].status, "queued");
  assertEquals(state.steps[0].started_at, null);
});

Deno.test("requeueStepIfParentActive: terminal parent -> cancelled_parent_terminal", async () => {
  const state = {
    runs: [{ id: "r1", status: "failed", error: "e" }],
    steps: [{ id: "s1", run_id: "r1", status: "running", started_at: "t", created_at: "t", error: null }],
    audits: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  const out = await requeueStepIfParentActive(admin, "s1", null, "requeued_timeout");
  assertEquals(out, "cancelled_parent_terminal");
  assertEquals(state.steps[0].status, "failed");
});

Deno.test("requeueLegacyNullStartOrphans: routes each row through parent-aware RPC", async () => {
  const state = {
    runs: [
      { id: "active", status: "running", error: null },
      { id: "dead", status: "failed", error: "prior" },
    ],
    steps: [
      { id: "s_active", run_id: "active", status: "running", started_at: null, created_at: "2020-01-01T00:00:00Z", error: null },
      { id: "s_dead", run_id: "dead", status: "running", started_at: null, created_at: "2020-01-01T00:00:00Z", error: null },
      { id: "s_not_orphan", run_id: "active", status: "running", started_at: "now", created_at: "2020-01-01T00:00:00Z", error: null },
    ],
    audits: [],
    rpcCalls: [] as any[],
  };
  const admin = makeFakeAdmin(state);
  const summary = await requeueLegacyNullStartOrphans(admin, "2020-06-01T00:00:00Z");
  assertEquals(summary.processed, 2, "only null-started rows are considered");
  assertEquals(summary.requeued, 1);
  assertEquals(summary.cancelled, 1);
  assertEquals(state.steps.find((s) => s.id === "s_active")!.status, "queued");
  assertEquals(state.steps.find((s) => s.id === "s_dead")!.status, "failed");
  assertEquals(state.steps.find((s) => s.id === "s_not_orphan")!.status, "running");
  assertEquals(summary.processed, state.rpcCalls.length);
});

// AUDIT-FINALIZATION-R2: audit-runner sets projects.status='auditing' when a
// final audit starts. Without reconciliation in failRun the project stays
// stuck at 'auditing'. These tests cover the four documented cases plus the
// "do not clobber an advanced status" guard.

Deno.test("failRun (audit): imported + no safe plan -> reconciles project to 'imported'", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "audit", project_id: "p1", consensus: { audit_id: "a1" } }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null }],
    projects: [{ id: "p1", status: "auditing", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "some_audit_error");
  assertEquals(state.projects![0].status, "imported");
});

Deno.test("failRun (audit): build-safe plan present -> reconciles project to 'locked'", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "audit", project_id: "p1", consensus: { audit_id: "a1" } }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null }],
    projects: [{ id: "p1", status: "auditing", is_import: true }],
    plans: [{ id: "pl1", project_id: "p1", kind: "plan", is_build_safe: true }],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "some_audit_error");
  assertEquals(state.projects![0].status, "locked");
});

Deno.test("failRun (audit): greenfield + no plan -> reconciles project to 'validated'", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "audit", project_id: "p1", consensus: { audit_id: "a1" } }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null }],
    projects: [{ id: "p1", status: "auditing", is_import: false }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "some_audit_error");
  assertEquals(state.projects![0].status, "validated");
});

Deno.test("failRun (audit): does NOT clobber a project that already advanced past 'auditing'", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "audit", project_id: "p1", consensus: { audit_id: "a1" } }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null }],
    // A concurrent path already moved this project to 'locked'; audit
    // reconciliation must leave it alone.
    projects: [{ id: "p1", status: "locked", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "some_audit_error");
  assertEquals(state.projects![0].status, "locked", "advanced status must survive audit reconciliation");
});

// APP-RELIABILITY-FINDINGS-R1 / task 4: zero-batch failure must not clobber
// a project that concurrently advanced past the pre-build lifecycle.

Deno.test("failRun (batches, zero batches): status='locked' -> reconciled to expected value", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "batches", project_id: "p1" }],
    steps: [],
    audits: [],
    projects: [{ id: "p1", status: "locked", is_import: false, current_batch_no: 0 }],
    plans: [{ id: "pl1", project_id: "p1", kind: "plan", is_build_safe: true }],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "batches_failed");
  assertEquals(state.projects![0].status, "locked");
});

Deno.test("failRun (batches, zero batches): does NOT clobber a project that already advanced to 'building'", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "batches", project_id: "p1" }],
    steps: [],
    audits: [],
    projects: [{ id: "p1", status: "building", is_import: false, current_batch_no: 2 }],
    plans: [{ id: "pl1", project_id: "p1", kind: "plan", is_build_safe: true }],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "batches_failed");
  assertEquals(state.projects![0].status, "building", "advanced status must survive zero-batch reconciliation");
  assertEquals(state.projects![0].current_batch_no, 2, "advanced batch_no must survive");
});

Deno.test("failRun (batches, zero batches): does NOT clobber 'done'", async () => {
  const state = {
    runs: [{ id: "r1", status: "running", error: null, kind: "batches", project_id: "p1" }],
    steps: [],
    audits: [],
    projects: [{ id: "p1", status: "done", is_import: false, current_batch_no: 6 }],
    plans: [{ id: "pl1", project_id: "p1", kind: "plan", is_build_safe: true }],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0], "batches_failed");
  assertEquals(state.projects![0].status, "done");
});

Deno.test("failRun (audit): restores project status from previous_project_status", async () => {
  const state = {
    runs: [{
      id: "r1", status: "running", error: null, kind: "audit",
      project_id: "p1",
      consensus: { audit_id: "a1", previous_project_status: "imported" },
    }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null, previous_project_status: "imported" }],
    projects: [{ id: "p1", status: "auditing", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  const out = await failRun(admin, state.runs[0] as any, "boom");
  assertEquals(out, "won");
  assertEquals(state.projects[0].status, "imported", "must restore to prior status");
});

Deno.test("failRun (audit): guarded — no clobber when project status advanced concurrently", async () => {
  const state = {
    runs: [{
      id: "r1", status: "running", error: null, kind: "audit",
      project_id: "p1",
      consensus: { audit_id: "a1", previous_project_status: "imported" },
    }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null }],
    projects: [{ id: "p1", status: "done", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0] as any, "boom");
  assertEquals(state.projects[0].status, "done", "concurrent advance preserved");
});

Deno.test("failRun (audit): falls back to safe-plan selector when previous_project_status absent", async () => {
  const state = {
    runs: [{
      id: "r1", status: "running", error: null, kind: "audit",
      project_id: "p1",
      consensus: { audit_id: "a1" },
    }],
    steps: [],
    audits: [{ id: "a1", status: "running" }],
    projects: [{ id: "p1", status: "auditing", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0] as any, "boom");
  assertEquals(state.projects[0].status, "imported");
});

// ============================== validationRetryBudget ==============================
// RC-1: the correction pass must never re-send the identical budget that
// just truncated. Every retry drops to low reasoning; a truncated retry also
// doubles the visible cap, bounded per step class.

Deno.test("validationRetryBudget: non-truncated retry only forces low reasoning (cap untouched)", () => {
  const b = validationRetryBudget({ step_key: "r4_vote_inspector_loop0", request: { max_tokens: 3500, reasoning_effort: "high" } }, false);
  assertEquals(b, { reasoning_effort: "low" });
});

Deno.test("validationRetryBudget: truncated non-chair step doubles up to 6,000", () => {
  assertEquals(
    validationRetryBudget({ step_key: "batches_review_inspector", request: { max_tokens: 2500 } }, true),
    { max_tokens: 5000, reasoning_effort: "low" },
  );
  assertEquals(
    validationRetryBudget({ step_key: "audit_inspector_c15", request: { max_tokens: 4000 } }, true),
    { max_tokens: VALIDATION_RETRY_MAX_TOKENS_OTHER, reasoning_effort: "low" },
  );
});

Deno.test("validationRetryBudget: truncated chair document steps double up to 10,000 (105s clock)", () => {
  assertEquals(
    validationRetryBudget({ step_key: "batches_chair", request: { max_tokens: 8000, reasoning_effort: "low" } }, true),
    { max_tokens: VALIDATION_RETRY_MAX_TOKENS_CHAIR, reasoning_effort: "low" },
  );
  assertEquals(
    validationRetryBudget({ step_key: "audit_chair_merge", request: { max_tokens: 6500 } }, true),
    { max_tokens: 10000, reasoning_effort: "low" },
  );
  for (const key of ["batches_revise_chair", "r_final_ruling_chair", "cr_verdict_chair", "cr_revise_chair"]) {
    assertEquals(validationRetryBudget({ step_key: key, request: { max_tokens: 10000 } }, true).max_tokens, 10000);
  }
});

Deno.test("validationRetryBudget: uncapped base request stays uncapped (no 0/NaN max_tokens key)", () => {
  const b = validationRetryBudget({ step_key: "batches_chair", request: {} }, true);
  assertEquals(b, { reasoning_effort: "low" });
  assertEquals("max_tokens" in b, false);
  const spread = { ...{ max_tokens: undefined, messages: [] }, ...b };
  assertEquals(spread.reasoning_effort, "low");
});

// ============================== RC-2: chunk-local failure ==============================

Deno.test("isStepLocalFailure: only audit seat map steps fail alone", () => {
  const audit = { kind: "audit" };
  assertEquals(isStepLocalFailure(audit, { step_key: "audit_inspector_c15" }), true);
  assertEquals(isStepLocalFailure(audit, { step_key: "audit_contrarian_c3" }), true);
  assertEquals(isStepLocalFailure(audit, { step_key: "audit_strategist" }), true);
  // Structurally required steps stay run-fatal.
  assertEquals(isStepLocalFailure(audit, { step_key: "audit_chair_merge" }), false);
  assertEquals(isStepLocalFailure(audit, { step_key: "audit_reserve_c1" }), false);
  // Same key under any other run kind is not chunk-local.
  assertEquals(isStepLocalFailure({ kind: "plan" }, { step_key: "audit_inspector_c1" }), false);
  assertEquals(isStepLocalFailure({ kind: "batches" }, { step_key: "batches_chair" }), false);
  assertEquals(isStepLocalFailure(null, { step_key: "audit_inspector_c1" }), false);
  assertEquals(isStepLocalFailure(audit, {}), false);
});

function seatRows(chunks: number, failed: string[] = []) {
  const rows: Array<{ step_key: string; status: string }> = [];
  for (let c = 1; c <= chunks; c++) {
    for (const seat of ["inspector", "contrarian", "strategist"]) {
      const key = `audit_${seat}_c${c}`;
      rows.push({ step_key: key, status: failed.includes(key) ? "failed" : "completed" });
    }
  }
  return rows;
}

Deno.test("auditSeatCoverage: every seat completed -> merge with no gap", () => {
  const cov = auditSeatCoverage(seatRows(24));
  assertEquals(cov.ok, true);
  assertEquals(cov.completed, 72);
  assertEquals(cov.total, 72);
  assertEquals(cov.missing, []);
});

Deno.test("auditSeatCoverage: one dead chunk seat out of 72 still merges, listed as missing", () => {
  const cov = auditSeatCoverage(seatRows(24, ["audit_inspector_c15"]));
  assertEquals(cov.ok, true);
  assertEquals(cov.missing, ["audit_inspector_c15"]);
  assertEquals(cov.completed, 71);
});

Deno.test("auditSeatCoverage: a chunk nobody finished fails the run", () => {
  const cov = auditSeatCoverage(seatRows(24, ["audit_inspector_c7", "audit_contrarian_c7", "audit_strategist_c7"]));
  assertEquals(cov.ok, false);
  assertEquals(cov.reason?.includes("c7"), true);
});

Deno.test("auditSeatCoverage: below the 80% floor fails the run even with every chunk touched", () => {
  // 10 chunks x 3 seats = 30; fail 7 spread across chunks -> 23/30 = 76.7%.
  const failed = ["audit_inspector_c1", "audit_contrarian_c2", "audit_strategist_c3", "audit_inspector_c4", "audit_contrarian_c5", "audit_strategist_c6", "audit_inspector_c7"];
  const cov = auditSeatCoverage(seatRows(10, failed));
  assertEquals(cov.ok, false);
  assertEquals(cov.completed, 23);
  assertEquals(cov.reason?.includes("23 of 30"), true);
  // Exactly at the floor (24/30) passes.
  assertEquals(auditSeatCoverage(seatRows(10, failed.slice(0, 6))).ok, true);
  assertEquals(AUDIT_COVERAGE_FLOOR, 0.8);
});

Deno.test("auditSeatCoverage: single-chunk audits (no suffix) form one group; empty input never merges", () => {
  const single = [
    { step_key: "audit_inspector", status: "completed" },
    { step_key: "audit_contrarian", status: "completed" },
    { step_key: "audit_strategist", status: "completed" },
  ];
  assertEquals(auditSeatCoverage(single).ok, true);
  assertEquals(auditSeatCoverage([]).ok, false);
});

// ============================== RC-2: resume / retry request reset ==============================

Deno.test("resetRequestForResume: attempt markers reset, reserve pin dropped, correction turn stripped", () => {
  const base = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ];
  const stored = {
    json_output: true,
    max_tokens: 4000,
    _validation_attempts: 1,
    _attempts: 3,
    _timeout_attempts: 1,
    _transport_attempts: 1,
    force_fallback: true,
    _validation_retry_mode: "with_echo",
    messages: [...base, { role: "assistant", content: "{\"find" }, { role: "user", content: "fix it" }],
  };
  const out = resetRequestForResume(stored, "truncated_after_correction");
  assertEquals(out._validation_attempts, 0);
  assertEquals(out._attempts, 0);
  assertEquals(out._timeout_attempts, 0);
  assertEquals(out._transport_attempts, 0);
  assertEquals("force_fallback" in out, false);
  assertEquals("_validation_retry_mode" in out, false);
  assertEquals(out.messages, base);
  assertEquals(out.max_tokens, 4000, "budget and prompt keys survive");
  // Input is not mutated.
  assertEquals(stored._validation_attempts, 1);
  assertEquals(stored.messages.length, 4);
});

Deno.test("resetRequestForResume: without_echo drops one turn; no mode leaves messages alone", () => {
  const base = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  const noEcho = resetRequestForResume(
    { _validation_retry_mode: "without_echo", messages: [...base, { role: "user", content: "correction" }] },
    "invalid_json_after_correction",
  );
  assertEquals(noEcho.messages, base);
  const plain = resetRequestForResume({ messages: base, _validation_attempts: 1 }, "some error");
  assertEquals(plain.messages, base);
  // A mode whose tail does not look like the correction turn is left intact.
  const odd = resetRequestForResume({ _validation_retry_mode: "with_echo", messages: base }, "x");
  assertEquals(odd.messages, base);
  assertEquals(resetRequestForResume(null, null)._validation_attempts, 0);
});

Deno.test("resetRequestForResume: reserve pin survives only when the primary proved stuck", () => {
  for (const err of ["timeout_failover_exhausted", "stuck_model_call"]) {
    assertEquals(resetRequestForResume({ force_fallback: true }, err).force_fallback, true, err);
  }
  for (const err of ["transport_retry_exhausted", "cancelled_parent_terminal", "SeatUnavailable", null]) {
    assertEquals("force_fallback" in resetRequestForResume({ force_fallback: true }, err), false, String(err));
  }
});

// ============================== RC-2: reverse failRun's audit side effects ==============================

Deno.test("reverseAuditFailure: final audit -> audits back to running, project re-enters 'auditing'", async () => {
  const state = {
    runs: [{
      id: "r1", status: "failed", error: "boom", kind: "audit", project_id: "p1",
      consensus: { audit_id: "a1", audit_kind: "final_az", previous_project_status: "imported" },
    }],
    steps: [],
    audits: [{ id: "a1", status: "failed", completed_at: "t" }],
    projects: [{ id: "p1", status: "imported", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await reverseAuditFailure(admin, state.runs[0] as any);
  assertEquals(state.audits[0].status, "running");
  assertEquals(state.audits[0].completed_at, null);
  assertEquals(state.projects[0].status, "auditing");
});

Deno.test("reverseAuditFailure: round-trips failRun exactly", async () => {
  const state = {
    runs: [{
      id: "r1", status: "running", error: null, kind: "audit", project_id: "p1",
      consensus: { audit_id: "a1", audit_kind: "final_az" },
    }],
    steps: [],
    audits: [{ id: "a1", status: "running", completed_at: null, previous_project_status: "locked" }],
    projects: [{ id: "p1", status: "auditing", is_import: false }],
    plans: [{ id: "pl1", project_id: "p1", kind: "plan", is_build_safe: true }],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await failRun(admin, state.runs[0] as any, "audit coverage below floor: x");
  assertEquals(state.projects[0].status, "locked");
  assertEquals(state.audits[0].status, "failed");
  await reverseAuditFailure(admin, state.runs[0] as any);
  assertEquals(state.projects[0].status, "auditing");
  assertEquals(state.audits[0].status, "running");
});

Deno.test("reverseAuditFailure: batch audits and advanced projects are left alone", async () => {
  const state = {
    runs: [
      { id: "r1", status: "failed", error: "e", kind: "audit", project_id: "p1", consensus: { audit_id: "a1", audit_kind: "batch" } },
      { id: "r2", status: "failed", error: "e", kind: "audit", project_id: "p2", consensus: { audit_id: "a2", audit_kind: "final_az", previous_project_status: "imported" } },
      { id: "r3", status: "failed", error: "e", kind: "plan", project_id: "p1" },
    ],
    steps: [],
    audits: [{ id: "a1", status: "failed" }, { id: "a2", status: "failed" }],
    projects: [{ id: "p1", status: "locked", is_import: false }, { id: "p2", status: "done", is_import: true }],
    plans: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  await reverseAuditFailure(admin, state.runs[0] as any);
  assertEquals(state.audits[0].status, "running");
  assertEquals(state.projects[0].status, "locked", "batch audit never touches the project");
  await reverseAuditFailure(admin, state.runs[1] as any);
  assertEquals(state.projects[1].status, "done", "a project that moved on is not rewound");
  await reverseAuditFailure(admin, state.runs[2] as any);
  assertEquals(state.audits[1].status, "running", "non-audit run is a no-op");
});

// ============================== RC-2: resume plan ==============================


Deno.test("planResumeFailed: a completed merge whose finalize failed requeues nothing (no re-bought seats)", () => {
  const steps = [
    { id: "s1", step_key: "audit_inspector_c1", status: "completed" },
    { id: "s2", step_key: "audit_inspector_c2", status: "failed", error: "truncated_after_correction" },
    { id: "s3", step_key: "audit_contrarian_c2", status: "completed" },
    { id: "m", step_key: "audit_chair_merge", status: "completed" },
  ];
  const plan = planResumeFailed({ kind: "audit", error: "final-audit supersession failed: x" }, steps);
  assertEquals(plan.chair?.id, "m");
  assertEquals(plan.chairDead, false);
  assertEquals(plan.finalizeRetry, true);
  assertEquals(plan.requeue, []);
});

Deno.test("planResumeFailed: a dead merge is dropped and every failed seat is requeued", () => {
  const steps = [
    { id: "s1", step_key: "audit_inspector_c1", status: "completed" },
    { id: "s2", step_key: "audit_inspector_c2", status: "failed", error: "invalid_json_after_correction" },
    { id: "m", step_key: "audit_chair_merge", status: "failed", error: "stuck_model_call" },
  ];
  const plan = planResumeFailed({ kind: "audit", error: "Step audit_chair_merge kept timing out" }, steps);
  assertEquals(plan.chairDead, true);
  assertEquals(plan.finalizeRetry, false);
  assertEquals(plan.requeue.map((s: any) => s.id), ["s2"], "the chair row is deleted, never requeued");
  // Legacy: merge completed but the validator rejected it.
  const legacy = planResumeFailed(
    { kind: "audit", error: "audit_chair_merge failed validation: findings[0].evidence over 200" },
    [{ id: "m", step_key: "audit_chair_merge", status: "completed" }],
  );
  assertEquals(legacy.chairDead, true);
  assertEquals(legacy.finalizeRetry, false);
  assertEquals(legacy.requeue, []);
});

Deno.test("planResumeFailed: non-audit runs requeue the failed step and its cancelled siblings", () => {
  const steps = [
    { id: "a", step_key: "r1_draft_inspector", status: "completed" },
    { id: "b", step_key: "r1_draft_contrarian", status: "failed", error: "timeout_failover_exhausted" },
    { id: "c", step_key: "r1_draft_strategist", status: "failed", error: "cancelled_parent_terminal" },
    { id: "d", step_key: "r2_exam_inspector", status: "queued" },
  ];
  const plan = planResumeFailed({ kind: "plan", error: "Step r1_draft_contrarian timed out" }, steps);
  assertEquals(plan.chair, null);
  assertEquals(plan.chairDead, false);
  assertEquals(plan.finalizeRetry, false);
  assertEquals(plan.requeue.map((s: any) => s.id), ["b", "c"]);
});

// ============================== Tick hygiene (RC-5) ==============================

Deno.test("runStepsPhase: a run with no steps yet is 'no_steps' — advance must not run", () => {
  assertEquals(runStepsPhase([]), "no_steps");
  assertEquals(hasActiveSteps([]), false);
});

Deno.test("runStepsPhase: queued beats running beats settled", () => {
  assertEquals(runStepsPhase([{ status: "completed" }, { status: "queued" }, { status: "running" }]), "queued");
  assertEquals(runStepsPhase([{ status: "completed" }, { status: "running" }]), "running");
  assertEquals(runStepsPhase([{ status: "completed" }, { status: "failed" }]), "settled");
  assertEquals(hasActiveSteps([{ status: "completed" }, { status: "running" }]), true);
  assertEquals(hasActiveSteps([{ status: "completed" }, { status: "failed" }]), false);
});

// processRun consults hasRunningSteps BEFORE advancing on a zero claim: with a
// running step (capacity held by an in-flight executor or inline call) it
// returns without afterStepComplete, because runStepsPhase reports the queued
// sibling first and advanceRun would fireSelfTick() in a loop for the life of
// the call (Batch 17, spec §5.2).
Deno.test("hasRunningSteps: true only when some step is 'running'", () => {
  assertEquals(hasRunningSteps([{ status: "queued" }, { status: "running" }]), true);
  assertEquals(hasRunningSteps([{ status: "queued" }, { status: "completed" }]), false);
  assertEquals(hasRunningSteps([]), false);
  assertEquals(hasRunningSteps([{ status: "failed" }, { status: "skipped" }, { status: "completed" }]), false);
  // A queued-only run is still 'queued' for runStepsPhase — the advance path is unchanged there.
  assertEquals(runStepsPhase([{ status: "queued" }]), "queued");
  assertEquals(hasRunningSteps([{ status: "queued" }]), false);
});

Deno.test("tick cutoffs: stale step 160 s (inside the 105 s proxy abort + 150 s isolate cap), stalled run 5 min", () => {
  assertEquals(STALE_RUNNING_STEP_MS, 160_000);
  assertEquals(STALLED_RUN_MS, 300_000);
});

Deno.test("isAbandonedSeed: a paused, stepless run older than the stalled cutoff is an abandoned seed", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const old = new Date(now - STALLED_RUN_MS - 1_000).toISOString();
  const fresh = new Date(now - 30_000).toISOString();
  assertEquals(isAbandonedSeed({ status: "paused", created_at: old }, [], now), true);
  // Still inside the seeding window.
  assertEquals(isAbandonedSeed({ status: "paused", created_at: fresh }, [], now), false);
  // A paused run WITH steps is a user pause (or a reopen in progress) — never touched.
  assertEquals(isAbandonedSeed({ status: "paused", created_at: old }, [{ status: "completed" }], now), false);
  assertEquals(isAbandonedSeed({ status: "paused", created_at: old }, [{ status: "failed" }], now), false);
  // Only paused runs qualify; queued/running belong to the stalled-run detector.
  assertEquals(isAbandonedSeed({ status: "running", created_at: old }, [], now), false);
  assertEquals(isAbandonedSeed({ status: "queued", created_at: old }, [], now), false);
  // No usable timestamp: never guess.
  assertEquals(isAbandonedSeed({ status: "paused", created_at: null }, [], now), false);
});

Deno.test("sweepOrphanSteps: cancels queued/running steps only under terminal parents", async () => {
  const state = {
    runs: [
      { id: "dead", status: "failed", error: "x", kind: "batches" },
      { id: "done", status: "chair_ruled", error: null, kind: "plan" },
      { id: "live", status: "running", error: null, kind: "plan" },
      { id: "seeding", status: "paused", error: null, kind: "batches" },
    ],
    steps: [
      // the cfa73001 shape: a queued step inserted after the cron failed its run
      { id: "orphan_q", run_id: "dead", status: "queued", started_at: null, created_at: "t", error: null },
      { id: "orphan_r", run_id: "done", status: "running", started_at: "t", created_at: "t", error: null },
      { id: "dead_done", run_id: "dead", status: "completed", started_at: "t", created_at: "t", error: null },
      { id: "live_q", run_id: "live", status: "queued", started_at: null, created_at: "t", error: null },
      { id: "live_r", run_id: "live", status: "running", started_at: "t", created_at: "t", error: null },
      { id: "seed_q", run_id: "seeding", status: "queued", started_at: null, created_at: "t", error: null },
    ],
    audits: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  const out = await sweepOrphanSteps(admin);
  assertEquals(out, { candidate_runs: 4, terminal_runs: 2, cancelled: 2 });
  const byId = (id: string) => state.steps.find((s) => s.id === id)!;
  assertEquals(byId("orphan_q").status, "failed");
  assertEquals(byId("orphan_q").error, "cancelled_parent_terminal");
  assertEquals(byId("orphan_r").status, "failed");
  assertEquals(byId("orphan_r").error, "cancelled_parent_terminal");
  // Completed rows under a terminal run are left alone.
  assertEquals(byId("dead_done").status, "completed");
  // Active and seeding parents are never touched.
  assertEquals(byId("live_q").status, "queued");
  assertEquals(byId("live_r").status, "running");
  assertEquals(byId("seed_q").status, "queued");
  // Never routes through the requeue RPC — this is a plain bounded UPDATE.
  assertEquals(state.rpcCalls.length, 0);
});

Deno.test("sweepOrphanSteps: nothing to do is a no-op with zero counts", async () => {
  const state = {
    runs: [{ id: "live", status: "running", error: null, kind: "plan" }],
    steps: [{ id: "s", run_id: "live", status: "queued", started_at: null, created_at: "t", error: null }],
    audits: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  assertEquals(await sweepOrphanSteps(admin), { candidate_runs: 1, terminal_runs: 0, cancelled: 0 });
  assertEquals(state.steps[0].status, "queued");
  const empty = makeFakeAdmin({ runs: [], steps: [], audits: [], rpcCalls: [] });
  assertEquals(await sweepOrphanSteps(empty), { candidate_runs: 0, terminal_runs: 0, cancelled: 0 });
});

// ============================== RC-4: cheaper reserve on the timeout path ==============================

Deno.test("timeoutRequeueRequest: reserve model + low reasoning, visible cap and prompt kept, counter bumped", () => {
  const stored = {
    reasoning_effort: "medium",
    max_tokens: 10000,
    temperature: 0.4,
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    _validation_attempts: 0,
  };
  const out = timeoutRequeueRequest(stored);
  assertEquals(out.force_fallback, true);
  assertEquals(out.reasoning_effort, "low");
  assertEquals(out.max_tokens, 10000, "max_tokens is NOT shrunk — a smaller cap re-cuts a long draft");
  assertEquals(out._timeout_attempts, 1);
  assertEquals(out.messages, stored.messages);
  assertEquals(out.temperature, 0.4);
  assertEquals(out._validation_attempts, 0);
  // Input untouched.
  assertEquals(stored.reasoning_effort, "medium");
  assertEquals("force_fallback" in stored, false);
  // Second timeout increments again.
  assertEquals(timeoutRequeueRequest(out)._timeout_attempts, 2);
  assertEquals(timeoutRequeueRequest(undefined)._timeout_attempts, 1);
});

Deno.test("staleRequeueRequest: watchdog rescue forces the fallback on the first rescue and stays sticky, low reasoning", () => {
  const first = staleRequeueRequest({ reasoning_effort: "high", max_tokens: 8000 }, 1);
  assertEquals(first.force_fallback, true);
  assertEquals(first.reasoning_effort, "low");
  assertEquals(first.max_tokens, 8000);
  assertEquals(first._attempts, 1);
  const zero = staleRequeueRequest({ reasoning_effort: "high" }, 0);
  assertEquals(zero.force_fallback, false, "attempt 0 does not force the fallback");
  assertEquals(zero.reasoning_effort, "low");
  const sticky = staleRequeueRequest({ force_fallback: true }, 0);
  assertEquals(sticky.force_fallback, true, "once forced, never back to the primary");
});

Deno.test("resetRequestForResume: a markdown continuation strips its replayed assistant turn + continue instruction", () => {
  const base = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  const out = resetRequestForResume(
    {
      _validation_retry_mode: "continuation",
      _validation_attempts: 1,
      reasoning_effort: "low",
      messages: [...base, { role: "assistant", content: "# Plan\n\nHalf a doc" }, { role: "user", content: "Continue exactly from the last complete sentence. Do not repeat anything." }],
    },
    "stuck_model_call",
  );
  assertEquals(out.messages, base);
  assertEquals("_validation_retry_mode" in out, false);
  assertEquals(out._validation_attempts, 0);
});

// RC-6: the Strategist skips backend-only chunks, so a chunk may hold only
// two queued seats. Both completing is full coverage, not a missing seat.
Deno.test("auditSeatCoverage: a two-seat chunk (no strategist) counts as fully covered when both complete", () => {
  const rows = [
    { step_key: "audit_inspector_c1", status: "completed" },
    { step_key: "audit_contrarian_c1", status: "completed" },
    { step_key: "audit_inspector_c2", status: "completed" },
    { step_key: "audit_contrarian_c2", status: "completed" },
    { step_key: "audit_strategist_c2", status: "completed" },
  ];
  const cov = auditSeatCoverage(rows);
  assertEquals(cov.ok, true);
  assertEquals(cov.missing, []);
  assertEquals(cov.completed, 5);
  assertEquals(cov.total, 5);
  // One of the two seats failing still leaves the chunk touched.
  const oneDown = auditSeatCoverage(rows.map((r) => r.step_key === "audit_contrarian_c1" ? { ...r, status: "failed" } : r));
  assertEquals(oneDown.ok, true);
  assertEquals(oneDown.missing, ["audit_contrarian_c1"]);
});

// ============================== Seat cap pause (RC-10) ==============================

Deno.test("seatCapPause: step back to queued, run paused_budget naming seat / cap / spent, seat-scoped alert", () => {
  const pause = seatCapPause({ seat: "strategist", cap: 10, spent: 10.2345 }, { kind: "plan" });
  assertEquals(pause.step, { status: "queued", error: "seat_cap" });
  assertEquals(pause.run.status, "paused_budget");
  assertEquals(pause.run.error.includes("strategist"), true);
  assertEquals(pause.run.error.includes("$10.00"), true);
  assertEquals(pause.run.error.includes("$10.23"), true);
  assertEquals(pause.run.error.includes("Settings"), true);
  assertEquals(pause.alert, { scope: "seat", seat: "strategist", cap_usd: 10, spent_usd: 10.2345, run_kind: "plan" });
  // Never throws on a sparse error / missing run.
  const sparse = seatCapPause({ seat: "chair", cap: Number.NaN, spent: Number.NaN }, null);
  assertEquals(sparse.alert, { scope: "seat", seat: "chair", cap_usd: 0, spent_usd: 0, run_kind: null });
});

// ============================== Transient infra errors ==============================

Deno.test("isTransientInfraError: only the two RPC failure prefixes qualify", () => {
  assertEquals(isTransientInfraError("claim_run_step_with_capacity failed: deadlock detected"), true);
  assertEquals(isTransientInfraError("record_model_call_atomic failed: canceling statement due to statement timeout"), true);
  assertEquals(isTransientInfraError("Model x not in allowlist"), false);
  assertEquals(isTransientInfraError("something record_model_call_atomic failed"), false);
  assertEquals(isTransientInfraError(null), false);
});

Deno.test("decideInfraRequeue: fresh requeue on the same request up to INFRA_REQUEUE_MAX, then terminal", () => {
  assertEquals(INFRA_REQUEUE_MAX, 2);
  const base = { messages: [{ role: "user", content: "x" }], max_tokens: 900, force_fallback: true };
  const first = decideInfraRequeue({ request: base });
  assertEquals(first.action, "requeue");
  assertEquals(first.attempts, 1);
  if (first.action === "requeue") {
    // Same model (force_fallback untouched), same budget, counter carried.
    assertEquals(first.request, { ...base, _infra_attempts: 1 });
  }
  const second = decideInfraRequeue({ request: { ...base, _infra_attempts: 1 } });
  assertEquals(second.action, "requeue");
  assertEquals(second.attempts, 2);
  const third = decideInfraRequeue({ request: { ...base, _infra_attempts: 2 } });
  assertEquals(third.action, "terminal");
  assertEquals(third.attempts, 3);
  // No request at all still counts from zero.
  assertEquals(decideInfraRequeue({}).action, "requeue");
});

Deno.test("resetRequestForResume: clears the infra attempt counter with the other markers", () => {
  const out = resetRequestForResume({ _infra_attempts: 2, _transport_attempts: 1 }, "some error");
  assertEquals(out._infra_attempts, 0);
  assertEquals(out._transport_attempts, 0);
});

// ---------------------------------------------------------------- Batch 17: executor markers

Deno.test("resetRequestForResume: clears the four executor markers so a retry gets the executor and a fresh refusal budget", () => {
  const stored = {
    json_output: true,
    _refusal_attempts: 2,
    _refusal_fallback: true,
    _executor_bypass: true,
    _executor_errors: 2,
    _attempts: 1,
  };
  const out = resetRequestForResume(stored, "executor_call_lost");
  assertEquals("_refusal_attempts" in out, false);
  assertEquals("_refusal_fallback" in out, false);
  assertEquals("_executor_bypass" in out, false);
  assertEquals("_executor_errors" in out, false);
  assertEquals(out._attempts, 0);
  assertEquals(out.json_output, true, "other keys survive");
  // Input is not mutated.
  assertEquals(stored._executor_bypass, true);
  assertEquals(stored._executor_errors, 2);
});

Deno.test("requeueStepIfParentActive: p_expect_call_id is OMITTED when undefined (inline payload unchanged) and forwarded when defined", async () => {
  const calls: any[] = [];
  const admin: any = {
    rpc: (name: string, args: any) => {
      calls.push({ name, args });
      return Promise.resolve({ data: "requeued", error: null });
    },
  };
  assertEquals(await requeueStepIfParentActive(admin, "s1", { a: 1 }, "timeout_failover"), "requeued");
  assertEquals(calls[0].name, "requeue_step_if_parent_active");
  assertEquals(Object.keys(calls[0].args).sort(), ["p_new_error", "p_new_request", "p_step_id"]);
  assertEquals("p_expect_call_id" in calls[0].args, false);

  assertEquals(await requeueStepIfParentActive(admin, "s1", { a: 1 }, "executor_call_lost", "s1-3"), "requeued");
  assertEquals(calls[1].args, { p_step_id: "s1", p_new_request: { a: 1 }, p_new_error: "executor_call_lost", p_expect_call_id: "s1-3" });
});

Deno.test("requeueStepIfParentActive: maps the RPC's 'stale_call' verbatim; unknown strings still collapse to not_found", async () => {
  const stale: any = { rpc: () => Promise.resolve({ data: "stale_call", error: null }) };
  assertEquals(await requeueStepIfParentActive(stale, "s1", {}, "x", "s1-1"), "stale_call");
  const odd: any = { rpc: () => Promise.resolve({ data: "something_else", error: null }) };
  assertEquals(await requeueStepIfParentActive(odd, "s1", {}, "x"), "not_found");
});

Deno.test("failRun / sweepOrphanSteps regression: still keyed on queued/running only, no executor columns touched", async () => {
  // A row that is 'running' with an executor call id in flight is cancelled
  // like any other running row (the collector later ledgers its real usage
  // and clears the columns — hygiene never touches them).
  const state = {
    runs: [{ id: "r1", status: "running", error: null }],
    steps: [
      { id: "s1", run_id: "r1", status: "running", started_at: "t", created_at: "t", error: null, executor_call_id: "s1-1" } as any,
      { id: "s2", run_id: "r1", status: "queued", started_at: null, created_at: "t", error: null, executor_call_id: null } as any,
      { id: "s3", run_id: "r1", status: "completed", started_at: "t", created_at: "t", error: null, executor_call_id: null } as any,
    ],
    audits: [],
    rpcCalls: [],
  };
  const admin = makeFakeAdmin(state);
  assertEquals(await failRun(admin, { id: "r1" }, "owner cancel"), "won");
  assertEquals(state.steps.map((s: any) => s.status), ["failed", "failed", "completed"]);
  assertEquals(state.steps[0].executor_call_id, "s1-1", "call id deliberately kept on the failed row (spec §5.5)");
});
