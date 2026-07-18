// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const KEY_ENCRYPTION_SECRET = Deno.env.get("KEY_ENCRYPTION_SECRET")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function importAesKey(): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(KEY_ENCRYPTION_SECRET),
  );
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function decrypt(stored: string): Promise<string> {
  const key = await importAesKey();
  const buf = b64decode(stored);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

const DIMENSIONS = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
] as const;

type Scores = Record<(typeof DIMENSIONS)[number], { score: number; evidence: string }>;

type Verdict = { scores: Scores; total: number; verdict: "pass" | "kill"; pivot?: string };

function buildPrompt(constitution: string, chairPrompt: string | null, answers: any) {
  const chair = chairPrompt ??
    "You are the Chair of the board. Rule decisively on whether this idea deserves the board's time.";
  const system = `${chair}\n\nCONSTITUTION\n${constitution}\n\nYou will score a founder's app intake on five dimensions from 1 to 10. Return ONLY strict JSON matching this schema:\n{\n  "scores": {\n    "painful_problem": {"score": 1-10, "evidence": "one sentence"},\n    "reachable_buyer": {"score": 1-10, "evidence": "one sentence"},\n    "monetization_path": {"score": 1-10, "evidence": "one sentence"},\n    "buildable_scope": {"score": 1-10, "evidence": "one sentence"},\n    "differentiation": {"score": 1-10, "evidence": "one sentence"}\n  },\n  "pivot": "one sentence — only if verdict is kill, else empty string"\n}\nDo not include any prose outside the JSON.`;
  const user = `INTAKE ANSWERS\n1. The idea: ${answers?.idea ?? ""}\n2. The buyer: ${answers?.buyer ?? ""}\n3. The pain: ${answers?.pain ?? ""}\n4. Monetization model: ${answers?.money ?? ""}\n5. Inspiration: ${answers?.inspiration ?? ""}\n\nScore honestly. Kill weak ideas fast.`;
  return { system, user };
}

async function callOpenRouter(
  key: string,
  model: string,
  system: string,
  user: string,
): Promise<{ ok: true; content: string } | { ok: false; status: number; body: string }> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://boardroom.lovable.app",
      "X-Title": "BOARDROOM",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    return { ok: false, status: r.status, body };
  }
  const json = await r.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  return { ok: true, content };
}

function parseVerdict(content: string): Verdict | null {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const scores: any = parsed?.scores;
  if (!scores) return null;
  const out: any = {};
  let total = 0;
  let anyLow = false;
  for (const d of DIMENSIONS) {
    const s = Number(scores?.[d]?.score);
    const evidence = String(scores?.[d]?.evidence ?? "");
    if (!Number.isFinite(s) || s < 1 || s > 10) return null;
    out[d] = { score: Math.round(s), evidence };
    total += Math.round(s);
    if (s <= 3) anyLow = true;
  }
  const verdict: "pass" | "kill" = total < 30 || anyLow ? "kill" : "pass";
  const pivot = String(parsed?.pivot ?? "").trim();
  return { scores: out, total, verdict, pivot: verdict === "kill" ? pivot : undefined };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return j(401, { error: "Missing or invalid user JWT" });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: uerr } = await userClient.auth.getUser();
  if (uerr || !userData.user) return j(401, { error: "Unauthorized" });
  const userId = userData.user.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return j(400, { error: "Invalid JSON" });
  }
  const intakeId: string | undefined = body?.intake_id;
  if (!intakeId) return j(400, { error: "Missing intake_id" });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Load intake (owner-scoped)
  const { data: intake, error: ierr } = await admin
    .from("intakes")
    .select("id, project_id, user_id, answers")
    .eq("id", intakeId)
    .maybeSingle();
  if (ierr) return j(500, { error: ierr.message });
  if (!intake || intake.user_id !== userId) return j(404, { error: "Intake not found" });

  // OpenRouter key
  const { data: keyRow } = await admin
    .from("api_keys")
    .select("encrypted_key, status")
    .eq("user_id", userId)
    .eq("provider", "openrouter")
    .maybeSingle();
  if (!keyRow) return j(200, { status: "no_key" });
  if (keyRow.status === "invalid") return j(200, { status: "no_key" });

  let apiKey: string;
  try {
    apiKey = await decrypt(keyRow.encrypted_key);
  } catch {
    return j(200, { status: "no_key" });
  }

  // Chair seat + constitution
  const { data: chair } = await admin
    .from("model_registry")
    .select("model_id, role_prompt, enabled")
    .eq("seat", "chair")
    .maybeSingle();
  if (!chair || !chair.enabled) return j(500, { error: "Chair seat not configured" });

  const { data: constRow } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "constitution")
    .maybeSingle();
  const constitution = String((constRow?.value as any)?.text ?? "");

  const { system, user } = buildPrompt(constitution, chair.role_prompt, intake.answers);

  // Call with one retry on parse failure and one retry on 429/5xx.
  let verdict: Verdict | null = null;
  let lastErr: { status: number; body: string } | null = null;
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    const res = await callOpenRouter(apiKey, chair.model_id, system, user);
    if (!res.ok) {
      lastErr = { status: res.status, body: res.body };
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      break;
    }
    verdict = parseVerdict(res.content);
    if (!verdict) {
      lastErr = { status: 200, body: "unparseable" };
    }
  }

  if (!verdict) {
    return j(502, {
      error: "The board couldn't return a clean verdict. Try again in a moment.",
      detail: lastErr,
    });
  }

  const { error: upErr } = await admin
    .from("intakes")
    .update({
      validation_scores: { scores: verdict.scores, total: verdict.total, pivot: verdict.pivot ?? null },
      verdict: verdict.verdict,
    })
    .eq("id", intakeId);
  if (upErr) return j(500, { error: upErr.message });

  if (verdict.verdict === "pass") {
    await admin
      .from("projects")
      .update({ status: "validated" })
      .eq("id", intake.project_id)
      .eq("user_id", userId);
  }

  return j(200, {
    status: "ok",
    verdict: verdict.verdict,
    scores: verdict.scores,
    total: verdict.total,
    pivot: verdict.pivot ?? null,
  });
});
