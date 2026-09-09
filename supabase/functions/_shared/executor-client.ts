// deno-lint-ignore-file no-explicit-any
// Batch 17 — the orchestrator's client for the Cloudflare executor Worker
// (spec §9.4). Deno-side only (executorEnvFromDeno reads Deno.env); the
// network functions take an injectable fetch so they are unit-tested without
// a Worker. Every fetch is bounded by an 8 s AbortController.
import type { PreparedSeatCall } from "./openrouter-proxy.ts";
import type {
  CallOutput,
  CancelResponse,
  DispatchLabels,
  DispatchRequest,
  ExecutorTransport,
  SealedKey,
} from "./executor-protocol.ts";
import { signExecutorRequest } from "./executor-auth.ts";

export type ExecutorEnv = { url: string; secret: string };

export const EXECUTOR_FETCH_TIMEOUT_MS = 8_000;

/** The two app headers the inline proxy sends to OpenRouter; the Worker forwards them verbatim. */
export const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://boardroom.lovable.app",
  "X-Title": "BOARDROOM",
};

// Pure: both values non-blank → env (trailing slashes stripped), else null.
// EXECUTOR_URL must be an ORIGIN (workers.dev or a bare custom domain, no
// path prefix): the orchestrator signs `/v1/calls…` and the Worker verifies
// `new URL(req.url).pathname + search`, so a prefixed URL would fail both
// routing and the signature and surface only as rejected 401/404 → inline.
export function executorEnvFromValues(
  url: string | null | undefined,
  secret: string | null | undefined,
): ExecutorEnv | null {
  const u = String(url ?? "").trim().replace(/\/+$/, "");
  const s = String(secret ?? "").trim();
  if (!u || !s) return null;
  return { url: u, secret: s };
}

/** Both EXECUTOR_URL and EXECUTOR_SECRET set → env, else null (inline path). */
export function executorEnvFromDeno(): ExecutorEnv | null {
  return executorEnvFromValues(Deno.env.get("EXECUTOR_URL"), Deno.env.get("EXECUTOR_SECRET"));
}

// Pure. The body is the proxy's prepared body, untouched (no `stream`; the
// Worker adds it for sse). The plaintext key is NOT part of the spec — only
// the sealed envelope travels.
export function buildDispatchSpec(
  p: Pick<PreparedSeatCall, "body">,
  callId: string,
  labels: DispatchLabels,
  timeoutMs: number,
  idleMs: number,
  transport: ExecutorTransport,
  sealed: SealedKey,
  callbackUrl: string,
  build: string,
): DispatchRequest {
  return {
    call_id: callId,
    labels,
    timeout_ms: timeoutMs,
    idle_ms: idleMs,
    transport,
    callback_url: callbackUrl,
    openrouter: {
      key_sealed: sealed,
      headers: { ...OPENROUTER_APP_HEADERS },
      body: p.body,
    },
    orchestrator_build: build,
  };
}

export type DispatchOutcome =
  | { kind: "accepted"; created: boolean }
  | { kind: "rejected"; status: number; detail?: string }
  | { kind: "ambiguous"; message: string };

export type PollResult =
  | { kind: "state"; state: string; output: CallOutput | null; engine_error: string | null }
  | { kind: "not_found" }
  | { kind: "unreachable"; message: string };

// A failure that happened BEFORE any bytes reached the Worker and that a
// retry a second later would repeat: nothing can have been created.
function isDefinitiveNetworkFailure(e: Error): boolean {
  const hay = `${String(e?.message ?? "")} ${String((e as any)?.cause?.message ?? "")}`.toLowerCase();
  return /econnrefused|connection refused|enotfound|eai_again|getaddrinfo|dns error|failed to lookup address|name or service not known|name resolution/.test(hay);
}

// Pure. 2xx accepted (202 = created, 200 = instance already existed);
// 400/401/413 definitively rejected; DNS / connection-refused rejected
// (nothing reached the Worker); 5xx, fetch timeout and anything else
// ambiguous — the reservation stays and the collector decides next tick.
export function decideDispatchResponse(
  res: { status: number; detail?: string } | { networkError: Error },
): DispatchOutcome {
  if ("networkError" in res) {
    const e = res.networkError;
    const msg = String(e?.message ?? e);
    const name = String(e?.name ?? "");
    if (name === "AbortError" || name === "TimeoutError") return { kind: "ambiguous", message: `fetch timeout: ${msg}` };
    if (isDefinitiveNetworkFailure(e)) return { kind: "rejected", status: 0, detail: msg };
    return { kind: "ambiguous", message: msg };
  }
  const s = Number(res.status);
  if (s >= 200 && s < 300) return { kind: "accepted", created: s === 202 };
  if (s === 400 || s === 401 || s === 413) return { kind: "rejected", status: s, detail: res.detail };
  return { kind: "ambiguous", message: `executor responded ${s}${res.detail ? `: ${res.detail}` : ""}` };
}

async function signedFetch(
  env: ExecutorEnv,
  method: "GET" | "POST",
  path: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const headers = await signExecutorRequest(env.secret, method, path, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTOR_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(`${env.url}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(r: Response): Promise<any> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

function callPath(callId: string, suffix = ""): string {
  return `/v1/calls/${encodeURIComponent(callId)}${suffix}`;
}

/** POST /v1/calls (§6.3). Idempotent on call_id: an existing instance answers 200 created:false. */
export async function executorDispatch(
  env: ExecutorEnv,
  spec: DispatchRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  let r: Response;
  try {
    r = await signedFetch(env, "POST", "/v1/calls", JSON.stringify(spec), fetchImpl);
  } catch (e) {
    return decideDispatchResponse({ networkError: e as Error });
  }
  const json = await readJson(r);
  const detail = json && typeof json === "object"
    ? String(json.detail ?? json.error ?? "")
    : "";
  const outcome = decideDispatchResponse({ status: r.status, detail: detail || undefined });
  if (outcome.kind !== "accepted") return outcome;
  // The Worker echoes the call id; a different one means we are not talking
  // to the instance we reserved — treat as ambiguous, never as accepted.
  if (json && typeof json === "object" && json.call_id != null && String(json.call_id) !== spec.call_id) {
    return { kind: "ambiguous", message: `call_id mismatch: sent ${spec.call_id}, got ${json.call_id}` };
  }
  const created = json && typeof json === "object" && typeof json.created === "boolean" ? json.created : outcome.created;
  return { kind: "accepted", created };
}

/** GET /v1/calls/:id (§6.4). */
export async function executorPoll(
  env: ExecutorEnv,
  callId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> {
  let r: Response;
  try {
    r = await signedFetch(env, "GET", callPath(callId), "", fetchImpl);
  } catch (e) {
    return { kind: "unreachable", message: String((e as Error)?.message ?? e) };
  }
  if (r.status === 404) return { kind: "not_found" };
  if (r.status < 200 || r.status >= 300) return { kind: "unreachable", message: `executor responded ${r.status}` };
  const json = await readJson(r);
  if (!json || typeof json !== "object" || typeof json.state !== "string") {
    return { kind: "unreachable", message: "malformed status body" };
  }
  if (json.call_id != null && String(json.call_id) !== callId) {
    return { kind: "unreachable", message: `call_id mismatch: asked ${callId}, got ${json.call_id}` };
  }
  return {
    kind: "state",
    state: json.state,
    output: (json.output ?? null) as CallOutput | null,
    engine_error: json.engine_error == null ? null : String(json.engine_error),
  };
}

/** POST /v1/calls/:id/cancel (§6.4). Best effort: null when the Worker cannot be reached. */
export async function executorCancel(
  env: ExecutorEnv,
  callId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelResponse | null> {
  let r: Response;
  try {
    r = await signedFetch(env, "POST", callPath(callId, "/cancel"), "{}", fetchImpl);
  } catch {
    return null;
  }
  if (r.status === 404) return { call_id: callId, state: "not_found", was_running: false };
  if (r.status < 200 || r.status >= 300) return null;
  const json = await readJson(r);
  if (!json || typeof json !== "object" || typeof json.state !== "string") return null;
  return {
    call_id: String(json.call_id ?? callId),
    state: json.state,
    was_running: json.was_running === true,
  };
}
