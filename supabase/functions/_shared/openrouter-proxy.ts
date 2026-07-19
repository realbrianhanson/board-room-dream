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

export type ProxyMessage = { role: "system" | "user" | "assistant"; content: string };

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
};

export type FallbackMeta = {
  fallback_model_used: string;
  primary_model: string;
  reason: "refusal";
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
};

async function loadSeat(admin: SupabaseClient, seat: string): Promise<SeatRow> {
  const { data, error } = await admin
    .from("model_registry")
    .select("seat, model_id, role_prompt, enabled, fallback_model_id")
    .eq("seat", seat)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new SeatUnavailable(`Seat ${seat} not configured`);
  if (!data.enabled) throw new SeatUnavailable(`Seat ${seat} is disabled`);
  return data as SeatRow;
}

async function loadAllowedModels(admin: SupabaseClient): Promise<Set<string>> {
  const { data } = await admin.from("model_registry").select("model_id").eq("enabled", true);
  return new Set((data ?? []).map((r: any) => r.model_id));
}

async function loadConstitution(admin: SupabaseClient): Promise<string> {
  const { data } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "constitution")
    .maybeSingle();
  return String((data?.value as any)?.text ?? "");
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
  if (jsonMode) {
    // If asked for JSON, but got short prose that matches refusal — refusal.
    const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```");
    if (!looksJson && trimmed.length < 800 && REFUSAL_PATTERNS.some((r) => r.test(trimmed))) return true;
  } else {
    if (trimmed.length < 400 && REFUSAL_PATTERNS.some((r) => r.test(trimmed))) return true;
  }
  return false;
}

async function callOpenRouter(
  apiKey: string,
  body: any,
): Promise<{ content: string; finishReason: string | undefined; usage: any; raw: any }> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://boardroom.lovable.app",
      "X-Title": "BOARDROOM",
    },
    body: JSON.stringify(body),
  });
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

  // 1st attempt on primary
  let attempt = await doCall(seatRow.model_id);
  let refused = isRefusal(attempt.content, attempt.finishReason, !!options.json);

  // 2nd attempt on primary (one retry)
  if (refused) {
    attempt = await doCall(seatRow.model_id);
    refused = isRefusal(attempt.content, attempt.finishReason, !!options.json);
  }

  // Fallback model
  if (refused
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
        reason: "refusal",
      },
    };
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
