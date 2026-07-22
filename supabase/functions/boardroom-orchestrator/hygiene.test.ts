// Deno tests for terminal-parent hygiene primitives. Uses a minimal in-memory
// stand-in for supabase-js query builders — enough to prove first-terminal-
// wins semantics and legacy-orphan routing without booting the real client.
import { assertEquals } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  failRun,
  requeueLegacyNullStartOrphans,
  requeueStepIfParentActive,
  TERMINAL_RUN_STATUSES,
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

function makeFakeAdmin(state: { runs: Run[]; steps: Step[]; audits: any[]; rpcCalls: any[] }) {
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
      table === "audits" ? state.audits : [];

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
