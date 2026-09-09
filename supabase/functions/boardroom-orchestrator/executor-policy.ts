// deno-lint-ignore-file no-explicit-any
// Batch 17 — pure decisions for the Cloudflare executor path (spec §4, §5.6,
// §5.7, §6.5, §6.6, §9.5). No I/O and no Deno.* so every table in §12 is
// unit-tested without a database or a Worker. The orchestrator (index.ts)
// owns every write; this module only says what to write.
import {
  ProxyTimeoutError,
  REFUSAL_RETRY_WINDOW_MS,
  type PreparedSeatCall,
  type ProxyOptions,
  type SmokeModelSource,
  type settleSeatCall,
} from "../_shared/openrouter-proxy.ts";
import type { CallOutput, ExecutorError, ExecutorTransport } from "../_shared/executor-protocol.ts";
import type { PollResult } from "../_shared/executor-client.ts";

// ============================== Constants (§6.6) ==============================

export const EXECUTOR_DEFAULT_TIMEOUT_MS = 360_000;
export const EXECUTOR_MAX_TIMEOUT_MS = 900_000;
export const EXECUTOR_MIN_TIMEOUT_MS = 30_000;
export const EXECUTOR_GRACE_MS = 90_000;
export const EXECUTOR_REDISPATCH_WINDOW_MS = 180_000;
export const EXECUTOR_POLL_FAILURE_MAX = 10;
export const EXECUTOR_DISPATCH_MAX = 3;
// COLLECT_BUDGET: 150 s isolate − 120 s STEP_HARD_TIMEOUT_MS (an inline step
// may follow the collector in the same invocation) − ~10 s sweep/watchdog
// headroom (§5.2). Measured from TICK start, not from collector start.
export const EXECUTOR_COLLECT_BUDGET_MS = 20_000;
export const EXECUTOR_UNREACHABLE_BREAKER = 3;
export const EXECUTOR_DEFAULT_IDLE_MS = 90_000;
/** Low reasoning effort scales the timeout by 0.6 but never below this. */
export const EXECUTOR_LOW_EFFORT_FLOOR_MS = 120_000;

export const EXECUTOR_MODEL_TIMEOUTS_MS: Record<string, number> = {
  "anthropic/claude-fable-5.1": 720_000, // 285 s TTFT at max effort + a long answer
  "openai/gpt-6-astra": 600_000,
  "x-ai/grok-4.6": 480_000,
  "qwen/qwen3.8-max-0902": 480_000,
  "anthropic/claude-haiku-4.5": 180_000, // smoke / reserve
};

// ============================== Settings (§4) ==============================

export type ExecutorSettings = {
  enabled?: boolean;
  transport?: ExecutorTransport;
  timeouts_ms?: { default?: number; by_model?: Record<string, number> };
};

function positiveNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Pure. The app_settings.executor value, validated field by field; anything
// that is not an object (missing row, null, a bare boolean) is null =
// disabled. Unknown keys are dropped, malformed values ignored.
export function parseExecutorSettings(value: unknown): ExecutorSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: ExecutorSettings = {};
  if (typeof v.enabled === "boolean") out.enabled = v.enabled;
  if (v.transport === "sse" || v.transport === "json") out.transport = v.transport;
  const t = v.timeouts_ms;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    const tt = t as Record<string, unknown>;
    const timeouts: NonNullable<ExecutorSettings["timeouts_ms"]> = {};
    const def = positiveNumber(tt.default);
    if (def !== undefined) timeouts.default = def;
    if (tt.by_model && typeof tt.by_model === "object" && !Array.isArray(tt.by_model)) {
      const byModel: Record<string, number> = {};
      for (const [k, raw] of Object.entries(tt.by_model as Record<string, unknown>)) {
        const n = positiveNumber(raw);
        if (n !== undefined) byModel[k] = n;
      }
      if (Object.keys(byModel).length) timeouts.by_model = byModel;
    }
    if (Object.keys(timeouts).length) out.timeouts_ms = timeouts;
  }
  return out;
}

export type ExecutorEnv = { url: string; secret: string } | null;

// Pure. null env → inline; step.request._executor_bypass === true → inline;
// run.consensus.executor === false → inline; === true → executor; else
// setting?.enabled === true.
export function executorMode(
  env: ExecutorEnv,
  setting: { enabled?: boolean } | null,
  run: { consensus?: any } | null,
  step: { request?: any } | null,
): "executor" | "inline" {
  if (!env) return "inline";
  if (step?.request?._executor_bypass === true) return "inline";
  const override = run?.consensus?.executor;
  if (override === false) return "inline";
  if (override === true) return "executor";
  return setting?.enabled === true ? "executor" : "inline";
}

// ============================== Timeout policy (§6.6) ==============================

// Pure. base = overrides.by_model[modelId] ?? table[modelId] ?? overrides.default
// ?? DEFAULT; effort "low" → ×0.6 with a 120 s floor (never above the base
// itself); clamp [MIN, MAX].
export function executorTimeoutMs(
  modelId: string,
  reasoningEffort: "low" | "medium" | "high" | undefined,
  overrides?: { default?: number; by_model?: Record<string, number> },
): number {
  const base = positiveNumber(overrides?.by_model?.[modelId])
    ?? positiveNumber(EXECUTOR_MODEL_TIMEOUTS_MS[modelId])
    ?? positiveNumber(overrides?.default)
    ?? EXECUTOR_DEFAULT_TIMEOUT_MS;
  let ms = base;
  if (reasoningEffort === "low") {
    ms = Math.min(base, Math.max(EXECUTOR_LOW_EFFORT_FLOOR_MS, Math.round(base * 0.6)));
  }
  return Math.min(EXECUTOR_MAX_TIMEOUT_MS, Math.max(EXECUTOR_MIN_TIMEOUT_MS, Math.round(ms)));
}

// ============================== executor_meta (§3.3) ==============================

export type ExecutorMeta = {
  call_id: string;
  seat: string;
  model_id: string;
  primary_model_id: string;
  fallback_model_id: string | null;
  fallback_allowed: boolean;
  force_fallback: boolean;
  smoke_source: SmokeModelSource | null;
  json: boolean;
  wire_max_tokens: number;
  prompt_chars: number;
  timeout_ms: number;
  deadline_at: string;
  transport: ExecutorTransport;
  dispatch_attempts: number;
  poll_failures: number;
  last_state: string | null;
  last_polled_at: string | null;
  orchestrator_build: string;
};

// Pure. Everything a settle needs that is not on the row or in the callback.
// Never the key, never the messages: prompt_chars stands in for the body so
// the timeout estimate (timeoutLedgerEstimate semantics) can be rebuilt.
export function buildExecutorMeta(
  p: Pick<PreparedSeatCall, "seat" | "modelId" | "primaryModelId" | "fallbackModelId" | "smokeSource" | "options" | "wireMaxTokens" | "promptChars">,
  callId: string,
  timeoutMs: number,
  transport: ExecutorTransport,
  nowIso: string,
  build: string,
  forceFallback: boolean,
): ExecutorMeta {
  const now = Date.parse(nowIso);
  return {
    call_id: callId,
    seat: p.seat,
    model_id: p.modelId,
    primary_model_id: p.primaryModelId,
    fallback_model_id: p.fallbackModelId ?? null,
    fallback_allowed: !!p.fallbackModelId,
    force_fallback: !!forceFallback,
    smoke_source: p.smokeSource ?? null,
    json: !!p.options?.json,
    wire_max_tokens: Number(p.wireMaxTokens ?? 0) || 0,
    prompt_chars: Number(p.promptChars ?? 0) || 0,
    timeout_ms: timeoutMs,
    deadline_at: new Date((Number.isFinite(now) ? now : Date.now()) + timeoutMs + EXECUTOR_GRACE_MS).toISOString(),
    transport,
    dispatch_attempts: 1,
    poll_failures: 0,
    last_state: null,
    last_polled_at: null,
    orchestrator_build: build,
  };
}

// Pure. Rebuild settleSeatCall's `p` argument (plus promptChars for the
// timeout estimate) from executor_meta and the run row. Only the ledger
// options (runId / projectId) matter to recordCall; the rest mirror the
// inline seatOptions so a ProxyResult settled here is indistinguishable.
export function fromMeta(
  meta: ExecutorMeta,
  run: { id: string; project_id: string | null; user_id: string },
  step: { request?: any },
): Parameters<typeof settleSeatCall>[1] & { promptChars: number } {
  const options: ProxyOptions = {
    runId: run.id,
    projectId: run.project_id ?? undefined,
    json: !!meta.json,
    forceFallback: !!meta.force_fallback,
    ...(step?.request?.reasoning_effort ? { reasoningEffort: step.request.reasoning_effort } : {}),
    ...(meta.smoke_source ? { smoke: true } : {}),
  };
  return {
    userId: run.user_id,
    seat: meta.seat,
    modelId: meta.model_id,
    primaryModelId: meta.primary_model_id,
    ...(meta.smoke_source ? { smokeSource: meta.smoke_source } : {}),
    options,
    wireMaxTokens: Number(meta.wire_max_tokens ?? 0) || 0,
    jsonMode: !!meta.json,
    promptChars: Number(meta.prompt_chars ?? 0) || 0,
  };
}

// ============================== Poll decisions (§5.6) ==============================

export type PollDecision =
  | { action: "wait" }
  | { action: "settle_ok"; output: CallOutput & { ok: true } }
  | { action: "settle_error"; output: CallOutput & { ok: false } }
  | { action: "redispatch" }
  | { action: "lost"; reason: string }
  | { action: "deadline" }
  | { action: "unreachable" }
  | { action: "no_env" };

const WAIT_STATES = new Set(["queued", "running", "waiting", "paused"]);

// Pure. A CallOutput the settle can act on: `ok` boolean, and the half the
// flag promises present as an object (`response` for ok:true, `error` for
// ok:false). A malformed ok:true would make parseOpenRouterResponse throw
// inside settleSeatCall on every callback retry and every collector tick —
// and because `complete` beats the deadline clock that row would have no
// exit — so the callback answers 400 and the poll treats it as `lost`.
export function isWellFormedCallOutput(output: unknown): output is CallOutput {
  if (!output || typeof output !== "object") return false;
  const o = output as any;
  if (typeof o.ok !== "boolean") return false;
  const half = o.ok ? o.response : o.error;
  return !!half && typeof half === "object";
}

// Pure. The §5.6 table. `poll` is null when no poll was made (env absent).
// Order: a complete instance settles whatever the clock says; not_found is
// decided by the re-dispatch window (never by the deadline — no usage can
// exist, so `lost` is the cheaper exit); everything else past the deadline
// is `deadline`; then the wait / lost / unreachable rules.
export function decideOnPoll(
  row: { status: string; executor_dispatched_at: string | null; executor_meta: ExecutorMeta | null },
  poll: PollResult | null,
  nowMs: number,
  envPresent: boolean,
): PollDecision {
  const meta = row.executor_meta;
  const dispatchedAt = Date.parse(String(row.executor_dispatched_at ?? ""));
  const dispatchedMs = Number.isFinite(dispatchedAt) ? dispatchedAt : nowMs;
  const timeoutMs = positiveNumber(meta?.timeout_ms) ?? EXECUTOR_DEFAULT_TIMEOUT_MS;
  const metaDeadline = Date.parse(String(meta?.deadline_at ?? ""));
  const deadlineMs = Number.isFinite(metaDeadline) ? metaDeadline : dispatchedMs + timeoutMs + EXECUTOR_GRACE_MS;
  const pastDeadline = nowMs >= deadlineMs;
  const pollFailures = Number(meta?.poll_failures ?? 0) || 0;
  const dispatchAttempts = Number(meta?.dispatch_attempts ?? 0) || 0;

  if (!envPresent) return pastDeadline ? { action: "deadline" } : { action: "no_env" };

  if (poll && poll.kind === "state" && poll.state === "complete") {
    const out = poll.output;
    if (!out) return { action: "lost", reason: "complete_without_output" };
    if (!isWellFormedCallOutput(out)) return { action: "lost", reason: "malformed_output" };
    if (out.ok === true) return { action: "settle_ok", output: out };
    return { action: "settle_error", output: out };
  }

  if (poll && poll.kind === "not_found") {
    if (nowMs - dispatchedMs < EXECUTOR_REDISPATCH_WINDOW_MS && dispatchAttempts < EXECUTOR_DISPATCH_MAX) {
      return { action: "redispatch" };
    }
    return { action: "lost", reason: dispatchAttempts >= EXECUTOR_DISPATCH_MAX ? "dispatch_attempts_exhausted" : "not_found" };
  }

  // errored | terminated beat the deadline clock: no usage arrived (§5.6
  // "nothing to ledger"), so an instance that errored early (unseal failure,
  // engine error) but is first observed past the deadline — a Worker outage
  // spanning it — is released as lost, never charged the :timeout estimate.
  // An instance WE terminated at the deadline had its estimate written by
  // handleExecutorDeadline before the cancel, so it is not under-charged.
  if (poll && poll.kind === "state" && (poll.state === "errored" || poll.state === "terminated")) {
    return { action: "lost", reason: poll.state };
  }

  if (pastDeadline) return { action: "deadline" };

  if (poll && poll.kind === "state") {
    if (WAIT_STATES.has(poll.state)) return { action: "wait" };
    // `unknown` (the platform status or a string the Worker did not
    // recognise) counts exactly like a transport failure.
  }

  // unreachable / unknown / malformed: bounded by the failure cap.
  if (pollFailures + 1 >= EXECUTOR_POLL_FAILURE_MAX) return { action: "lost", reason: "poll_failures_exhausted" };
  return { action: "unreachable" };
}

// ============================== Error contract (§6.5) ==============================

// Pure. Rebuild the proxy's own error shapes from the Worker's classified
// failure so shouldQuickRetry / isBodyTransportError / isTimeout / the
// timeout branch behave exactly as they do for an inline throw.
export function errorFromExecutor(e: ExecutorError): Error {
  const model = String(e?.model ?? "unknown");
  const message = String(e?.message ?? "");
  switch (e?.kind) {
    case "timeout":
    case "idle": {
      const err: any = new ProxyTimeoutError(model, Number(e.ms ?? 0) || 0);
      err.executorKind = e.kind;
      return err;
    }
    case "upstream_status": {
      const status = Number(e.status);
      const err: any = new Error(`OpenRouter ${Number.isFinite(status) ? status : "error"}: ${message}`);
      if (Number.isFinite(status)) err.status = status;
      err.isPreResponse = false;
      err.executorKind = e.kind;
      return err;
    }
    case "pre_response": {
      const err: any = new Error(message || "pre-response network failure");
      err.isPreResponse = true;
      err.executorKind = e.kind;
      return err;
    }
    case "body_transport": {
      const err: any = new Error(message || "response body transport failure");
      err.isBodyTransport = true;
      err.isPreResponse = false;
      err.attemptedModel = model;
      err.executorKind = e.kind;
      return err;
    }
    default: {
      const err: any = new Error(message || `executor failure (${String(e?.kind ?? "unknown")})`);
      err.executorKind = e?.kind ?? "unknown";
      return err;
    }
  }
}

// ============================== Refusal mirror (§5.7) ==============================

export type RefusalDecision =
  | { action: "requeue"; request: any; error: string }
  | { action: "accept" };

// Pure. Called only for a response isRefusal() flagged. The same 15 s window
// callSeat honours, measured by the Worker's latency_ms instead of the
// isolate clock; each attempt is a fresh claim with its own call id.
export function refusalRequeueDecision(request: any, latencyMs: number, fallbackAllowed: boolean): RefusalDecision {
  const req = request ?? {};
  const attempts = Number(req._refusal_attempts ?? 0) || 0;
  const latency = Number(latencyMs);
  if (!Number.isFinite(latency) || latency >= REFUSAL_RETRY_WINDOW_MS) return { action: "accept" };
  if (attempts === 0) {
    return { action: "requeue", request: { ...req, _refusal_attempts: 1 }, error: "refusal_requeued" };
  }
  if (attempts === 1 && fallbackAllowed) {
    return {
      action: "requeue",
      request: { ...req, force_fallback: true, _refusal_fallback: true, _refusal_attempts: 2 },
      error: "refusal_fallback_requeued",
    };
  }
  return { action: "accept" };
}

// ============================== Lost calls (§5.6) ==============================

// Pure. `_executor_errors` + 1; at ≥ 2 the step also gets `_executor_bypass`
// so its next claim runs inline (degrade, never strand).
export function lostRequeueRequest(request: any): { request: any; bypass: boolean } {
  const req = request ?? {};
  const n = (Number(req._executor_errors ?? 0) || 0) + 1;
  const bypass = n >= 2;
  return {
    request: { ...req, _executor_errors: n, ...(bypass ? { _executor_bypass: true } : {}) },
    bypass,
  };
}

// ============================== Budget-pause hardening (§9.6) ==============================

// Pure. The status filters the three budget-pause writes are guarded with:
// the step flips to queued only from running, the run to paused_budget only
// from queued/running — so a late pause from a settle cannot reopen a row or
// a run that has already moved on.
export function budgetPausePatch(_reason: "daily_cap" | "budget" | "seat_cap"): { stepGuard: string[]; runGuard: string[] } {
  return { stepGuard: ["running"], runGuard: ["queued", "running"] };
}
