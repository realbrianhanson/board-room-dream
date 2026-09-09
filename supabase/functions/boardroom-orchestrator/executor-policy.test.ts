// Batch 17 — pure executor decisions (spec §12, "executor-policy.test.ts").
// Run: cd supabase/functions && deno test boardroom-orchestrator/executor-policy.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  budgetPausePatch,
  buildExecutorMeta,
  decideOnPoll,
  errorFromExecutor,
  EXECUTOR_COLLECT_BUDGET_MS,
  EXECUTOR_DEFAULT_TIMEOUT_MS,
  EXECUTOR_DISPATCH_MAX,
  EXECUTOR_GRACE_MS,
  EXECUTOR_LOW_EFFORT_FLOOR_MS,
  EXECUTOR_MAX_TIMEOUT_MS,
  EXECUTOR_MIN_TIMEOUT_MS,
  EXECUTOR_MODEL_TIMEOUTS_MS,
  EXECUTOR_POLL_FAILURE_MAX,
  EXECUTOR_REDISPATCH_WINDOW_MS,
  EXECUTOR_UNREACHABLE_BREAKER,
  executorMode,
  executorTimeoutMs,
  fromMeta,
  isWellFormedCallOutput,
  lostRequeueRequest,
  parseExecutorSettings,
  refusalRequeueDecision,
  type ExecutorMeta,
} from "./executor-policy.ts";
import {
  decideTransportRequeue,
  isBodyTransportError,
  REFUSAL_RETRY_WINDOW_MS,
  shouldQuickRetry,
} from "../_shared/openrouter-proxy.ts";
import { EXECUTOR_FIXTURES } from "../_shared/executor-protocol.ts";
import type { PollResult } from "../_shared/executor-client.ts";

const ENV = { url: "https://boardroom-executor.example.workers.dev", secret: "s" };

// -------- constants (§6.6) --------

Deno.test("constants match §6.6 and the collector budget leaves the inline step its 120 s", () => {
  assertEquals(EXECUTOR_DEFAULT_TIMEOUT_MS, 360_000);
  assertEquals(EXECUTOR_MAX_TIMEOUT_MS, 900_000);
  assertEquals(EXECUTOR_MIN_TIMEOUT_MS, 30_000);
  assertEquals(EXECUTOR_GRACE_MS, 90_000);
  assertEquals(EXECUTOR_REDISPATCH_WINDOW_MS, 180_000);
  assertEquals(EXECUTOR_POLL_FAILURE_MAX, 10);
  assertEquals(EXECUTOR_DISPATCH_MAX, 3);
  assertEquals(EXECUTOR_COLLECT_BUDGET_MS, 20_000);
  assertEquals(EXECUTOR_UNREACHABLE_BREAKER, 3);
  // 150 s isolate − 120 s STEP_HARD_TIMEOUT_MS − ~10 s headroom (§5.2).
  assert(EXECUTOR_COLLECT_BUDGET_MS + 120_000 + 10_000 <= 150_000);
  assertEquals(EXECUTOR_MODEL_TIMEOUTS_MS["anthropic/claude-fable-5.1"], 720_000);
  assertEquals(EXECUTOR_MODEL_TIMEOUTS_MS["anthropic/claude-haiku-4.5"], 180_000);
});

// -------- parseExecutorSettings (§4) --------

Deno.test("parseExecutorSettings: missing row / non-object → null; fields validated", () => {
  assertEquals(parseExecutorSettings(null), null);
  assertEquals(parseExecutorSettings(undefined), null);
  assertEquals(parseExecutorSettings(true), null);
  assertEquals(parseExecutorSettings([1]), null);
  assertEquals(parseExecutorSettings({}), {});
  assertEquals(parseExecutorSettings({ enabled: false }), { enabled: false });
  assertEquals(parseExecutorSettings({ enabled: "yes", transport: "grpc" }), {});
  assertEquals(
    parseExecutorSettings({ enabled: true, transport: "json", timeouts_ms: { default: 100_000, by_model: { a: 5, b: "x", c: -1 } }, junk: 1 }),
    { enabled: true, transport: "json", timeouts_ms: { default: 100_000, by_model: { a: 5 } } },
  );
  assertEquals(parseExecutorSettings({ timeouts_ms: { default: "nope" } }), {});
});

// -------- executorMode truth table (§4) --------

Deno.test("executorMode: env × flag × consensus.executor × bypass", () => {
  const on = { enabled: true };
  const off = { enabled: false };
  // null env → inline whatever else says
  assertEquals(executorMode(null, on, { consensus: { executor: true } }, { request: {} }), "inline");
  // flag decides when nothing overrides
  assertEquals(executorMode(ENV, on, { consensus: {} }, { request: {} }), "executor");
  assertEquals(executorMode(ENV, off, { consensus: {} }, { request: {} }), "inline");
  assertEquals(executorMode(ENV, null, null, null), "inline");
  assertEquals(executorMode(ENV, {}, { consensus: null }, { request: null }), "inline");
  // per-run override beats the flag both ways
  assertEquals(executorMode(ENV, off, { consensus: { executor: true } }, { request: {} }), "executor");
  assertEquals(executorMode(ENV, on, { consensus: { executor: false } }, { request: {} }), "inline");
  // non-boolean override is ignored
  assertEquals(executorMode(ENV, on, { consensus: { executor: "true" } }, { request: {} }), "executor");
  assertEquals(executorMode(ENV, off, { consensus: { executor: 1 } }, { request: {} }), "inline");
  // bypass beats everything but a null env
  assertEquals(executorMode(ENV, on, { consensus: { executor: true } }, { request: { _executor_bypass: true } }), "inline");
  assertEquals(executorMode(ENV, on, { consensus: {} }, { request: { _executor_bypass: "true" } }), "executor");
});

// -------- executorTimeoutMs (§6.6) --------

Deno.test("executorTimeoutMs: table, default, overrides, low effort, clamps", () => {
  assertEquals(executorTimeoutMs("anthropic/claude-fable-5.1", "high"), 720_000);
  assertEquals(executorTimeoutMs("anthropic/claude-fable-5.1", undefined), 720_000);
  assertEquals(executorTimeoutMs("openai/gpt-6-astra", "medium"), 600_000);
  assertEquals(executorTimeoutMs("some/unknown-model", "high"), EXECUTOR_DEFAULT_TIMEOUT_MS);
  // overrides.default only fills in for models not in the table
  assertEquals(executorTimeoutMs("some/unknown-model", "high", { default: 200_000 }), 200_000);
  assertEquals(executorTimeoutMs("anthropic/claude-fable-5.1", "high", { default: 200_000 }), 720_000);
  // by_model beats the table
  assertEquals(executorTimeoutMs("anthropic/claude-fable-5.1", "high", { by_model: { "anthropic/claude-fable-5.1": 300_000 } }), 300_000);
  // low effort ×0.6 with the 120 s floor
  assertEquals(executorTimeoutMs("anthropic/claude-fable-5.1", "low"), 432_000);
  assertEquals(executorTimeoutMs("anthropic/claude-haiku-4.5", "low"), EXECUTOR_LOW_EFFORT_FLOOR_MS); // 108 s → floor 120 s
  // the floor never raises a timeout above its own base
  assertEquals(executorTimeoutMs("x", "low", { default: 60_000 }), 60_000);
  // clamps
  assertEquals(executorTimeoutMs("x", "high", { default: 5_000_000 }), EXECUTOR_MAX_TIMEOUT_MS);
  assertEquals(executorTimeoutMs("x", "high", { default: 1_000 }), EXECUTOR_MIN_TIMEOUT_MS);
  assertEquals(executorTimeoutMs("x", "high", { by_model: { x: 0 } }), EXECUTOR_DEFAULT_TIMEOUT_MS);
});

// -------- buildExecutorMeta / fromMeta (§3.3) --------

const PREP = {
  userId: "u1",
  seat: "chair",
  options: { runId: "r1", projectId: "p1", json: true, reasoningEffort: "high" as const, smoke: false },
  seatRow: { seat: "chair", model_id: "anthropic/claude-fable-5.1", role_prompt: null, enabled: true, fallback_model_id: "openai/gpt-6-astra", max_cost_per_run: null } as any,
  smokeSource: undefined,
  modelId: "anthropic/claude-fable-5.1",
  primaryModelId: "anthropic/claude-fable-5.1",
  fallbackModelId: "openai/gpt-6-astra",
  body: EXECUTOR_FIXTURES.dispatch.openrouter.body,
  apiKey: "sk-or-v1-SECRET-KEY-MUST-NOT-LEAK",
  wireMaxTokens: 16_000,
  promptChars: JSON.stringify(EXECUTOR_FIXTURES.dispatch.openrouter.body.messages).length,
};

Deno.test("buildExecutorMeta: §3.3 shape, deadline = now + timeout + grace, no key / no messages", () => {
  const now = "2026-09-09T17:04:11.412Z";
  const meta = buildExecutorMeta(PREP as any, "6c0f-1", 720_000, "sse", now, "2026-09-09.executor.r1", false);
  assertEquals(meta.call_id, "6c0f-1");
  assertEquals(meta.seat, "chair");
  assertEquals(meta.model_id, "anthropic/claude-fable-5.1");
  assertEquals(meta.primary_model_id, "anthropic/claude-fable-5.1");
  assertEquals(meta.fallback_model_id, "openai/gpt-6-astra");
  assertEquals(meta.fallback_allowed, true);
  assertEquals(meta.force_fallback, false);
  assertEquals(meta.smoke_source, null);
  assertEquals(meta.json, true);
  assertEquals(meta.wire_max_tokens, 16_000);
  assertEquals(meta.prompt_chars, PREP.promptChars);
  assertEquals(meta.timeout_ms, 720_000);
  assertEquals(meta.deadline_at, new Date(Date.parse(now) + 720_000 + EXECUTOR_GRACE_MS).toISOString());
  assertEquals(meta.transport, "sse");
  assertEquals(meta.dispatch_attempts, 1);
  assertEquals(meta.poll_failures, 0);
  assertEquals(meta.last_state, null);
  assertEquals(meta.last_polled_at, null);
  assertEquals(meta.orchestrator_build, "2026-09-09.executor.r1");
  const json = JSON.stringify(meta);
  assert(!json.includes("SECRET-KEY"));
  assert(!json.includes("apiKey"));
  assert(!json.includes("api_key"));
  assert(!json.includes("messages"));
  assert(!json.includes("CONSTITUTION"));
});

Deno.test("buildExecutorMeta: fallback not allowed when prepareSeatCall resolved none; smoke source carried", () => {
  const meta = buildExecutorMeta(
    { ...PREP, fallbackModelId: null, smokeSource: "smoke", modelId: "openai/gpt-6-astra" } as any,
    "c-2", 180_000, "json", "2026-09-09T00:00:00.000Z", "b", true,
  );
  assertEquals(meta.fallback_allowed, false);
  assertEquals(meta.fallback_model_id, null);
  assertEquals(meta.force_fallback, true);
  assertEquals(meta.smoke_source, "smoke");
  assertEquals(meta.transport, "json");
});

Deno.test("fromMeta: rebuilds settleSeatCall's p from the row + run, never from a body", () => {
  const meta = buildExecutorMeta({ ...PREP, smokeSource: "inspector" } as any, "c-1", 720_000, "sse", "2026-09-09T00:00:00.000Z", "b", true);
  const p = fromMeta(meta, { id: "r1", project_id: "p1", user_id: "u1" }, { request: { reasoning_effort: "low" } });
  assertEquals(p.userId, "u1");
  assertEquals(p.seat, "chair");
  assertEquals(p.modelId, "anthropic/claude-fable-5.1");
  assertEquals(p.primaryModelId, "anthropic/claude-fable-5.1");
  assertEquals(p.smokeSource, "inspector");
  assertEquals(p.options.runId, "r1");
  assertEquals(p.options.projectId, "p1");
  assertEquals(p.options.json, true);
  assertEquals(p.options.forceFallback, true);
  assertEquals(p.options.reasoningEffort, "low");
  assertEquals(p.options.smoke, true);
  assertEquals(p.wireMaxTokens, 16_000);
  assertEquals(p.jsonMode, true);
  assertEquals(p.promptChars, PREP.promptChars);
  const p2 = fromMeta({ ...meta, smoke_source: null }, { id: "r1", project_id: null, user_id: "u1" }, { request: {} });
  assertEquals(p2.smokeSource, undefined);
  assertEquals(p2.options.projectId, undefined);
  assertEquals(p2.options.smoke, undefined);
});

// -------- decideOnPoll (§5.6) --------

const T0 = Date.parse("2026-09-09T17:00:00.000Z");
function row(over: Partial<{ status: string; dispatchedAt: number; meta: Partial<ExecutorMeta> | null }> = {}) {
  const dispatchedAt = over.dispatchedAt ?? T0;
  const base = buildExecutorMeta(PREP as any, "c-1", 600_000, "sse", new Date(dispatchedAt).toISOString(), "b", false);
  const meta = over.meta === null ? null : { ...base, ...(over.meta ?? {}) };
  return { status: over.status ?? "running", executor_dispatched_at: new Date(dispatchedAt).toISOString(), executor_meta: meta };
}
const state = (s: string, output: any = null): PollResult => ({ kind: "state", state: s, output, engine_error: null });
const NOT_FOUND: PollResult = { kind: "not_found" };
const UNREACH: PollResult = { kind: "unreachable", message: "boom" };
const BEFORE = T0 + 60_000; // well inside the deadline
const AFTER = T0 + 600_000 + EXECUTOR_GRACE_MS; // exactly the deadline

Deno.test("decideOnPoll: queued / running / waiting / paused → wait before the deadline", () => {
  for (const s of ["queued", "running", "waiting", "paused"]) {
    assertEquals(decideOnPoll(row(), state(s), BEFORE, true), { action: "wait" }, s);
  }
});

Deno.test("decideOnPoll: complete settles by output.ok, whatever the clock says", () => {
  assertEquals(decideOnPoll(row(), state("complete", EXECUTOR_FIXTURES.okOutput), BEFORE, true), { action: "settle_ok", output: EXECUTOR_FIXTURES.okOutput });
  assertEquals(decideOnPoll(row(), state("complete", EXECUTOR_FIXTURES.timeoutOutput), AFTER + 1, true), { action: "settle_error", output: EXECUTOR_FIXTURES.timeoutOutput });
  assertEquals(decideOnPoll(row({ status: "failed" }), state("complete", EXECUTOR_FIXTURES.okOutput), AFTER + 1, true), { action: "settle_ok", output: EXECUTOR_FIXTURES.okOutput });
  assertEquals(decideOnPoll(row(), state("complete", null), BEFORE, true), { action: "lost", reason: "complete_without_output" });
});

Deno.test("isWellFormedCallOutput: ok boolean plus the half the flag promises, as an object", () => {
  assert(isWellFormedCallOutput(EXECUTOR_FIXTURES.okOutput));
  assert(isWellFormedCallOutput(EXECUTOR_FIXTURES.timeoutOutput));
  assert(!isWellFormedCallOutput(null));
  assert(!isWellFormedCallOutput("complete"));
  assert(!isWellFormedCallOutput({}));
  assert(!isWellFormedCallOutput({ ok: "true", response: {} }));
  assert(!isWellFormedCallOutput({ ok: true }));
  assert(!isWellFormedCallOutput({ ok: true, response: null }));
  assert(!isWellFormedCallOutput({ ok: true, response: "gen-1" }));
  assert(!isWellFormedCallOutput({ ok: false }));
  assert(!isWellFormedCallOutput({ ok: false, error: "timeout" }));
  assert(isWellFormedCallOutput({ ok: false, error: { kind: "timeout", message: "", model: "m" } }));
});

Deno.test("decideOnPoll: a complete instance with a malformed output is `lost`, never a settle that would throw on every tick", () => {
  // ok:true without a response object would make parseOpenRouterResponse
  // throw inside settleSeatCall; because `complete` beats the deadline clock
  // that row would otherwise have no exit. lost → requeue (bypass at 2).
  assertEquals(decideOnPoll(row(), state("complete", { ok: true }), BEFORE, true), { action: "lost", reason: "malformed_output" });
  assertEquals(decideOnPoll(row(), state("complete", { ok: true, response: "gen-1" }), AFTER + 1, true), { action: "lost", reason: "malformed_output" });
  assertEquals(decideOnPoll(row(), state("complete", { ok: false }), BEFORE, true), { action: "lost", reason: "malformed_output" });
  assertEquals(decideOnPoll(row(), state("complete", { ok: "yes" }), BEFORE, true), { action: "lost", reason: "malformed_output" });
});

Deno.test("decideOnPoll: errored / terminated → lost", () => {
  assertEquals(decideOnPoll(row(), state("errored"), BEFORE, true), { action: "lost", reason: "errored" });
  assertEquals(decideOnPoll(row(), state("terminated"), BEFORE, true), { action: "lost", reason: "terminated" });
});

Deno.test("decideOnPoll: errored / terminated stay `lost` past the deadline — no usage arrived, so no :timeout estimate", () => {
  // An instance that errored early (unseal failure) but is first observed
  // after deadline_at (the Worker was unreachable across it) must be
  // released, not charged. Same for a non-running row.
  assertEquals(decideOnPoll(row(), state("errored"), AFTER, true), { action: "lost", reason: "errored" });
  assertEquals(decideOnPoll(row(), state("terminated"), AFTER + 60_000, true), { action: "lost", reason: "terminated" });
  assertEquals(decideOnPoll(row({ status: "failed" }), state("errored"), AFTER, true), { action: "lost", reason: "errored" });
});

Deno.test("decideOnPoll: unknown / unrecognised state counts as unreachable, bounded by the failure cap", () => {
  assertEquals(decideOnPoll(row(), state("unknown"), BEFORE, true), { action: "unreachable" });
  assertEquals(decideOnPoll(row(), state("wat"), BEFORE, true), { action: "unreachable" });
  assertEquals(decideOnPoll(row({ meta: { poll_failures: EXECUTOR_POLL_FAILURE_MAX - 2 } }), state("unknown"), BEFORE, true), { action: "unreachable" });
  assertEquals(decideOnPoll(row({ meta: { poll_failures: EXECUTOR_POLL_FAILURE_MAX - 1 } }), state("unknown"), BEFORE, true), { action: "lost", reason: "poll_failures_exhausted" });
});

Deno.test("decideOnPoll: transport failure → unreachable; the 10th → lost", () => {
  assertEquals(decideOnPoll(row(), UNREACH, BEFORE, true), { action: "unreachable" });
  assertEquals(decideOnPoll(row({ meta: { poll_failures: 8 } }), UNREACH, BEFORE, true), { action: "unreachable" });
  assertEquals(decideOnPoll(row({ meta: { poll_failures: 9 } }), UNREACH, BEFORE, true), { action: "lost", reason: "poll_failures_exhausted" });
  // a null poll with env present is a poll that never happened → unreachable
  assertEquals(decideOnPoll(row(), null, BEFORE, true), { action: "unreachable" });
});

Deno.test("decideOnPoll: deadline beats wait / unreachable / unknown once now ≥ deadline_at", () => {
  assertEquals(decideOnPoll(row(), state("running"), AFTER, true), { action: "deadline" });
  assertEquals(decideOnPoll(row(), state("paused"), AFTER + 5, true), { action: "deadline" });
  assertEquals(decideOnPoll(row(), UNREACH, AFTER, true), { action: "deadline" });
  assertEquals(decideOnPoll(row(), state("unknown"), AFTER, true), { action: "deadline" });
  assertEquals(decideOnPoll(row(), state("running"), AFTER - 1, true), { action: "wait" });
  // a paused instance still counts against the deadline
  assertEquals(decideOnPoll(row(), state("paused"), AFTER - 1, true), { action: "wait" });
  // the deadline applies to a cancelled (non-running) row too
  assertEquals(decideOnPoll(row({ status: "failed" }), state("running"), AFTER, true), { action: "deadline" });
});

Deno.test("decideOnPoll: deadline falls back to dispatched_at + timeout + grace when meta has no deadline_at", () => {
  const r = row({ meta: { deadline_at: undefined as any, timeout_ms: 300_000 } });
  assertEquals(decideOnPoll(r, state("running"), T0 + 300_000 + EXECUTOR_GRACE_MS - 1, true), { action: "wait" });
  assertEquals(decideOnPoll(r, state("running"), T0 + 300_000 + EXECUTOR_GRACE_MS, true), { action: "deadline" });
  // no meta at all: the default timeout
  const bare = row({ meta: null });
  assertEquals(decideOnPoll(bare, state("running"), T0 + EXECUTOR_DEFAULT_TIMEOUT_MS + EXECUTOR_GRACE_MS - 1, true), { action: "wait" });
  assertEquals(decideOnPoll(bare, state("running"), T0 + EXECUTOR_DEFAULT_TIMEOUT_MS + EXECUTOR_GRACE_MS, true), { action: "deadline" });
});

Deno.test("decideOnPoll: not_found → redispatch inside the 180 s window while dispatch_attempts < 3, else lost", () => {
  assertEquals(decideOnPoll(row(), NOT_FOUND, T0 + 1_000, true), { action: "redispatch" });
  assertEquals(decideOnPoll(row(), NOT_FOUND, T0 + EXECUTOR_REDISPATCH_WINDOW_MS - 1, true), { action: "redispatch" });
  assertEquals(decideOnPoll(row(), NOT_FOUND, T0 + EXECUTOR_REDISPATCH_WINDOW_MS, true), { action: "lost", reason: "not_found" });
  assertEquals(decideOnPoll(row({ meta: { dispatch_attempts: 2 } }), NOT_FOUND, T0 + 1_000, true), { action: "redispatch" });
  assertEquals(decideOnPoll(row({ meta: { dispatch_attempts: EXECUTOR_DISPATCH_MAX } }), NOT_FOUND, T0 + 1_000, true), { action: "lost", reason: "dispatch_attempts_exhausted" });
  // a row that never got its meta (died between reserve and the meta write) re-dispatches
  assertEquals(decideOnPoll(row({ meta: null }), NOT_FOUND, T0 + 1_000, true), { action: "redispatch" });
  // not_found is never turned into a deadline: nothing ran, nothing to estimate
  assertEquals(decideOnPoll(row(), NOT_FOUND, AFTER + 1, true), { action: "lost", reason: "not_found" });
});

Deno.test("decideOnPoll: env absent → no_env until the deadline, then deadline; the poll is ignored", () => {
  assertEquals(decideOnPoll(row(), null, BEFORE, false), { action: "no_env" });
  assertEquals(decideOnPoll(row(), state("complete", EXECUTOR_FIXTURES.okOutput), BEFORE, false), { action: "no_env" });
  assertEquals(decideOnPoll(row(), null, AFTER, false), { action: "deadline" });
  assertEquals(decideOnPoll(row({ status: "failed" }), null, AFTER, false), { action: "deadline" });
});

Deno.test("decideOnPoll: a settled row still carrying its id is `deadline` for no_env / unreachable — the backstop, not the decision, consults the ledger", () => {
  // decideOnPoll never sees cost_ledger: with the secrets deleted (§13.7b) or
  // the Worker unreachable past the deadline, a completed / failed row whose
  // real usage is already under <C> still decides `deadline`. The no-second-
  // charge guarantee therefore lives in recordTimeoutEstimate (skipped when
  // <C> exists) and in the owning settle clearing the columns once the row is
  // terminal, so such rows stop being selected at all.
  for (const status of ["completed", "failed"]) {
    assertEquals(decideOnPoll(row({ status }), null, AFTER, false), { action: "deadline" }, `${status} no_env`);
    assertEquals(decideOnPoll(row({ status }), UNREACH, AFTER, true), { action: "deadline" }, `${status} unreachable`);
    assertEquals(decideOnPoll(row({ status }), state("unknown"), AFTER, true), { action: "deadline" }, `${status} unknown`);
    // before the deadline a settled row is only ever waited on / left alone
    assertEquals(decideOnPoll(row({ status }), null, BEFORE, false), { action: "no_env" });
    assertEquals(decideOnPoll(row({ status }), state("running"), BEFORE, true), { action: "wait" });
  }
});

// -------- errorFromExecutor (§6.5) --------

Deno.test("errorFromExecutor: timeout / idle are ProxyTimeoutErrors the timeout branch recognises", () => {
  const t: any = errorFromExecutor({ kind: "timeout", message: "m", model: "anthropic/claude-fable-5.1", ms: 720_000 });
  assertEquals(t.isTimeout, true);
  assertEquals(t.attemptedModel, "anthropic/claude-fable-5.1");
  assertEquals(t.ms, 720_000);
  assertEquals(t.name, "ProxyTimeoutError");
  assertStringIncludes(t.message, "timed out after 720000ms");
  assertEquals(shouldQuickRetry(t), false);
  assertEquals(isBodyTransportError(t), false);
  const i: any = errorFromExecutor({ kind: "idle", message: "m", model: "x", ms: 90_000 });
  assertEquals(i.isTimeout, true);
  assertEquals(i.executorKind, "idle");
  assertEquals(shouldQuickRetry(i), false);
});

Deno.test("errorFromExecutor: upstream_status carries .status and quick-retries exactly like the proxy's own", () => {
  const e429: any = errorFromExecutor({ kind: "upstream_status", status: 429, message: "Rate limited", model: "x" });
  assertEquals(e429.status, 429);
  assertEquals(e429.isPreResponse, false);
  assertEquals(e429.message, "OpenRouter 429: Rate limited");
  assertEquals(shouldQuickRetry(e429), true);
  const e503: any = errorFromExecutor({ kind: "upstream_status", status: 503, message: "bad gw", model: "x" });
  assertEquals(shouldQuickRetry(e503), true);
  const e400: any = errorFromExecutor({ kind: "upstream_status", status: 400, message: "bad req", model: "x" });
  assertEquals(shouldQuickRetry(e400), false);
  assertEquals(isBodyTransportError(e400), false);
  assertEquals(e400.isTimeout, undefined);
  const noStatus: any = errorFromExecutor({ kind: "upstream_status", message: "?", model: "x" });
  assertEquals(noStatus.status, undefined);
  assertEquals(shouldQuickRetry(noStatus), false);
});

Deno.test("errorFromExecutor: pre_response quick-retries; body_transport goes to decideTransportRequeue; bad_dispatch is generic", () => {
  const pre: any = errorFromExecutor({ kind: "pre_response", message: "socket hangup", model: "x" });
  assertEquals(pre.isPreResponse, true);
  assertEquals(shouldQuickRetry(pre), true);
  assertEquals(isBodyTransportError(pre), false);
  const bt: any = errorFromExecutor({ kind: "body_transport", message: "stream cut", model: "x" });
  assertEquals(bt.isBodyTransport, true);
  assertEquals(bt.isPreResponse, false);
  assertEquals(bt.attemptedModel, "x");
  assertEquals(isBodyTransportError(bt), true);
  assertEquals(shouldQuickRetry(bt), false);
  assertEquals(decideTransportRequeue({ step_key: "k", request: {} }), { action: "requeue", attempts: 1 });
  const bd: any = errorFromExecutor({ kind: "bad_dispatch", message: "callback host not allowed", model: "x" });
  assertEquals(bd.message, "callback host not allowed");
  assertEquals(shouldQuickRetry(bd), false);
  assertEquals(isBodyTransportError(bd), false);
  assertEquals(bd.isTimeout, undefined);
  const unk: any = errorFromExecutor({ kind: "???" as any, message: "", model: "x" });
  assertStringIncludes(unk.message, "executor failure");
});

// -------- refusalRequeueDecision (§5.7) --------

Deno.test("refusalRequeueDecision: same-model retry, then fallback, then accept — only inside the 15 s window", () => {
  const first = refusalRequeueDecision({ messages: [], temperature: 0.4 }, 900, true);
  assertEquals(first, { action: "requeue", request: { messages: [], temperature: 0.4, _refusal_attempts: 1 }, error: "refusal_requeued" });
  const second = refusalRequeueDecision({ messages: [], _refusal_attempts: 1 }, 1_200, true);
  assertEquals(second, {
    action: "requeue",
    request: { messages: [], _refusal_attempts: 2, force_fallback: true, _refusal_fallback: true },
    error: "refusal_fallback_requeued",
  });
  // no fallback → accept after the first retry
  assertEquals(refusalRequeueDecision({ _refusal_attempts: 1 }, 1_200, false), { action: "accept" });
  // spent budget → accept
  assertEquals(refusalRequeueDecision({ _refusal_attempts: 2 }, 500, true), { action: "accept" });
  // slow refusal (≥ 15 s) → accept even on the first attempt
  assertEquals(refusalRequeueDecision({}, REFUSAL_RETRY_WINDOW_MS, true), { action: "accept" });
  assertEquals(refusalRequeueDecision({}, REFUSAL_RETRY_WINDOW_MS - 1, true).action, "requeue");
  assertEquals(refusalRequeueDecision(undefined, NaN, true), { action: "accept" });
  assertEquals(refusalRequeueDecision(null, 10, true).action, "requeue");
});

// -------- lostRequeueRequest (§5.6) --------

Deno.test("lostRequeueRequest: _executor_errors+1; bypass at the second", () => {
  assertEquals(lostRequeueRequest({ messages: [] }), { request: { messages: [], _executor_errors: 1 }, bypass: false });
  assertEquals(lostRequeueRequest({ _executor_errors: 1 }), { request: { _executor_errors: 2, _executor_bypass: true }, bypass: true });
  assertEquals(lostRequeueRequest({ _executor_errors: 5, force_fallback: true }), {
    request: { _executor_errors: 6, force_fallback: true, _executor_bypass: true },
    bypass: true,
  });
  assertEquals(lostRequeueRequest(undefined), { request: { _executor_errors: 1 }, bypass: false });
});

// -------- budgetPausePatch (§9.6) --------

Deno.test("budgetPausePatch: step from running only, run from queued/running only, for all three reasons", () => {
  for (const r of ["daily_cap", "budget", "seat_cap"] as const) {
    assertEquals(budgetPausePatch(r), { stepGuard: ["running"], runGuard: ["queued", "running"] });
  }
});
