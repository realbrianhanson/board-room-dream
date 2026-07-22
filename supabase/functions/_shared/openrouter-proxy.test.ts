// Deterministic tests for the transport classifier and the requeue/terminal
// decision helper. Run: cd supabase/functions && deno test _shared/openrouter-proxy.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideTransportRequeue,
  isBodyTransportError,
  ProxyTimeoutError,
  shouldQuickRetry,
} from "./openrouter-proxy.ts";

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
