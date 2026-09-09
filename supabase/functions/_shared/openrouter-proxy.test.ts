// Deterministic tests for the transport classifier and the requeue/terminal
// decision helper. Run: cd supabase/functions && deno test _shared/openrouter-proxy.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideTransportRequeue,
  estimateCost,
  isBodyTransportError,
  isBudgetExhausted,
  isRefusal,
  parseOpenRouterResponse,
  ProxyTimeoutError,
  reasoningAllowance,
  recordTimeoutEstimate,
  REFUSAL_RETRY_WINDOW_MS,
  settleSeatCall,
  settleSeatUsage,
  shouldQuickRetry,
  timeoutLedgerEstimate,
  timeoutLedgerSeat,
  TIMEOUT_LEDGER_SEAT_SUFFIX,
} from "./openrouter-proxy.ts";
import { EXECUTOR_FIXTURES } from "./executor-protocol.ts";

// --- classifier: true positives -------------------------------------------

Deno.test("isBodyTransportError — the exact live error string classifies", () => {
  const e: any = new TypeError("error reading a body from connection");
  assert(isBodyTransportError(e));
});

Deno.test("isBodyTransportError — connection reset / terminated classify", () => {
  for (const m of [
    "connection reset by peer",
    "connection was reset",
    "connection terminated",
    "connection closed before response",
    "socket hang up",
    "premature close of body stream",
    "incomplete chunked encoding",
    "network connection was lost mid-response",
  ]) {
    assert(isBodyTransportError(new TypeError(m)), `should classify: ${m}`);
  }
});

Deno.test("isBodyTransportError — nested cause is inspected", () => {
  const inner = new Error("connection reset");
  const outer: any = new TypeError("fetch failed");
  outer.cause = inner;
  assert(isBodyTransportError(outer));
});

Deno.test("isBodyTransportError — premature JSON end from body reader classifies", () => {
  // Deno's r.json() surfaces this when the body stream ends mid-parse.
  const e = new SyntaxError("Unexpected end of JSON input from body stream");
  assert(isBodyTransportError(e));
});

// --- classifier: false positives (MUST NOT match) -------------------------

Deno.test("isBodyTransportError — plain JSON syntax error is NOT transport", () => {
  // A fully-read body that happens to be invalid JSON is a downstream
  // model-output validation problem, not transport.
  const e = new SyntaxError("Unexpected token 'x', \"xxxxx\" is not valid JSON");
  assert(!isBodyTransportError(e), "plain JSON.parse SyntaxError must not classify as transport");
});

Deno.test("isBodyTransportError — timeout is NOT transport", () => {
  assert(!isBodyTransportError(new ProxyTimeoutError("m", 1000)));
});

Deno.test("isBodyTransportError — pre-response network failure is NOT transport", () => {
  const e: any = new Error("socket hang up");
  e.isPreResponse = true;
  assert(!isBodyTransportError(e));
});

Deno.test("isBodyTransportError — OpenRouter 4xx/5xx status errors are NOT transport", () => {
  const s429: any = new Error("Too Many Requests"); s429.status = 429;
  const s503: any = new Error("Bad Gateway"); s503.status = 503;
  const s400: any = new Error("Bad Request"); s400.status = 400;
  assert(!isBodyTransportError(s429));
  assert(!isBodyTransportError(s503));
  assert(!isBodyTransportError(s400));
});

Deno.test("isBodyTransportError — arbitrary Error without I/O verbs is NOT transport", () => {
  assert(!isBodyTransportError(new Error("something bad happened")));
  assert(!isBodyTransportError(null));
  assert(!isBodyTransportError(undefined));
  assert(!isBodyTransportError("string"));
});

// --- interaction with shouldQuickRetry -----------------------------------

Deno.test("shouldQuickRetry — body transport MUST NOT trigger same-invocation retry", () => {
  const e: any = new TypeError("error reading a body from connection");
  assert(!shouldQuickRetry(e), "body transport must never quick-retry inside the same invocation");
  // Even when explicitly tagged (as the proxy tags before rethrow).
  e.isBodyTransport = true;
  assert(!shouldQuickRetry(e));
});

Deno.test("shouldQuickRetry — 429 / 5xx / pre-response still quick-retry as before", () => {
  const s429: any = new Error("rate"); s429.status = 429;
  const s503: any = new Error("bad gw"); s503.status = 503;
  const pre: any = new Error("dropped"); pre.isPreResponse = true;
  assert(shouldQuickRetry(s429));
  assert(shouldQuickRetry(s503));
  assert(shouldQuickRetry(pre));
});

// --- state transition: requeue -> terminal --------------------------------

Deno.test("decideTransportRequeue — first failure requeues fresh, attempts=1", () => {
  const step = { step_key: "audit_inspector_c2", request: { messages: [] } };
  const d = decideTransportRequeue(step);
  assertEquals(d.action, "requeue");
  assertEquals(d.attempts, 1);
});

Deno.test("decideTransportRequeue — second failure is terminal with exhausted error", () => {
  const step = {
    step_key: "audit_inspector_c2",
    request: { messages: [], _transport_attempts: 1 },
  };
  const d = decideTransportRequeue(step);
  assertEquals(d.action, "terminal");
  assertEquals(d.attempts, 2);
  if (d.action === "terminal") {
    assertStringIncludes(d.message, "audit_inspector_c2");
    assertStringIncludes(d.message, "transport-retry-exhausted");
  }
});

Deno.test("decideTransportRequeue — counter is preserved across the transition", () => {
  const step: any = { step_key: "audit_contrarian_c2", request: {} };
  const first = decideTransportRequeue(step);
  assertEquals(first.action, "requeue");
  // Simulate the orchestrator persisting the incremented counter.
  step.request._transport_attempts = first.attempts;
  const second = decideTransportRequeue(step);
  assertEquals(second.action, "terminal");
});

// --- reasoning allowance: wire cap = visible budget + hidden-thinking room ---

Deno.test("reasoningAllowance — thinking-by-default families get room even with no effort set", () => {
  assertEquals(reasoningAllowance("google/gemini-3.1-pro"), 2500);
  assertEquals(reasoningAllowance("x-ai/grok-4.5"), 2500);
  assertEquals(reasoningAllowance("moonshotai/kimi-k3"), 2500);
  assertEquals(reasoningAllowance("qwen/qwen3.8-max-0902"), 2500);
});

Deno.test("reasoningAllowance — anthropic/openai get zero room when no effort is requested", () => {
  assertEquals(reasoningAllowance("anthropic/some-model"), 0);
  assertEquals(reasoningAllowance("openai/some-model"), 0);
  assertEquals(reasoningAllowance("", undefined), 0);
});

Deno.test("reasoningAllowance — effort table scales per family", () => {
  assertEquals(reasoningAllowance("google/gemini-3.1-pro", "low"), 2500);
  assertEquals(reasoningAllowance("google/gemini-3.1-pro", "medium"), 5000);
  assertEquals(reasoningAllowance("google/gemini-3.1-pro", "high"), 8000);
  assertEquals(reasoningAllowance("anthropic/some-model", "low"), 2500);
  assertEquals(reasoningAllowance("anthropic/some-model", "medium"), 4000);
  assertEquals(reasoningAllowance("openai/some-model", "high"), 6000);
  assertEquals(reasoningAllowance("qwen/qwen3.8-max-0902", "low"), 2500);
  assertEquals(reasoningAllowance("qwen/qwen3.8-max-0902", "high"), 8000);
});

Deno.test("reasoningAllowance — the live batches_review shape: 2,500 visible + low on Gemini = 5,000 on the wire", () => {
  // Live run b67878e0: ~2,200 of 2,500 tokens went to reasoning and the
  // visible JSON was ~300 chars. With the allowance the visible 2,500 survive.
  assertEquals(2500 + reasoningAllowance("google/gemini-3.1-pro", "low"), 5000);
});

Deno.test("reasoningAllowance — a low-effort review on a non-thinking vendor: 2,500 visible + low = 5,000 on the wire", () => {
  // Live smoke run before dd1e502e: the Inspector's first review spent ~1,500
  // reasoning tokens against a 2,500 + 1,500 cap and the JSON was cut; the
  // allowance now leaves the visible 2,500 intact for that trace.
  assertEquals(2500 + reasoningAllowance("anthropic/some-model", "low"), 5000);
  assertEquals(8000 + reasoningAllowance("openai/some-model", "low"), 10500);
});

// --- budget exhausted: finish_reason OR token count at the wire cap --------

Deno.test("isBudgetExhausted — finish_reason length / max_tokens always exhaust", () => {
  assert(isBudgetExhausted("length", 10, 8000));
  assert(isBudgetExhausted("max_tokens", 10, 0));
  assert(!isBudgetExhausted("stop", 10, 8000));
});

Deno.test("isBudgetExhausted — tokens_out == max_tokens exhausts even when finish_reason says stop", () => {
  // Live batches_chair Jul 24: tokens_out 8000 == max_tokens 8000.
  assert(isBudgetExhausted("stop", 8000, 8000));
  assert(isBudgetExhausted(undefined, 8000, 8000));
  // Within 8 tokens of the cap counts too (providers round).
  assert(isBudgetExhausted("stop", 7992, 8000));
  assert(!isBudgetExhausted("stop", 7991, 8000));
});

Deno.test("isBudgetExhausted — uncapped calls never exhaust by count", () => {
  assert(!isBudgetExhausted("stop", 50_000, 0));
  assert(!isBudgetExhausted(undefined, 0, 0));
});

// --- RC-4: empty output at the cap is a budget loss, not a refusal ---------

Deno.test("isRefusal — empty content with finish_reason length/max_tokens is NOT a refusal", () => {
  for (const fr of ["length", "max_tokens"]) {
    assertEquals(isRefusal("", fr, true), false, `json ${fr}`);
    assertEquals(isRefusal("   \n", fr, false), false, `markdown ${fr}`);
  }
});

Deno.test("isRefusal — empty content with any other finish_reason still counts as a refusal", () => {
  assertEquals(isRefusal("", "stop", true), true);
  assertEquals(isRefusal("", undefined, false), true);
  assertEquals(isRefusal("", "content_filter", true), true);
});

Deno.test("isRefusal — an attempt at the requested format is never a refusal; leading refusal prose is", () => {
  assertEquals(isRefusal("{\"findings\": []}", "stop", true), false);
  assertEquals(isRefusal("```json\n{}\n```", "stop", true), false);
  assertEquals(isRefusal("I can't help with that request.", "stop", true), true);
  assertEquals(isRefusal("I can't help with that request.", "stop", false), true);
  assertEquals(isRefusal("# Plan\n\nI can't help but notice the pricing is odd. " + "x".repeat(400), "stop", false), false);
});

Deno.test("refusal retry window is 15 s — no same-invocation re-buy after a long generation", () => {
  assertEquals(REFUSAL_RETRY_WINDOW_MS, 15_000);
});

// --- RC-4: honest accounting for a call aborted at the proxy timeout -------

Deno.test("timeoutLedgerEstimate — prompt chars / 4 in, wire cap out", () => {
  const body = {
    model: "google/gemini-3.1-pro",
    messages: [
      { role: "system", content: "s".repeat(1000) },
      { role: "user", content: "u".repeat(3000) },
    ],
    max_tokens: 12_500,
  };
  const est = timeoutLedgerEstimate(body);
  assertEquals(est.tokensOut, 12_500);
  assertEquals(est.tokensIn, Math.ceil(JSON.stringify(body.messages).length / 4));
  assert(est.tokensIn > 1000, "prompt chars are counted");
});

Deno.test("timeoutLedgerEstimate — uncapped or malformed body never throws and never goes negative", () => {
  assertEquals(timeoutLedgerEstimate({ messages: [] }), { tokensIn: 1, tokensOut: 0 });
  assertEquals(timeoutLedgerEstimate({ max_tokens: -5 }).tokensOut, 0);
  assertEquals(timeoutLedgerEstimate(null).tokensOut, 0);
  assertEquals(timeoutLedgerEstimate({ max_tokens: "8000" }).tokensOut, 8000);
});

Deno.test("timeoutLedgerSeat — the estimate row is distinguishable from the seat's real completions", () => {
  assertEquals(timeoutLedgerSeat("chair"), "chair:timeout");
  assertEquals(TIMEOUT_LEDGER_SEAT_SUFFIX, ":timeout");
  assert(timeoutLedgerSeat("inspector") !== "inspector");
});

// ============================================================================
// Batch 17 — the executor seam. callSeat's inline path is byte-identical; these
// pin the extracted pieces so the executor settle path (which calls them with
// the raw JSON a Workflow stored) produces exactly what the inline path does.
// ============================================================================

const OK_JSON = EXECUTOR_FIXTURES.okOutput.response;

// A minimal supabase-js stand-in: records every rpc call and answers like the
// idempotent RPC does (the run's new spent_usd).
function fakeAdmin(reply: { data?: unknown; error?: { message: string } | null } = { data: 1.5, error: null }) {
  const calls: Array<{ name: string; args: any }> = [];
  const admin: any = {
    rpc: (name: string, args: any) => {
      calls.push({ name, args });
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    },
  };
  return { admin, calls };
}

Deno.test("parseOpenRouterResponse — golden: exactly what callOpenRouter computed from the same body + json", () => {
  const body = { model: "m", messages: [], max_tokens: 16_000 };
  const out = parseOpenRouterResponse(body, OK_JSON);
  assertEquals(out.content, "{\"plan\":\"ok\"}");
  assertEquals(out.finishReason, "stop");
  assertEquals(out.usage, OK_JSON.usage);
  assert(out.raw === OK_JSON, "raw is the parsed JSON itself");
  assertEquals(out.reasoningTokens, 4_200);
  assertEquals(out.wireMaxTokens, 16_000);
  assertEquals(out.budgetExhausted, isBudgetExhausted("stop", 6_120, 16_000));
  assertEquals(out.budgetExhausted, false);
});

Deno.test("parseOpenRouterResponse — missing pieces degrade exactly as before (empty content, {} usage, 0 tokens, uncapped)", () => {
  const out = parseOpenRouterResponse({}, { choices: [] });
  assertEquals(out, {
    content: "",
    finishReason: undefined,
    usage: {},
    raw: { choices: [] },
    reasoningTokens: 0,
    wireMaxTokens: 0,
    budgetExhausted: false,
  });
  // Length-cut at the cap is exhausted by finish_reason AND by count.
  const cut = parseOpenRouterResponse({ max_tokens: 100 }, { choices: [{ message: { content: "x" }, finish_reason: "length" }], usage: { completion_tokens: 100 } });
  assertEquals(cut.budgetExhausted, true);
  const byCount = parseOpenRouterResponse({ max_tokens: 100 }, { choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { completion_tokens: 95 } });
  assertEquals(byCount.budgetExhausted, true);
});

Deno.test("settleSeatUsage — provider cost when present and > 0, estimateCost otherwise", () => {
  assertEquals(settleSeatUsage("m", { prompt_tokens: 100, completion_tokens: 50, cost: 0.4183 }), { tokensIn: 100, tokensOut: 50, costUsd: 0.4183 });
  const est = estimateCost("m", 100, 50);
  assertEquals(settleSeatUsage("m", { prompt_tokens: 100, completion_tokens: 50 }), { tokensIn: 100, tokensOut: 50, costUsd: est });
  assertEquals(settleSeatUsage("m", { prompt_tokens: 100, completion_tokens: 50, cost: 0 }), { tokensIn: 100, tokensOut: 50, costUsd: est });
  assertEquals(settleSeatUsage("m", { prompt_tokens: 100, completion_tokens: 50, cost: "nope" }), { tokensIn: 100, tokensOut: 50, costUsd: est });
  assertEquals(settleSeatUsage("m", {}), { tokensIn: 0, tokensOut: 0, costUsd: 0 });
  // The fallback table: $3 / $15 per million.
  assertEquals(estimateCost("anything", 1_000_000, 1_000_000), 18);
});

Deno.test("settleSeatCall — records record_model_call_idempotent with p_call_id and returns the inline ProxyResult shape (cost present)", async () => {
  const { admin, calls } = fakeAdmin();
  const p = {
    userId: "u1",
    seat: "chair",
    modelId: "anthropic/claude-fable-5.1",
    primaryModelId: "anthropic/claude-fable-5.1",
    options: { runId: "r1", projectId: "p1", json: true },
    wireMaxTokens: 16_000,
    jsonMode: true,
  };
  const out = await settleSeatCall(admin, p, OK_JSON, { callId: "s1-1" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "record_model_call_idempotent");
  assertEquals(calls[0].args, {
    p_user_id: "u1",
    p_project_id: "p1",
    p_run_id: "r1",
    p_seat: "chair",
    p_model_id: "anthropic/claude-fable-5.1",
    p_tokens_in: 21_740,
    p_tokens_out: 6_120,
    p_cost_usd: 0.4183,
    p_call_id: "s1-1",
  });
  // Same keys, same values as callSeat's return for this attempt.
  assertEquals(out, {
    content: "{\"plan\":\"ok\"}",
    model: "anthropic/claude-fable-5.1",
    tokensIn: 21_740,
    tokensOut: 6_120,
    costUsd: 0.4183,
    raw: OK_JSON,
    finishReason: "stop",
    reasoningTokens: 4_200,
    wireMaxTokens: 16_000,
    budgetExhausted: false,
  });
  assertEquals("fallback" in out, false);
  assertEquals("smokeSource" in out, false);
});

Deno.test("settleSeatCall — cost absent → estimateCost; null project/run → null RPC args (as recordCall does inline)", async () => {
  const { admin, calls } = fakeAdmin();
  const json = { ...OK_JSON, usage: { prompt_tokens: 1_000, completion_tokens: 200 } };
  const out = await settleSeatCall(admin, {
    userId: "u1", seat: "inspector", modelId: "m", primaryModelId: "m", options: {}, wireMaxTokens: 0, jsonMode: false,
  }, json, { callId: "s2-1" });
  assertEquals(out.costUsd, estimateCost("m", 1_000, 200));
  assertEquals(calls[0].args.p_cost_usd, estimateCost("m", 1_000, 200));
  assertEquals(calls[0].args.p_project_id, null);
  assertEquals(calls[0].args.p_run_id, null);
  assertEquals(out.wireMaxTokens, 0);
});

Deno.test("settleSeatCall — fallbackReason stamps the refusal fallback meta; smokeSource passes through", async () => {
  const { admin } = fakeAdmin();
  const out = await settleSeatCall(admin, {
    userId: "u1", seat: "chair", modelId: "openai/gpt-6-astra", primaryModelId: "anthropic/claude-fable-5.1",
    smokeSource: "smoke", options: { smoke: true }, wireMaxTokens: 100, jsonMode: true,
  }, OK_JSON, { callId: "s3-2", fallbackReason: "refusal" });
  assertEquals(out.model, "openai/gpt-6-astra");
  assertEquals(out.fallback, { fallback_model_used: "openai/gpt-6-astra", primary_model: "anthropic/claude-fable-5.1", reason: "refusal" });
  assertEquals(out.smokeSource, "smoke");
});

Deno.test("settleSeatCall — an RPC error throws with the idempotent prefix and nothing else is returned", async () => {
  const { admin } = fakeAdmin({ error: { message: "canceling statement due to statement timeout" } });
  let msg = "";
  try {
    await settleSeatCall(admin, { userId: "u1", seat: "chair", modelId: "m", primaryModelId: "m", options: {}, wireMaxTokens: 0, jsonMode: false }, OK_JSON, { callId: "s4-1" });
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "record_model_call_idempotent failed: canceling statement");
});

Deno.test("recordTimeoutEstimate — equals timeoutLedgerEstimate(body) for the same body, under <seat>:timeout, keyed <call_id>:timeout", async () => {
  const body = {
    model: "anthropic/claude-fable-5.1",
    messages: [
      { role: "system", content: "CONSTITUTION\n" + "x".repeat(4_000) },
      { role: "user", content: "y".repeat(2_345) },
    ],
    max_tokens: 12_500,
  };
  const est = timeoutLedgerEstimate(body);
  const { admin, calls } = fakeAdmin();
  await recordTimeoutEstimate(admin, {
    userId: "u1",
    seat: "chair",
    modelId: body.model,
    options: { runId: "r1", projectId: "p1" },
    promptChars: JSON.stringify(body.messages).length,   // what executor_meta.prompt_chars stores
    wireMaxTokens: body.max_tokens,                       // what executor_meta.wire_max_tokens stores
  }, { callId: "s5-1", suffix: ":timeout" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "record_model_call_idempotent");
  assertEquals(calls[0].args.p_tokens_in, est.tokensIn);
  assertEquals(calls[0].args.p_tokens_out, est.tokensOut);
  assertEquals(calls[0].args.p_cost_usd, estimateCost(body.model, est.tokensIn, est.tokensOut));
  assertEquals(calls[0].args.p_seat, timeoutLedgerSeat("chair"));
  assertEquals(calls[0].args.p_model_id, body.model);
  assertEquals(calls[0].args.p_call_id, "s5-1:timeout");
  assertEquals(calls[0].args.p_run_id, "r1");
  assertEquals(calls[0].args.p_project_id, "p1");
});

Deno.test("recordTimeoutEstimate — uncapped call estimates 0 tokens out (no honest estimate), like the inline path", async () => {
  const { admin, calls } = fakeAdmin();
  await recordTimeoutEstimate(admin, { userId: "u1", seat: "chair", modelId: "m", options: {}, promptChars: 0, wireMaxTokens: 0 }, { callId: "s6-1", suffix: ":timeout" });
  assertEquals(calls[0].args.p_tokens_in, 0);
  assertEquals(calls[0].args.p_tokens_out, 0);
  assertEquals(calls[0].args.p_cost_usd, 0);
  assertEquals(calls[0].args.p_project_id, null);
  assertEquals(calls[0].args.p_run_id, null);
});
