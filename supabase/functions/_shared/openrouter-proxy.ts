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

export class SeatUnavailable extends Error {}
export class NoUserKey extends Error {}

export type ProxyMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProxyOptions = {
  json?: boolean;
  temperature?: number;
  runId?: string;
  projectId?: string;
  seatOverrideModel?: string; // ignored unless model is in registry
};

export type ProxyResult = {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  raw: any;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Rough fallback pricing (USD per 1M tokens) when OpenRouter usage doesn't report cost.
// Values are conservative estimates only — accurate accounting uses usage.cost when present.
const FALLBACK_PRICING: Record<string, { in: number; out: number }> = {
  default: { in: 3, out: 15 },
};

function estimateCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const p = FALLBACK_PRICING[modelId] ?? FALLBACK_PRICING.default;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

async function loadSeat(admin: SupabaseClient, seat: string) {
  const { data, error } = await admin
    .from("model_registry")
    .select("seat, model_id, role_prompt, enabled")
    .eq("seat", seat)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new SeatUnavailable(`Seat ${seat} not configured`);
  if (!data.enabled) throw new SeatUnavailable(`Seat ${seat} is disabled`);
  return data;
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

export async function callSeat(
  userId: string,
  seat: string,
  messages: ProxyMessage[],
  options: ProxyOptions = {},
): Promise<ProxyResult> {
  const admin = adminClient();

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

  const body: any = {
    model: seatRow.model_id,
    messages: [...systemMessages, ...messages],
    temperature: options.temperature ?? 0.4,
    usage: { include: true },
  };
  if (options.json) body.response_format = { type: "json_object" };

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
  const content: string = json?.choices?.[0]?.message?.content ?? "";
  const usage = json?.usage ?? {};
  const tokensIn = Number(usage.prompt_tokens ?? 0);
  const tokensOut = Number(usage.completion_tokens ?? 0);
  const reportedCost = Number(usage.cost);
  const costUsd = Number.isFinite(reportedCost) && reportedCost > 0
    ? reportedCost
    : estimateCost(seatRow.model_id, tokensIn, tokensOut);

  // Cost ledger
  await admin.from("cost_ledger").insert({
    user_id: userId,
    project_id: options.projectId ?? null,
    run_id: options.runId ?? null,
    seat,
    model_id: seatRow.model_id,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
  });

  // Update run spent + budget warning (best-effort)
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

  return { content, model: seatRow.model_id, tokensIn, tokensOut, costUsd, raw: json };
}
