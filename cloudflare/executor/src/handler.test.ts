// Batch 17 — the signed HTTP surface over a fake Workflow binding.
import { describe, expect, it } from "vitest";
import { handleRequest, mapInstanceStatus, validateDispatch, type HandlerDeps, type WorkflowLike } from "./handler.ts";
import { signExecutorRequest } from "./auth.ts";
import { EXECUTOR_FIXTURES, type DispatchRequest } from "./protocol.ts";

const SECRET = "s3cret";
const ORIGIN = "https://boardroom-executor.example.workers.dev";
const NOW = 1_757_437_331_412;
const D = EXECUTOR_FIXTURES.dispatch;

type Inst = { status: { status: string; output?: unknown; error?: unknown }; terminated: number; params?: DispatchRequest };

function fakeWf(seed: Record<string, Inst> = {}) {
  const store = new Map<string, Inst>(Object.entries(seed));
  const log: string[] = [];
  const wf: WorkflowLike = {
    async create(o) {
      log.push(`create ${o.id}`);
      if (store.has(o.id)) throw new Error(`instance.already_exists: ${o.id}`);
      store.set(o.id, { status: { status: "queued" }, terminated: 0, params: o.params });
    },
    async get(id) {
      log.push(`get ${id}`);
      const inst = store.get(id);
      if (!inst) throw new Error(`instance.not_found: ${id}`);
      return {
        async status() {
          return inst.status;
        },
        async terminate() {
          inst.terminated++;
          inst.status = { status: "terminated" };
        },
      };
    },
  };
  return { wf, store, log };
}

function deps(wf: WorkflowLike, over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    secret: SECRET,
    wf,
    now: () => NOW,
    version: "batch17",
    allowedCallbackHosts: ["raiyybdrizlmtbvehzaj.supabase.co"],
    maxDispatchBytes: 900_000,
    maxTimeoutMs: 900_000,
    ...over,
  };
}

async function signed(method: string, path: string, body = "", o: { secret?: string; now?: number } = {}) {
  const headers = await signExecutorRequest(o.secret ?? SECRET, method, path, body, o.now ?? NOW);
  return new Request(ORIGIN + path, { method, headers, body: method === "GET" ? undefined : body });
}

const asJson = async (r: Response) => ({ status: r.status, body: await r.json() });

describe("GET /v1/health", () => {
  it("is unsigned and carries no secret material", async () => {
    const { wf } = fakeWf();
    const r = await asJson(await handleRequest(new Request(ORIGIN + "/v1/health"), deps(wf)));
    expect(r).toEqual({ status: 200, body: { ok: true, version: "batch17" } });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
  });
});

describe("authentication", () => {
  it("absent, skewed, tampered signatures and a wrong secret → 401; no configured secret → 401", async () => {
    const { wf } = fakeWf();
    const d = deps(wf);
    const bare = new Request(ORIGIN + "/v1/calls", { method: "POST", body: "{}" });
    expect(await asJson(await handleRequest(bare, d))).toEqual({ status: 401, body: { error: "missing" } });
    const skewed = await signed("POST", "/v1/calls", "{}", { now: NOW - 301_000 });
    expect(await asJson(await handleRequest(skewed, d))).toEqual({ status: 401, body: { error: "skew" } });
    const tampered = await signed("POST", "/v1/calls", "{}");
    const t2 = new Request(tampered, { body: '{"x":1}' });
    expect(await asJson(await handleRequest(t2, d))).toEqual({ status: 401, body: { error: "bad_signature" } });
    const wrong = await signed("POST", "/v1/calls", "{}", { secret: "other" });
    expect(await asJson(await handleRequest(wrong, d))).toEqual({ status: 401, body: { error: "bad_signature" } });
    const ok = await signed("POST", "/v1/calls", "{}");
    expect((await handleRequest(ok, deps(wf, { secret: "" }))).status).toBe(401);
  });

  it("the signed path includes the call id segment (encoded) and the query", async () => {
    const { wf } = fakeWf({ [D.call_id]: { status: { status: "running" }, terminated: 0 } });
    const path = `/v1/calls/${encodeURIComponent(D.call_id)}`;
    expect(await asJson(await handleRequest(await signed("GET", path), deps(wf)))).toEqual({
      status: 200,
      body: { call_id: D.call_id, state: "running", output: null, engine_error: null },
    });
    // The same headers over a different path do not verify.
    const h = await signExecutorRequest(SECRET, "GET", path, "", NOW);
    const other = new Request(`${ORIGIN}${path}?x=1`, { method: "GET", headers: h });
    expect((await handleRequest(other, deps(wf))).status).toBe(401);
    // An id containing ':' (admitted by CALL_ID_RE) is percent-encoded by the orchestrator's callPath
    // and must round-trip through decodeURIComponent to the stored instance id.
    const colon = `${D.call_id}:r2`;
    const { wf: wf2 } = fakeWf({ [colon]: { status: { status: "queued" }, terminated: 0 } });
    const encoded = `/v1/calls/${encodeURIComponent(colon)}`;
    expect(encoded).toContain("%3A");
    expect(await asJson(await handleRequest(await signed("GET", encoded), deps(wf2)))).toEqual({
      status: 200,
      body: { call_id: colon, state: "queued", output: null, engine_error: null },
    });
  });
});

describe("POST /v1/calls", () => {
  it("creates the instance with id = call_id and the normalised params → 202 created:true", async () => {
    const { wf, store } = fakeWf();
    const r = await asJson(await handleRequest(await signed("POST", "/v1/calls", JSON.stringify(D)), deps(wf)));
    expect(r).toEqual({ status: 202, body: { call_id: D.call_id, state: "queued", created: true } });
    const inst = store.get(D.call_id)!;
    expect(inst.params).toEqual(D);
    expect(JSON.stringify(inst.params)).not.toContain("stream");
  });

  it("duplicate create → 200 created:false (confirmed via get)", async () => {
    const { wf, log } = fakeWf({ [D.call_id]: { status: { status: "running" }, terminated: 0 } });
    const r = await asJson(await handleRequest(await signed("POST", "/v1/calls", JSON.stringify(D)), deps(wf)));
    expect(r).toEqual({ status: 200, body: { call_id: D.call_id, state: "running", created: false } });
    expect(log).toEqual([`create ${D.call_id}`, `get ${D.call_id}`]);
  });

  it("create failure with no such instance → 503 workflow_create_failed", async () => {
    const { wf } = fakeWf();
    wf.create = async () => {
      throw new Error("engine unavailable");
    };
    const r = await asJson(await handleRequest(await signed("POST", "/v1/calls", JSON.stringify(D)), deps(wf)));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "workflow_create_failed", detail: "engine unavailable" });
  });

  it("oversize → 413 with the byte count, before any create", async () => {
    const { wf, log } = fakeWf();
    const big = JSON.stringify({ ...D, openrouter: { ...D.openrouter, body: { ...D.openrouter.body, messages: [{ role: "user", content: "x".repeat(2_000) }] } } });
    const r = await asJson(await handleRequest(await signed("POST", "/v1/calls", big), deps(wf, { maxDispatchBytes: 1_000 })));
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("payload_too_large");
    expect(r.body.bytes).toBe(new TextEncoder().encode(big).byteLength);
    expect(log).toEqual([]);
  });

  it("bad callback host, caller-set stream, plaintext key, non-JSON → 400 bad_dispatch", async () => {
    const { wf, log } = fakeWf();
    const d = deps(wf);
    const post = async (body: unknown) =>
      asJson(await handleRequest(await signed("POST", "/v1/calls", typeof body === "string" ? body : JSON.stringify(body)), d));
    const host = await post({ ...D, callback_url: "https://evil.example.com/functions/v1/boardroom-orchestrator" });
    expect(host.status).toBe(400);
    expect(host.body).toMatchObject({ error: "bad_dispatch" });
    expect(host.body.detail).toMatch(/callback host/);
    const stream = await post({ ...D, openrouter: { ...D.openrouter, body: { ...D.openrouter.body, stream: true } } });
    expect(stream.status).toBe(400);
    expect(stream.body.detail).toMatch(/stream/);
    const plain = await post({ ...D, openrouter: { ...D.openrouter, api_key: "sk-or-v1-leak" } });
    expect(plain.status).toBe(400);
    const notJson = await post("{nope");
    expect(notJson).toEqual({ status: 400, body: { error: "bad_dispatch", detail: "body is not JSON" } });
    expect(log).toEqual([]);
  });
});

describe("validateDispatch", () => {
  it("clamps timeout_ms, defaults idle/transport, refuses a malformed sealed key or missing labels", () => {
    const ok = validateDispatch({ ...D, timeout_ms: 5_000_000, idle_ms: undefined, transport: undefined }, deps(fakeWf().wf));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.timeout_ms).toBe(900_000);
      expect(ok.value.idle_ms).toBe(90_000);
      expect(ok.value.transport).toBe("sse");
    }
    const low = validateDispatch({ ...D, timeout_ms: 1 }, deps(fakeWf().wf));
    expect(low.ok && low.value.timeout_ms).toBe(30_000);
    expect(validateDispatch({ ...D, openrouter: { ...D.openrouter, key_sealed: { v: 2, iv: "a", ct: "b" } } }, deps(fakeWf().wf)).ok).toBe(false);
    expect(validateDispatch({ ...D, labels: { ...D.labels, step_id: "" } }, deps(fakeWf().wf)).ok).toBe(false);
    expect(validateDispatch({ ...D, call_id: "../x" }, deps(fakeWf().wf)).ok).toBe(false);
    expect(validateDispatch({ ...D, transport: "grpc" }, deps(fakeWf().wf)).ok).toBe(false);
    expect(validateDispatch({ ...D, callback_url: "http://raiyybdrizlmtbvehzaj.supabase.co/functions/v1/boardroom-orchestrator" }, deps(fakeWf().wf)).ok).toBe(false);
  });
});

describe("mapInstanceStatus", () => {
  it("is total over the nine platform statuses plus an unrecognised string", () => {
    const id = D.call_id;
    const st = (status: string, extra: Record<string, unknown> = {}) => mapInstanceStatus({ status, ...extra }, id);
    expect(st("queued")).toEqual({ call_id: id, state: "queued", output: null, engine_error: null });
    expect(st("running").state).toBe("running");
    expect(st("waiting").state).toBe("waiting");
    expect(st("paused").state).toBe("paused");
    expect(st("waitingForPause").state).toBe("paused");
    expect(st("complete", { output: EXECUTOR_FIXTURES.okOutput })).toEqual({
      call_id: id,
      state: "complete",
      output: EXECUTOR_FIXTURES.okOutput,
      engine_error: null,
    });
    expect(st("errored", { error: { name: "Error", message: "boom" } })).toEqual({
      call_id: id,
      state: "errored",
      output: null,
      engine_error: "Error: boom",
    });
    expect(st("errored").engine_error).toBe("errored");
    expect(st("terminated").state).toBe("terminated");
    expect(st("unknown").state).toBe("unknown");
    expect(st("something-new").state).toBe("unknown");
    // Output is only exposed for a complete instance.
    expect(st("running", { output: EXECUTOR_FIXTURES.okOutput }).output).toBeNull();
  });
});

describe("GET /v1/calls/:id and POST /v1/calls/:id/cancel", () => {
  it("unknown id → 404 not_found on status; complete → output attached", async () => {
    const { wf } = fakeWf({ [D.call_id]: { status: { status: "complete", output: EXECUTOR_FIXTURES.okOutput }, terminated: 0 } });
    expect(await asJson(await handleRequest(await signed("GET", "/v1/calls/nope-1"), deps(wf)))).toEqual({ status: 404, body: { error: "not_found" } });
    const r = await asJson(await handleRequest(await signed("GET", `/v1/calls/${D.call_id}`), deps(wf)));
    expect(r).toEqual({ status: 200, body: { call_id: D.call_id, state: "complete", output: EXECUTOR_FIXTURES.okOutput, engine_error: null } });
  });

  it("cancel of a complete instance reports it (was_running:false); cancel of a running one terminates (was_running:true); unknown → not_found", async () => {
    const running = "6c0f2b1e-1d3a-4c0e-9f3b-2f4a1b9c7d10-2";
    const { wf, store } = fakeWf({
      [D.call_id]: { status: { status: "complete", output: EXECUTOR_FIXTURES.okOutput }, terminated: 0 },
      [running]: { status: { status: "running" }, terminated: 0 },
    });
    const d = deps(wf);
    expect(await asJson(await handleRequest(await signed("POST", `/v1/calls/${D.call_id}/cancel`, "{}"), d))).toEqual({
      status: 200,
      body: { call_id: D.call_id, state: "complete", was_running: false },
    });
    expect(store.get(D.call_id)!.terminated).toBe(0);
    expect(await asJson(await handleRequest(await signed("POST", `/v1/calls/${running}/cancel`, "{}"), d))).toEqual({
      status: 200,
      body: { call_id: running, state: "terminated", was_running: true },
    });
    expect(store.get(running)!.terminated).toBe(1);
    expect(await asJson(await handleRequest(await signed("POST", "/v1/calls/ghost-1/cancel", "{}"), d))).toEqual({
      status: 200,
      body: { call_id: "ghost-1", state: "not_found", was_running: false },
    });
  });

  it("wrong method on a known route → 405; unknown route → 404 (both after the signature check)", async () => {
    const { wf } = fakeWf();
    expect((await handleRequest(await signed("GET", "/v1/calls"), deps(wf))).status).toBe(405);
    expect((await handleRequest(await signed("POST", "/v1/nothing", "{}"), deps(wf))).status).toBe(404);
    expect((await handleRequest(new Request(ORIGIN + "/v1/nothing"), deps(wf))).status).toBe(401);
  });
});
