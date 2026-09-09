// deno-lint-ignore-file no-explicit-any
// Batch 17 — orchestrator → Worker client, with an injected fetch.
// Run: cd supabase/functions && deno test _shared/executor-client.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDispatchSpec,
  decideDispatchResponse,
  EXECUTOR_FETCH_TIMEOUT_MS,
  executorCancel,
  executorDispatch,
  executorEnvFromValues,
  executorPoll,
  OPENROUTER_APP_HEADERS,
} from "./executor-client.ts";
import { verifyExecutorRequest } from "./executor-auth.ts";
import { EXECUTOR_FIXTURES } from "./executor-protocol.ts";

const ENV = { url: "https://boardroom-executor.example.workers.dev", secret: "shared-secret" };
const CALL_ID = EXECUTOR_FIXTURES.dispatch.call_id;

type Captured = { url: string; init: RequestInit };

// A fetch that records the request and answers with a fixed status/body, or throws.
function fakeFetch(
  answer: { status: number; body?: unknown } | { throws: Error },
  captured: Captured[] = [],
): { fetch: typeof fetch; captured: Captured[] } {
  const f = ((url: string, init: RequestInit) => {
    captured.push({ url, init });
    if ("throws" in answer) return Promise.reject(answer.throws);
    const body = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return Promise.resolve(new Response(body, { status: answer.status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return { fetch: f, captured };
}

const netErr = (message: string, name = "TypeError") => {
  const e = new Error(message);
  e.name = name;
  return e;
};

// --- env ----------------------------------------------------------------------

Deno.test("executorEnvFromValues — both set → env with trailing slash stripped; either missing → null", () => {
  assertEquals(executorEnvFromValues("https://x.workers.dev/", "s"), { url: "https://x.workers.dev", secret: "s" });
  assertEquals(executorEnvFromValues("https://x.workers.dev///", " s "), { url: "https://x.workers.dev", secret: "s" });
  assertEquals(executorEnvFromValues("https://x.workers.dev", ""), null);
  assertEquals(executorEnvFromValues("", "s"), null);
  assertEquals(executorEnvFromValues(undefined, undefined), null);
  assertEquals(executorEnvFromValues("   ", "s"), null);
});

// --- buildDispatchSpec ------------------------------------------------------

Deno.test("buildDispatchSpec — the prepared body travels untouched (same reference), the key only as the sealed envelope", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.4, usage: { include: true }, max_tokens: 1200 };
  const p: any = { body, apiKey: "sk-or-v1-PLAINTEXT-NEVER" };
  const sealed = { v: 1 as const, iv: "aXY=", ct: "Y3Q=" };
  const labels = { run_id: "r", step_id: "s", step_key: "r1_draft_chair", seat: "chair", smoke: false };
  const spec = buildDispatchSpec(p, "s-1", labels, 720_000, 90_000, "sse", sealed, "https://p.supabase.co/functions/v1/boardroom-orchestrator", "build-x");
  assert(spec.openrouter.body === body, "body is the prepared body, not a copy or a rewrite");
  assertEquals("stream" in spec.openrouter.body, false, "no caller-set stream; the Worker adds it for sse");
  assertEquals(spec.openrouter.key_sealed, sealed);
  assertEquals(spec.openrouter.headers, { "HTTP-Referer": "https://boardroom.lovable.app", "X-Title": "BOARDROOM" });
  assertEquals(spec.openrouter.headers, OPENROUTER_APP_HEADERS);
  assertEquals(spec.call_id, "s-1");
  assertEquals(spec.labels, labels);
  assertEquals(spec.timeout_ms, 720_000);
  assertEquals(spec.idle_ms, 90_000);
  assertEquals(spec.transport, "sse");
  assertEquals(spec.callback_url, "https://p.supabase.co/functions/v1/boardroom-orchestrator");
  assertEquals(spec.orchestrator_build, "build-x");
  assert(!JSON.stringify(spec).includes("PLAINTEXT"), "the plaintext key is never in the wire body");
});

// --- decideDispatchResponse -------------------------------------------------

Deno.test("decideDispatchResponse — 202 created, 200 existing, 400/401/413 rejected, 5xx/other ambiguous", () => {
  assertEquals(decideDispatchResponse({ status: 202 }), { kind: "accepted", created: true });
  assertEquals(decideDispatchResponse({ status: 200 }), { kind: "accepted", created: false });
  assertEquals(decideDispatchResponse({ status: 400, detail: "bad_dispatch" }), { kind: "rejected", status: 400, detail: "bad_dispatch" });
  assertEquals(decideDispatchResponse({ status: 401 }), { kind: "rejected", status: 401, detail: undefined });
  assertEquals(decideDispatchResponse({ status: 413 }), { kind: "rejected", status: 413, detail: undefined });
  assertEquals(decideDispatchResponse({ status: 500 }).kind, "ambiguous");
  assertEquals(decideDispatchResponse({ status: 503, detail: "workflow_create_failed" }).kind, "ambiguous");
  assertEquals(decideDispatchResponse({ status: 404 }).kind, "ambiguous");
  assertEquals(decideDispatchResponse({ status: 429 }).kind, "ambiguous");
});

Deno.test("decideDispatchResponse — DNS / connection refused are definitive rejections; abort / socket cut are ambiguous", () => {
  const dns = decideDispatchResponse({ networkError: netErr("error sending request for url (https://x/): client error (Connect): dns error: failed to lookup address information: Name or service not known") });
  assertEquals(dns.kind, "rejected");
  assertEquals((dns as any).status, 0);
  const refused = decideDispatchResponse({ networkError: netErr("client error (Connect): tcp connect error: Connection refused (os error 111)") });
  assertEquals(refused.kind, "rejected");
  const nodeStyle = decideDispatchResponse({ networkError: netErr("connect ECONNREFUSED 127.0.0.1:8787") });
  assertEquals(nodeStyle.kind, "rejected");
  const abort = decideDispatchResponse({ networkError: netErr("The signal has been aborted", "AbortError") });
  assertEquals(abort.kind, "ambiguous");
  assertStringIncludes((abort as any).message, "timeout");
  const cut = decideDispatchResponse({ networkError: netErr("connection reset by peer") });
  assertEquals(cut.kind, "ambiguous");
});

// --- executorDispatch -------------------------------------------------------

Deno.test("executorDispatch — signs POST /v1/calls with the JSON body, bounded by an AbortSignal; 202 → accepted created:true", async () => {
  const { fetch, captured } = fakeFetch({ status: 202, body: { call_id: CALL_ID, state: "queued", created: true } });
  const out = await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fetch);
  assertEquals(out, { kind: "accepted", created: true });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].url, `${ENV.url}/v1/calls`);
  assertEquals(captured[0].init.method, "POST");
  assert(captured[0].init.signal instanceof AbortSignal, "8 s AbortController on every fetch");
  assertEquals(EXECUTOR_FETCH_TIMEOUT_MS, 8_000);
  const body = String(captured[0].init.body);
  assertEquals(JSON.parse(body), EXECUTOR_FIXTURES.dispatch);
  const headers = new Headers(captured[0].init.headers as Record<string, string>);
  assertEquals(headers.get("content-type"), "application/json");
  assertEquals(await verifyExecutorRequest(ENV.secret, "POST", "/v1/calls", headers, body, Date.now()), { ok: true });
});

Deno.test("executorDispatch — 200 created:false (instance already exists) → accepted created:false", async () => {
  const { fetch } = fakeFetch({ status: 200, body: { call_id: CALL_ID, state: "running", created: false } });
  assertEquals(await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fetch), { kind: "accepted", created: false });
});

Deno.test("executorDispatch — 400 / 401 / 413 → rejected with the Worker's detail", async () => {
  const bad = await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ status: 400, body: { error: "bad_dispatch", detail: "callback host not allowed" } }).fetch);
  assertEquals(bad, { kind: "rejected", status: 400, detail: "callback host not allowed" });
  const unauth = await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ status: 401, body: { error: "bad_signature" } }).fetch);
  assertEquals(unauth, { kind: "rejected", status: 401, detail: "bad_signature" });
  const big = await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ status: 413, body: { error: "payload_too_large", bytes: 1_000_000 } }).fetch);
  assertEquals(big, { kind: "rejected", status: 413, detail: "payload_too_large" });
});

Deno.test("executorDispatch — 503 / non-JSON 500 / socket cut / abort → ambiguous (reservation kept for the collector)", async () => {
  assertEquals((await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ status: 503, body: { error: "workflow_create_failed" } }).fetch)).kind, "ambiguous");
  assertEquals((await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ status: 500 }).fetch)).kind, "ambiguous");
  assertEquals((await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ throws: netErr("connection reset by peer") }).fetch)).kind, "ambiguous");
  assertEquals((await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ throws: netErr("aborted", "AbortError") }).fetch)).kind, "ambiguous");
});

Deno.test("executorDispatch — DNS failure before any byte is sent → rejected (fall through inline)", async () => {
  const out = await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ throws: netErr("dns error: failed to lookup address information") }).fetch);
  assertEquals(out.kind, "rejected");
});

Deno.test("executorDispatch — a 2xx that echoes a different call_id is ambiguous, never accepted", async () => {
  const out = await executorDispatch(ENV, EXECUTOR_FIXTURES.dispatch, fakeFetch({ status: 202, body: { call_id: "someone-else-1", created: true } }).fetch);
  assertEquals(out.kind, "ambiguous");
});

// --- executorPoll -----------------------------------------------------------

Deno.test("executorPoll — signs GET /v1/calls/:id with an empty body; 200 → state with output and engine_error", async () => {
  const status = { ...EXECUTOR_FIXTURES.statusComplete, output: EXECUTOR_FIXTURES.okOutput };
  const { fetch, captured } = fakeFetch({ status: 200, body: status });
  const out = await executorPoll(ENV, CALL_ID, fetch);
  assertEquals(out, { kind: "state", state: "complete", output: EXECUTOR_FIXTURES.okOutput, engine_error: null });
  assertEquals(captured[0].url, `${ENV.url}/v1/calls/${CALL_ID}`);
  assertEquals(captured[0].init.method, "GET");
  assertEquals(captured[0].init.body, undefined);
  const headers = new Headers(captured[0].init.headers as Record<string, string>);
  assertEquals(await verifyExecutorRequest(ENV.secret, "GET", `/v1/calls/${CALL_ID}`, headers, "", Date.now()), { ok: true });
});

Deno.test("executorPoll — running / errored states pass through; 404 → not_found; 5xx, malformed body, network error → unreachable", async () => {
  assertEquals(await executorPoll(ENV, CALL_ID, fakeFetch({ status: 200, body: EXECUTOR_FIXTURES.statusRunning }).fetch), { kind: "state", state: "running", output: null, engine_error: null });
  assertEquals(
    await executorPoll(ENV, CALL_ID, fakeFetch({ status: 200, body: { call_id: CALL_ID, state: "errored", output: null, engine_error: "unseal failed" } }).fetch),
    { kind: "state", state: "errored", output: null, engine_error: "unseal failed" },
  );
  assertEquals(await executorPoll(ENV, CALL_ID, fakeFetch({ status: 404, body: { error: "not_found" } }).fetch), { kind: "not_found" });
  assertEquals((await executorPoll(ENV, CALL_ID, fakeFetch({ status: 502 }).fetch)).kind, "unreachable");
  assertEquals((await executorPoll(ENV, CALL_ID, fakeFetch({ status: 200, body: { nope: true } }).fetch)).kind, "unreachable");
  assertEquals((await executorPoll(ENV, CALL_ID, fakeFetch({ throws: netErr("connection refused") }).fetch)).kind, "unreachable");
  assertEquals((await executorPoll(ENV, CALL_ID, fakeFetch({ status: 200, body: { call_id: "other-1", state: "running" } }).fetch)).kind, "unreachable");
});

Deno.test("executorPoll — the call id is URL-encoded on the path", async () => {
  const { fetch, captured } = fakeFetch({ status: 404 });
  await executorPoll(ENV, "a b/c", fetch);
  assertEquals(captured[0].url, `${ENV.url}/v1/calls/a%20b%2Fc`);
});

// --- executorCancel ---------------------------------------------------------

Deno.test("executorCancel — POST /v1/calls/:id/cancel; 200 body returned; 404 → not_found; 5xx / network → null", async () => {
  const { fetch, captured } = fakeFetch({ status: 200, body: { call_id: CALL_ID, state: "terminated", was_running: true } });
  assertEquals(await executorCancel(ENV, CALL_ID, fetch), { call_id: CALL_ID, state: "terminated", was_running: true });
  assertEquals(captured[0].url, `${ENV.url}/v1/calls/${CALL_ID}/cancel`);
  assertEquals(captured[0].init.method, "POST");
  assertEquals(await executorCancel(ENV, CALL_ID, fakeFetch({ status: 200, body: EXECUTOR_FIXTURES.cancelComplete }).fetch), EXECUTOR_FIXTURES.cancelComplete);
  assertEquals(await executorCancel(ENV, CALL_ID, fakeFetch({ status: 404, body: { error: "not_found" } }).fetch), { call_id: CALL_ID, state: "not_found", was_running: false });
  assertEquals(await executorCancel(ENV, CALL_ID, fakeFetch({ status: 500 }).fetch), null);
  assertEquals(await executorCancel(ENV, CALL_ID, fakeFetch({ throws: netErr("boom") }).fetch), null);
});
