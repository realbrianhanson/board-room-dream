// Batch 17 — one OpenRouter call from inside a Workflow step (spec §10.5).
// Pure: fetch, clock and timers are injected, nothing here imports a
// cloudflare:* module, so vitest runs it under Node.
//
// Never retries and never throws for an upstream condition: every failure
// comes back as { ok:false, error } with a classified kind that the
// orchestrator's errorFromExecutor maps onto the proxy's own error shapes.
import type { CallOutput, ExecutorError, ExecutorTransport } from "./protocol.ts";
import { SSE_KEEPALIVE_PREFIX } from "./protocol.ts";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const EXECUTOR_DEFAULT_TIMEOUT_MS = 360_000;
export const EXECUTOR_MIN_TIMEOUT_MS = 30_000;
export const EXECUTOR_MAX_TIMEOUT_MS = 900_000;
export const EXECUTOR_DEFAULT_IDLE_MS = 90_000;
/** Non-2xx body text kept in the error message (the proxy keeps the whole text; 2 000 chars is plenty for a step row). */
const UPSTREAM_MESSAGE_MAX = 2_000;

export type CallTimeouts = { timeoutMs: number; idleMs: number };

/** min(maxMs, max(30 s, ms ?? 360 s)). A non-finite maxMs (unset var) falls back to 900 s. */
export function clampTimeout(ms: number | undefined, maxMs: number = EXECUTOR_MAX_TIMEOUT_MS): number {
  const base = typeof ms === "number" && Number.isFinite(ms) ? ms : EXECUTOR_DEFAULT_TIMEOUT_MS;
  const max = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : EXECUTOR_MAX_TIMEOUT_MS;
  return Math.min(max, Math.max(EXECUTOR_MIN_TIMEOUT_MS, base));
}

/**
 * The upstream request. `body` is the proxy's buildBody(modelId) untouched;
 * for sse the only addition is `stream: true`. Authorization / Content-Type
 * come last and any dispatch header with either name (any letter case —
 * the Headers constructor would otherwise merge `authorization` and
 * `Authorization` into one comma-joined value) is dropped, so a dispatch
 * header can never override them.
 */
export function buildUpstreamInit(
  apiKey: string,
  body: any,
  headers: Record<string, string>,
  transport: ExecutorTransport,
  signal: AbortSignal,
): RequestInit {
  const wire = transport === "sse" ? { ...body, stream: true } : body;
  const passthrough: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "content-type") continue;
    passthrough[k] = v;
  }
  return {
    method: "POST",
    headers: {
      ...passthrough,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(wire),
    signal,
  };
}

// --- SSE accumulator --------------------------------------------------------

export type SseState = {
  buffer: string;
  content: string;
  finish_reason?: string;
  native_finish_reason?: string;
  usage?: any;
  model?: string;
  id?: string;
  provider?: string;
  error?: any;
  done: boolean;
  bytes: number;
  firstByteAt?: number;
};

/** `model` pre-seeds the response model so an error before any chunk still names the model dispatched. */
export function initialSseState(model?: string): SseState {
  return { buffer: "", content: "", done: false, bytes: 0, model };
}

function applySseLine(state: SseState, line: string): void {
  if (line === "") return;                               // event boundary
  if (line.startsWith(":")) return;                      // comment / keepalive (": OPENROUTER PROCESSING")
  if (!line.startsWith("data:")) return;                 // event:/id:/retry: fields are not used
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") {
    state.done = true;
    return;
  }
  let evt: any;
  try {
    evt = JSON.parse(payload);
  } catch {
    return;                                              // a malformed line is ignored, never fatal on its own
  }
  if (!evt || typeof evt !== "object") return;
  // A top-level {"error":…} event is captured whether or not it also carries
  // `choices` (OpenRouter's mid-stream error event carries both: the error
  // plus choices[0].finish_reason "error").
  if (evt.error) state.error = evt.error;
  if (typeof evt.id === "string") state.id = evt.id;
  if (typeof evt.model === "string") state.model = evt.model;
  if (typeof evt.provider === "string") state.provider = evt.provider;
  const choice = Array.isArray(evt.choices) ? evt.choices[0] : undefined;
  if (choice) {
    const delta = choice.delta?.content;
    if (typeof delta === "string") state.content += delta;
    if (choice.finish_reason != null) state.finish_reason = String(choice.finish_reason);
    if (choice.native_finish_reason != null) state.native_finish_reason = String(choice.native_finish_reason);
    if (choice.error && !state.error) state.error = choice.error;
    if (String(choice.finish_reason) === "error" && !state.error) {
      state.error = { message: `finish_reason error (${state.native_finish_reason ?? "unknown"})` };
    }
  }
  if (evt.usage && typeof evt.usage === "object") state.usage = evt.usage;   // last chunk wins
}

/**
 * Feed one decoded chunk. Lines are buffered across chunks (a chunk may end
 * mid-line); comments are ignored but counted as bytes (they are what the
 * idle timer sees); `data: [DONE]` marks completion.
 */
export function accumulateSse(prev: SseState, chunkText: string): SseState {
  const next: SseState = { ...prev, bytes: prev.bytes + chunkText.length };
  const lines = (prev.buffer + chunkText).split(/\r?\n/);
  next.buffer = lines.pop() ?? "";
  for (const line of lines) applySseLine(next, line);
  return next;
}

function errorMessageOf(e: any): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    if (typeof e.message === "string") return e.message;
    try {
      return JSON.stringify(e);
    } catch { /* fall through */ }
  }
  return String(e);
}

/**
 * Assemble the OpenRouter NON-streaming JSON shape from an accumulated
 * stream so the proxy parses it with the same code path it parses a direct
 * response with. A captured error event → upstream_status; a stream that
 * ended with neither finish_reason nor usage → body_transport (truncated).
 */
export function finishSse(state: SseState): { response: any } | { error: ExecutorError } {
  const s: SseState = state.buffer.trim() ? accumulateSse(state, "\n") : state;   // flush an unterminated last line
  const model = s.model ?? "unknown";
  if (s.error) {
    const status = Number(s.error?.code ?? s.error?.status);
    return {
      error: {
        kind: "upstream_status",
        ...(Number.isFinite(status) ? { status } : {}),
        message: errorMessageOf(s.error),
        model,
      },
    };
  }
  if (s.finish_reason == null && !s.usage) {
    return {
      error: {
        kind: "body_transport",
        message: `stream ended after ${s.bytes} bytes without finish_reason or usage${s.done ? "" : " (no [DONE])"}`,
        model,
      },
    };
  }
  const choice: any = { index: 0, message: { role: "assistant", content: s.content } };
  if (s.finish_reason != null) choice.finish_reason = s.finish_reason;
  if (s.native_finish_reason != null) choice.native_finish_reason = s.native_finish_reason;
  const response: any = {};
  if (s.id != null) response.id = s.id;
  if (s.provider != null) response.provider = s.provider;
  response.model = model;
  response.object = "chat.completion";
  response.choices = [choice];
  if (s.usage != null) response.usage = s.usage;
  return { response };
}

// --- failure classification -------------------------------------------------

type AbortMark = { abortKind: "timeout" | "idle"; abortMs: number };

function isAbortMark(e: unknown): e is AbortMark {
  return !!e && typeof e === "object" && ((e as any).abortKind === "timeout" || (e as any).abortKind === "idle");
}

/**
 * `e` carrying { abortKind, abortMs } (set by the timer that fired) →
 * timeout | idle; a bare AbortError → timeout; otherwise by phase:
 * pre_response (fetch rejected before headers), headers (non-2xx: `status`),
 * body (2xx but the body could not be read / parsed).
 */
export function classifyFailure(
  e: unknown,
  phase: "pre_response" | "headers" | "body",
  status?: number,
  model: string = "unknown",
): ExecutorError {
  if (isAbortMark(e)) {
    return e.abortKind === "timeout"
      ? { kind: "timeout", message: `OpenRouter call to ${model} timed out after ${e.abortMs}ms`, model, ms: e.abortMs }
      : { kind: "idle", message: `OpenRouter stream from ${model} sent no bytes for ${e.abortMs}ms`, model, ms: e.abortMs };
  }
  const message = errorMessageOf(e);
  if ((e as any)?.name === "AbortError") return { kind: "timeout", message, model };
  if (phase === "pre_response") return { kind: "pre_response", message, model };
  if (phase === "headers") {
    return { kind: "upstream_status", status: Number.isFinite(Number(status)) ? Number(status) : 0, message, model };
  }
  return { kind: "body_transport", message, model };
}

// --- the call ---------------------------------------------------------------

export type CallOptions = {
  apiKey: string;
  body: any;
  headers: Record<string, string>;
  transport: ExecutorTransport;
  timeoutMs: number;
  idleMs: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

function isSseContentType(r: Response): boolean {
  return /text\/event-stream/i.test(r.headers.get("content-type") ?? "");
}

/**
 * One POST to OpenRouter with a total timer and an idle timer on one
 * AbortController; the timer that fires marks the failure kind. The idle
 * timer is armed only once the response headers are in and only for the
 * sse transport: before headers there are no bytes to watch (a 285 s
 * time-to-first-token is legitimate), and `transport:"json"` has no bytes
 * until the whole completion is ready, so it is governed by the total
 * timer alone — exactly as the inline proxy is today. Streams with
 * TextDecoderStream and assembles the non-streaming shape; `transport:"json"`
 * awaits r.json() exactly as the inline proxy does today.
 */
export async function callOpenRouterOnce(
  fetchImpl: typeof fetch,
  o: CallOptions,
  version: string,
): Promise<CallOutput> {
  const now = o.now ?? (() => Date.now());
  const st = o.setTimeout ?? setTimeout;
  const ct = o.clearTimeout ?? clearTimeout;
  const model = String(o.body?.model ?? "unknown");
  const controller = new AbortController();
  let fired: AbortMark | null = null;
  const abortWith = (mark: AbortMark) => {
    if (fired) return;
    fired = mark;
    controller.abort();
  };
  const totalTimer = st(() => abortWith({ abortKind: "timeout", abortMs: o.timeoutMs }), o.timeoutMs);
  let idleTimer: ReturnType<typeof st> | undefined;               // armed by the first kick(), never before headers
  const stopIdle = () => {
    if (idleTimer !== undefined) ct(idleTimer);
    idleTimer = undefined;
  };
  const kick = () => {
    stopIdle();
    idleTimer = st(() => abortWith({ abortKind: "idle", abortMs: o.idleMs }), o.idleMs);
  };
  const fail = (e: unknown, phase: "pre_response" | "headers" | "body", status?: number): CallOutput => {
    const error = classifyFailure(fired ?? e, phase, status, model);
    // A bare AbortError (no timer mark) is still a timeout; give the orchestrator's ProxyTimeoutError the budget it ran under.
    if (error.kind === "timeout" && error.ms == null) error.ms = o.timeoutMs;
    return { ok: false, error };
  };
  // Rejects the moment the signal aborts, so a read on a stalled body cannot outlive the timers.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(fired ?? new Error("aborted")), { once: true });
  });
  aborted.catch(() => {});
  const t0 = now();
  try {
    let r: Response;
    try {
      r = await fetchImpl(OPENROUTER_CHAT_URL, buildUpstreamInit(o.apiKey, o.body, o.headers, o.transport, controller.signal));
    } catch (e) {
      return fail(e, "pre_response");
    }
    if (o.transport === "sse") kick();                   // headers are in: from here the idle timer watches the body
    if (!r.ok) {
      let text = "";
      try {
        text = await Promise.race([r.text(), aborted]);
      } catch (e) {
        return fail(e, "body");
      }
      return fail(new Error(text.slice(0, UPSTREAM_MESSAGE_MAX) || `HTTP ${r.status}`), "headers", r.status);
    }
    if (o.transport === "json" || !isSseContentType(r)) {
      // Non-streaming (or OpenRouter answered a plain JSON body to a stream request): same as the proxy's r.json(),
      // under the total timer only.
      stopIdle();
      let json: any;
      try {
        json = await Promise.race([r.json(), aborted]);
      } catch (e) {
        return fail(e, "body");
      }
      return {
        ok: true,
        response: json,
        model: typeof json?.model === "string" ? json.model : model,
        latency_ms: now() - t0,
        ttft_ms: null,
        streamed: false,
        executor_version: version,
      };
    }
    if (!r.body) return fail(new Error("2xx response without a body"), "body");
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let state = initialSseState(model);
    let ttft: number | null = null;
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        kick();                                          // every received chunk, keepalive comments included
        if (!value) continue;
        state = accumulateSse(state, value);
        if (ttft == null && state.content.length > 0) ttft = now() - t0;
        if (state.done) {                                // `data: [DONE]` — do not wait on a lingering socket
          reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (e) {
      reader.cancel().catch(() => {});
      return fail(e, "body");
    }
    const fin = finishSse(state);
    if ("error" in fin) return { ok: false, error: fin.error };
    return {
      ok: true,
      response: fin.response,
      model: typeof fin.response.model === "string" ? fin.response.model : model,
      latency_ms: now() - t0,
      ttft_ms: ttft,
      streamed: true,
      executor_version: version,
    };
  } finally {
    ct(totalTimer);
    stopIdle();
  }
}
