// deno-lint-ignore-file no-explicit-any
// The single choke point for every LLM call in BOARDROOM.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptSecret } from "./crypto.ts";

export class BudgetExceeded extends Error {
  constructor(msg = "Run budget exceeded") {
    super(msg);
    this.name = "BudgetExceeded";
  }
}

export class DailyCapExceeded extends Error {
  cap: number;
  spent: number;
  scope: "cohort" | "default";
  constructor(cap: number, spent: number, scope: "cohort" | "default") {
    super(`Daily cap $${cap.toFixed(2)} exceeded (spent $${spent.toFixed(2)})`);
    this.name = "DailyCapExceeded";
    this.cap = cap;
    this.spent = spent;
    this.scope = scope;
  }
}

export class SeatUnavailable extends Error {}
export class NoUserKey extends Error {}

// Per-seat spend cap (model_registry.max_cost_per_run) hit within a single run.
export class SeatBudgetExceeded extends Error {
  seat: string;
  cap: number;
  spent: number;
  constructor(seat: string, cap: number, spent: number) {
    super(`Seat ${seat} exceeded its per-run cap $${cap.toFixed(2)} (spent $${spent.toFixed(2)})`);
    this.name = "SeatBudgetExceeded";
    this.seat = seat;
    this.cap = cap;
    this.spent = spent;
  }
}

// Distinct timeout error — the orchestrator (NOT this proxy) is responsible
// for running the fallback in a fresh edge-function invocation. The platform
// hard-kills invocations near ~150s and takes in-isolate timers with it, so
// any fallback attempt inside the same invocation is a lie: it may look like
// it started, but the isolate is already dead. Callers pattern-match on
// `isTimeout === true` and requeue the step.
export class ProxyTimeoutError extends Error {
  isTimeout = true;
  attemptedModel: string;
  ms: number;
  constructor(model: string, ms: number) {
    super(`OpenRouter call to ${model} timed out after ${ms}ms`);
    this.name = "ProxyTimeoutError";
    this.attemptedModel = model;
    this.ms = ms;
  }
}

// Abort a model call that hangs past this many ms and surface a
// ProxyTimeoutError so the ORCHESTRATOR can requeue the step with
// force_fallback in a fresh invocation. Clamped to 30s-115s so the abort
// always fires well before the platform's ~150s wall-clock cap; tunable via
// the OPENROUTER_TIMEOUT_MS secret. Default 105s.
const OPENROUTER_TIMEOUT_MS = Math.min(
  115_000,
  Math.max(30_000, Number(Deno.env.get("OPENROUTER_TIMEOUT_MS") ?? 105_000)),
);


// Multimodal content parts (OpenRouter follows the OpenAI shape). Design runs
// attach signed screenshot URLs so the board critiques what it can actually see.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ProxyMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export type ProxyOptions = {
  json?: boolean;
  temperature?: number;
  runId?: string;
  projectId?: string;
  seatOverrideModel?: string;
  /** OpenRouter reasoning effort — use "high" for chair-critical synthesis/ruling steps. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Attach OpenRouter's web plugin so the model can ground claims in live search. */
  online?: boolean;
  /** Use the seat's fallback model as the primary for this call (watchdog retries). */
  forceFallback?: boolean;
  /** Cap completion tokens to bound cost/latency on JSON-shape emitters. */
  maxTokens?: number;
};

export type FallbackMeta = {
  fallback_model_used: string;
  primary_model: string;
  reason: "refusal" | "timeout";
};

export type ProxyResult = {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  raw: any;
  fallback?: FallbackMeta;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const FALLBACK_PRICING: Record<string, { in: number; out: number }> = {
  default: { in: 3, out: 15 },
};

function estimateCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const p = FALLBACK_PRICING[modelId] ?? FALLBACK_PRICING.default;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

type SeatRow = {
  seat: string;
  model_id: string;
  role_prompt: string | null;
  enabled: boolean;
  fallback_model_id: string | null;
  max_cost_per_run: number | null;
};

// The model registry and constitution are global (not per-user) and change
// rarely, yet every seat call re-read them from the DB — the biggest source of
// redundant query load during a run. Cache both at module scope with a short
// TTL: warm isolates reuse the cache across invocations, and an admin edit
// still takes effect within the TTL. The user's API key is deliberately NOT
// cached — it stays a per-call read.
const SETTINGS_TTL_MS = 30_000;
let _registryCache: { rows: SeatRow[]; at: number } | null = null;
let _constCache: { text: string; at: number } | null = null;

async function loadRegistry(admin: SupabaseClient): Promise<SeatRow[]> {
  const now = Date.now();
  if (_registryCache && now - _registryCache.at < SETTINGS_TTL_MS) return _registryCache.rows;
  const { data, error } = await admin
    .from("model_registry")
    .select("seat, model_id, role_prompt, enabled, fallback_model_id, max_cost_per_run");
  if (error) throw error;
  const rows = (data ?? []) as SeatRow[];
  _registryCache = { rows, at: now };
  return rows;
}

async function loadSeat(admin: SupabaseClient, seat: string): Promise<SeatRow> {
  const data = (await loadRegistry(admin)).find((r) => r.seat === seat);
  if (!data) throw new SeatUnavailable(`Seat ${seat} not configured`);
  if (!data.enabled) throw new SeatUnavailable(`Seat ${seat} is disabled`);
  return data;
}

async function loadAllowedModels(admin: SupabaseClient): Promise<Set<string>> {
  const rows = await loadRegistry(admin);
  return new Set(rows.filter((r) => r.enabled).map((r) => r.model_id));
}

async function loadConstitution(admin: SupabaseClient): Promise<string> {
  const now = Date.now();
  if (_constCache && now - _constCache.at < SETTINGS_TTL_MS) return _constCache.text;
  const { data } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "constitution")
    .maybeSingle();
  const text = String((data?.value as any)?.text ?? "");
  _constCache = { text, at: now };
  return text;
}

async function loadUserOpenRouterKey(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin
    .from("api_keys")
    .select("encrypted_key, status")
    .eq("user_id", userId)
    .eq("provider", "openrouter")
    .maybeSingle();
  if (!data) throw new NoUserKey("No OpenRouter key stored");
  if (data.status === "invalid") throw new NoUserKey("OpenRouter key is invalid");
  return await decryptSecret(data.encrypted_key);
}

async function checkBudget(admin: SupabaseClient, runId: string) {
  const { data, error } = await admin
    .from("boardroom_runs")
    .select("spent_usd, budget_usd")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  if (Number(data.spent_usd) >= Number(data.budget_usd)) {
    throw new BudgetExceeded();
  }
}

// Per-seat spend cap within a run (model_registry.max_cost_per_run). A guardrail
// against one seat running away — with the Chair defaulted higher than the rest
// since it legitimately does the most work. Skipped when the cap is unset/<=0.
async function checkSeatBudget(admin: SupabaseClient, runId: string, seat: string, cap: number | null) {
  const capNum = Number(cap);
  if (!Number.isFinite(capNum) || capNum <= 0) return;
  const { data } = await admin
    .from("cost_ledger")
    .select("cost_usd")
    .eq("run_id", runId)
    .eq("seat", seat);
  const spent = (data ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0);
  if (spent >= capNum) throw new SeatBudgetExceeded(seat, capNum, spent);
}

async function resolveDailyCap(admin: SupabaseClient, userId: string): Promise<{ cap: number; scope: "cohort" | "default" }> {
  const { data: profile } = await admin
    .from("profiles")
    .select("cohort_id")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.cohort_id) {
    const { data: cohort } = await admin
      .from("cohorts")
      .select("daily_cap_usd")
      .eq("id", profile.cohort_id)
      .maybeSingle();
    const capNum = cohort?.daily_cap_usd == null ? null : Number(cohort.daily_cap_usd);
    if (capNum != null && Number.isFinite(capNum) && capNum > 0) {
      return { cap: capNum, scope: "cohort" };
    }
  }
  const { data: setting } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "default_daily_cap_usd")
    .maybeSingle();
  const usd = Number((setting?.value as any)?.usd);
  return { cap: Number.isFinite(usd) && usd > 0 ? usd : 25, scope: "default" };
}

async function checkDailyCap(admin: SupabaseClient, userId: string): Promise<void> {
  const { cap, scope } = await resolveDailyCap(admin, userId);
  // Sum today's UTC ledger
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data } = await admin
    .from("cost_ledger")
    .select("cost_usd")
    .eq("user_id", userId)
    .gte("created_at", start.toISOString());
  const spent = (data ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0);
  if (spent >= cap) throw new DailyCapExceeded(cap, spent, scope);
}

const REFUSAL_PATTERNS = [
  /\bi (?:can't|cannot|won't|will not) (?:help|assist|comply|do|provide)/i,
  /\bi'?m (?:unable|not able) to (?:help|assist|comply|provide)/i,
  /\bi (?:must|have to) decline\b/i,
  /\bas an ai\b.*\b(?:can'?t|cannot|unable)\b/i,
];

function isRefusal(content: string, finishReason: string | undefined, jsonMode: boolean): boolean {
  if (finishReason === "content_filter" || finishReason === "safety") return true;
  const trimmed = (content ?? "").trim();
  if (!trimmed) return true;
  // Anything that even looks like an attempt at the requested format is not a
  // refusal — the validation/re-prompt layer owns malformed output. Refusals
  // are short prose that LEADS with the refusal, so anchor the regex to the
  // opening of the text; a mid-document "I can't help but notice…" must not
  // burn a fallback call.
  if (jsonMode) {
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```")) return false;
    try {
      JSON.parse(trimmed);
      return false;
    } catch { /* not JSON — fall through to prose check */ }
    return trimmed.length < 800 && REFUSAL_PATTERNS.some((r) => r.test(trimmed.slice(0, 200)));
  }
  return trimmed.length < 300 && REFUSAL_PATTERNS.some((r) => r.test(trimmed.slice(0, 200)));
}

async function callOpenRouter(
  apiKey: string,
  body: any,
): Promise<{ content: string; finishReason: string | undefined; usage: any; raw: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://boardroom.lovable.app",
        "X-Title": "BOARDROOM",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // A hung model that never responds gets aborted here — throw a distinct
    // ProxyTimeoutError so callSeat's caller (the orchestrator) can requeue
    // the step with force_fallback in a fresh invocation. NEVER start a
    // fallback call inside this same invocation; the platform will kill it.
    if ((e as Error)?.name === "AbortError") {
      throw new ProxyTimeoutError(String(body?.model ?? "unknown"), OPENROUTER_TIMEOUT_MS);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`OpenRouter ${r.status}: ${text}`);
    (err as any).status = r.status;
    throw err;
  }
  const json = await r.json();
  const choice = json?.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason,
    usage: json?.usage ?? {},
    raw: json,
  };
}


async function recordCall(
  admin: SupabaseClient,
  userId: string,
  seat: string,
  modelId: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  options: ProxyOptions,
) {
  await admin.from("cost_ledger").insert({
    user_id: userId,
    project_id: options.projectId ?? null,
    run_id: options.runId ?? null,
    seat,
    model_id: modelId,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
  });
  if (options.runId) {
    const { data: run } = await admin
      .from("boardroom_runs")
      .select("spent_usd, budget_usd, budget_warning")
      .eq("id", options.runId)
      .maybeSingle();
    if (run) {
      const newSpent = Number(run.spent_usd) + costUsd;
      const patch: any = { spent_usd: newSpent };
      if (!run.budget_warning && newSpent >= Number(run.budget_usd) * 0.8) {
        patch.budget_warning = true;
      }
      await admin.from("boardroom_runs").update(patch).eq("id", options.runId);
    }
  }
}

export async function callSeat(
  userId: string,
  seat: string,
  messages: ProxyMessage[],
  options: ProxyOptions = {},
): Promise<ProxyResult> {
  const admin = adminClient();

  // Daily cap (before every call)
  await checkDailyCap(admin, userId);
  if (options.runId) await checkBudget(admin, options.runId);

  const seatRow = await loadSeat(admin, seat);
  if (options.runId) await checkSeatBudget(admin, options.runId, seat, seatRow.max_cost_per_run);
  const allowed = await loadAllowedModels(admin);
  if (!allowed.has(seatRow.model_id)) {
    throw new SeatUnavailable(`Model ${seatRow.model_id} not in allowlist`);
  }

  const [constitution, apiKey] = await Promise.all([
    loadConstitution(admin),
    loadUserOpenRouterKey(admin, userId),
  ]);

  const systemMessages: ProxyMessage[] = [
    { role: "system", content: `CONSTITUTION\n${constitution}` },
    {
      role: "system",
      content: seatRow.role_prompt ?? `You are the ${seat} of the board.`,
    },
  ];

  const buildBody = (modelId: string) => {
    const body: any = {
      model: modelId,
      messages: [...systemMessages, ...messages],
      temperature: options.temperature ?? 0.4,
      usage: { include: true },
    };
    if (options.json) body.response_format = { type: "json_object" };
    if (options.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };
    if (options.online) body.plugins = [{ id: "web", max_results: 5 }];
    if (options.maxTokens && options.maxTokens > 0) body.max_tokens = options.maxTokens;
    return body;
  };

  const doCall = async (modelId: string) => {
    const res = await callOpenRouter(apiKey, buildBody(modelId));
    const tokensIn = Number(res.usage.prompt_tokens ?? 0);
    const tokensOut = Number(res.usage.completion_tokens ?? 0);
    const reportedCost = Number(res.usage.cost);
    const costUsd = Number.isFinite(reportedCost) && reportedCost > 0
      ? reportedCost
      : estimateCost(modelId, tokensIn, tokensOut);
    await recordCall(admin, userId, seat, modelId, tokensIn, tokensOut, costUsd, options);
    return { ...res, tokensIn, tokensOut, costUsd, modelId };
  };

  // Watchdog retries can force the fallback model as primary — a step whose
  // primary model keeps outliving the platform's ~150s invocation window gets
  // re-claimed with force_fallback and answered by the fast fallback instead.
  const primaryId = options.forceFallback
    && seatRow.fallback_model_id
    && allowed.has(seatRow.fallback_model_id)
      ? seatRow.fallback_model_id
      : seatRow.model_id;

  // 1st attempt on primary; a timeout (hung model) routes straight to fallback.
  let attempt: Awaited<ReturnType<typeof doCall>> | null = null;
  let refused = false;
  let timedOut = false;
  try {
    attempt = await doCall(primaryId);
    refused = isRefusal(attempt.content, attempt.finishReason, !!options.json);
  } catch (e) {
    if ((e as any)?.isTimeout) timedOut = true;
    else throw e;
  }

  // One retry on a refusal only — a genuinely hung model won't un-hang, so
  // don't waste another timeout window; go straight to the fallback.
  if (refused && !timedOut) {
    attempt = await doCall(primaryId);
    refused = isRefusal(attempt.content, attempt.finishReason, !!options.json);
  }

  // Fail over to the fallback model on a refusal OR a timeout.
  if ((refused || timedOut)
    && seatRow.fallback_model_id
    && seatRow.fallback_model_id !== seatRow.model_id
    && allowed.has(seatRow.fallback_model_id)) {
    const fbAttempt = await doCall(seatRow.fallback_model_id);
    return {
      content: fbAttempt.content,
      model: fbAttempt.modelId,
      tokensIn: fbAttempt.tokensIn,
      tokensOut: fbAttempt.tokensOut,
      costUsd: fbAttempt.costUsd,
      raw: fbAttempt.raw,
      fallback: {
        fallback_model_used: fbAttempt.modelId,
        primary_model: seatRow.model_id,
        reason: timedOut ? "timeout" : "refusal",
      },
    };
  }

  // Primary timed out and there was no usable fallback — surface it so the step
  // fails and the requeue rescues it, rather than returning empty content.
  if (!attempt) {
    throw new Error(`Seat ${seat} model ${seatRow.model_id} timed out with no available fallback`);
  }

  return {
    content: attempt.content,
    model: attempt.modelId,
    tokensIn: attempt.tokensIn,
    tokensOut: attempt.tokensOut,
    costUsd: attempt.costUsd,
    raw: attempt.raw,
  };
}
