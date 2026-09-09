// Batch 17 — HTTP surface of the executor Worker (spec §6.3 / §6.4 / §10.3).
// Pure routing over injected deps: the Workflow binding, the clock and the
// config arrive as arguments, so vitest drives it with a fake `wf` and no
// cloudflare:* import appears here.
import type {
  CallOutput,
  CancelResponse,
  DispatchRequest,
  DispatchResponse,
  ExecutorCallState,
  ExecutorTransport,
  HealthResponse,
  SealedKey,
  StatusResponse,
} from "./protocol.ts";
import { verifyExecutorRequest } from "./auth.ts";
import { clampTimeout, EXECUTOR_DEFAULT_IDLE_MS, EXECUTOR_MAX_TIMEOUT_MS, EXECUTOR_MIN_TIMEOUT_MS } from "./openrouter.ts";

export type InstanceStatusLike = { status: string; output?: unknown; error?: unknown };

export type WorkflowLike = {
  create(o: { id: string; params: DispatchRequest }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<InstanceStatusLike>; terminate(): Promise<void> }>;
};

export type HandlerDeps = {
  secret: string;
  wf: WorkflowLike;
  now: () => number;
  version: string;
  allowedCallbackHosts: string[];
  maxDispatchBytes: number;
  maxTimeoutMs: number;
};

/** Workflow instance ids: what the orchestrator reserves is `<uuid>-<n>`; anything wilder is refused. */
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CALL_ROUTE_RE = /^\/v1\/calls\/([^/]+)(\/cancel)?$/;
const MIN_IDLE_MS = 10_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function isRecord(x: unknown): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function nonBlank(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function bad(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

/**
 * Field validation + normalisation of a dispatch body. Returns the request
 * as it will be stored in the Workflow params (timeout clamped, defaults
 * filled) or the reason it is refused.
 */
export function validateDispatch(
  x: unknown,
  deps: Pick<HandlerDeps, "allowedCallbackHosts" | "maxTimeoutMs">,
): { ok: true; value: DispatchRequest } | { ok: false; detail: string } {
  if (!isRecord(x)) return bad("body must be a JSON object");
  if (!nonBlank(x.call_id) || !CALL_ID_RE.test(x.call_id)) return bad("call_id missing or malformed");

  const labels = x.labels;
  if (!isRecord(labels)) return bad("labels missing");
  for (const k of ["run_id", "step_id", "step_key", "seat"] as const) {
    if (!nonBlank(labels[k])) return bad(`labels.${k} missing`);
  }
  if (typeof labels.smoke !== "boolean") return bad("labels.smoke must be a boolean");

  if (x.timeout_ms !== undefined && !(typeof x.timeout_ms === "number" && Number.isFinite(x.timeout_ms))) {
    return bad("timeout_ms must be a number");
  }
  const timeoutMs = clampTimeout(x.timeout_ms, deps.maxTimeoutMs);
  if (timeoutMs < EXECUTOR_MIN_TIMEOUT_MS || timeoutMs > EXECUTOR_MAX_TIMEOUT_MS) {
    return bad(`timeout_ms ${timeoutMs} outside ${EXECUTOR_MIN_TIMEOUT_MS}–${EXECUTOR_MAX_TIMEOUT_MS} after clamp`);
  }
  if (x.idle_ms !== undefined && !(typeof x.idle_ms === "number" && Number.isFinite(x.idle_ms))) {
    return bad("idle_ms must be a number");
  }
  const idleMs = Math.min(timeoutMs, Math.max(MIN_IDLE_MS, typeof x.idle_ms === "number" ? x.idle_ms : EXECUTOR_DEFAULT_IDLE_MS));

  const transport: ExecutorTransport = x.transport === undefined ? "sse" : x.transport;
  if (transport !== "sse" && transport !== "json") return bad("transport must be sse or json");

  if (!nonBlank(x.callback_url)) return bad("callback_url missing");
  let cb: URL;
  try {
    cb = new URL(x.callback_url);
  } catch {
    return bad("callback_url is not a URL");
  }
  if (cb.protocol !== "https:") return bad("callback_url must be https");
  const host = cb.hostname.toLowerCase();
  if (!deps.allowedCallbackHosts.some((h) => h.trim().toLowerCase() === host)) {
    return bad(`callback host ${host} not allowed`);
  }

  const or = x.openrouter;
  if (!isRecord(or)) return bad("openrouter missing");
  const sealed = or.key_sealed;
  if (!isRecord(sealed) || sealed.v !== 1 || !nonBlank(sealed.iv) || !nonBlank(sealed.ct)) {
    return bad("openrouter.key_sealed missing or malformed");
  }
  if (typeof or.api_key === "string" || typeof or.key === "string") return bad("plaintext key is not accepted");
  const headers: Record<string, string> = {};
  if (or.headers !== undefined) {
    if (!isRecord(or.headers)) return bad("openrouter.headers must be an object");
    for (const [k, v] of Object.entries(or.headers)) {
      if (typeof v !== "string") return bad(`openrouter.headers.${k} must be a string`);
      headers[k] = v;
    }
  }
  const body = or.body;
  if (!isRecord(body)) return bad("openrouter.body missing");
  if (!nonBlank(body.model)) return bad("openrouter.body.model missing");
  if (!Array.isArray(body.messages)) return bad("openrouter.body.messages missing");
  if ("stream" in body) return bad("openrouter.body.stream is set by the Worker, not the caller");

  const value: DispatchRequest = {
    call_id: x.call_id,
    labels: {
      run_id: labels.run_id,
      step_id: labels.step_id,
      step_key: labels.step_key,
      seat: labels.seat,
      smoke: labels.smoke,
    },
    timeout_ms: timeoutMs,
    idle_ms: idleMs,
    transport,
    callback_url: x.callback_url,
    openrouter: { key_sealed: sealed as SealedKey, headers, body },
    orchestrator_build: typeof x.orchestrator_build === "string" ? x.orchestrator_build : "",
  };
  return { ok: true, value };
}

function engineErrorText(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as any;
    if (typeof e.message === "string") return typeof e.name === "string" && e.name ? `${e.name}: ${e.message}` : e.message;
    try {
      return JSON.stringify(error);
    } catch { /* fall through */ }
  }
  return String(error);
}

/**
 * Total over the platform's InstanceStatus.status values (queued, running,
 * paused, errored, terminated, complete, waiting, waitingForPause, unknown)
 * — nothing falls through: paused|waitingForPause → paused, unknown or any
 * unrecognised string → unknown. Output is attached only for `complete`.
 */
export function mapInstanceStatus(s: InstanceStatusLike, callId: string): StatusResponse {
  let state: ExecutorCallState;
  switch (s.status) {
    case "queued":
      state = "queued";
      break;
    case "running":
      state = "running";
      break;
    case "waiting":
      state = "waiting";
      break;
    case "paused":
    case "waitingForPause":
      state = "paused";
      break;
    case "complete":
      state = "complete";
      break;
    case "errored":
      state = "errored";
      break;
    case "terminated":
      state = "terminated";
      break;
    default:
      state = "unknown";
  }
  return {
    call_id: callId,
    state,
    output: state === "complete" && s.output != null ? (s.output as CallOutput) : null,
    engine_error: state === "errored" ? (engineErrorText(s.error) ?? "errored") : engineErrorText(s.error),
  };
}

async function instanceExists(wf: WorkflowLike, id: string): Promise<boolean> {
  try {
    await wf.get(id);
    return true;
  } catch {
    return false;
  }
}

async function dispatch(raw: string, deps: HandlerDeps): Promise<Response> {
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > deps.maxDispatchBytes) return json(413, { error: "payload_too_large", bytes });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_dispatch", detail: "body is not JSON" });
  }
  const v = validateDispatch(parsed, deps);
  if (!v.ok) return json(400, { error: "bad_dispatch", detail: v.detail });
  const spec = v.value;
  try {
    await deps.wf.create({ id: spec.call_id, params: spec });
  } catch (e) {
    // create() throws when an instance with that id already exists; confirm
    // with get() so an unrelated failure is never reported as "exists". The
    // literal text of Cloudflare's duplicate-id error was not verified (docs
    // unavailable when this was written), which is why the check is
    // get()-based rather than a message match. The reported state is the
    // spec's literal "running" even if the instance is queued or complete;
    // the orchestrator polls GET /v1/calls/:id for the real state.
    if (await instanceExists(deps.wf, spec.call_id)) {
      const body: DispatchResponse = { call_id: spec.call_id, state: "running", created: false };
      return json(200, body);
    }
    return json(503, { error: "workflow_create_failed", detail: String((e as any)?.message ?? e) });
  }
  const body: DispatchResponse = { call_id: spec.call_id, state: "queued", created: true };
  return json(202, body);
}

async function status(callId: string, deps: HandlerDeps): Promise<Response> {
  let inst: Awaited<ReturnType<WorkflowLike["get"]>>;
  try {
    inst = await deps.wf.get(callId);
  } catch {
    return json(404, { error: "not_found" });
  }
  let s: InstanceStatusLike;
  try {
    s = await inst.status();
  } catch (e) {
    return json(503, { error: "status_failed", detail: String((e as any)?.message ?? e) });
  }
  return json(200, mapInstanceStatus(s, callId));
}

async function cancel(callId: string, deps: HandlerDeps): Promise<Response> {
  let inst: Awaited<ReturnType<WorkflowLike["get"]>>;
  try {
    inst = await deps.wf.get(callId);
  } catch {
    const body: CancelResponse = { call_id: callId, state: "not_found", was_running: false };
    return json(200, body);
  }
  let s: InstanceStatusLike;
  try {
    s = await inst.status();
  } catch (e) {
    return json(503, { error: "status_failed", detail: String((e as any)?.message ?? e) });
  }
  const st = mapInstanceStatus(s, callId).state;
  if (st === "complete" || st === "errored" || st === "terminated") {
    const body: CancelResponse = { call_id: callId, state: st, was_running: false };
    return json(200, body);
  }
  try {
    await inst.terminate();
  } catch (e) {
    return json(503, { error: "terminate_failed", detail: String((e as any)?.message ?? e) });
  }
  const body: CancelResponse = { call_id: callId, state: "terminated", was_running: true };
  return json(200, body);
}

export async function handleRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const path = url.pathname;
  if (path === "/v1/health") {
    if (method !== "GET") return json(405, { error: "method_not_allowed" });
    const body: HealthResponse = { ok: true, version: deps.version };
    return json(200, body);
  }
  // Everything else is signed. With no secret configured nothing can verify (§13.1: 401 until the secret exists).
  const raw = await req.text();
  if (!deps.secret) return json(401, { error: "not_configured" });
  const v = await verifyExecutorRequest(deps.secret, method, path + url.search, req.headers, raw, deps.now());
  if (!v.ok) return json(401, { error: v.reason === "mismatch" ? "bad_signature" : v.reason });

  if (path === "/v1/calls") {
    if (method !== "POST") return json(405, { error: "method_not_allowed" });
    return dispatch(raw, deps);
  }
  const m = CALL_ROUTE_RE.exec(path);
  if (m) {
    let callId: string;
    try {
      callId = decodeURIComponent(m[1]);
    } catch {
      return json(404, { error: "not_found" });
    }
    if (!CALL_ID_RE.test(callId)) return json(404, { error: "not_found" });
    if (m[2]) {
      if (method !== "POST") return json(405, { error: "method_not_allowed" });
      return cancel(callId, deps);
    }
    if (method !== "GET") return json(405, { error: "method_not_allowed" });
    return status(callId, deps);
  }
  return json(404, { error: "not_found" });
}
