// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  adminClient,
  callSeat,
  NoUserKey,
  SeatUnavailable,
} from "../_shared/openrouter-proxy.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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

function buildUserPrompt(answers: any) {
  return `You will score a founder's app intake on five dimensions from 1 to 10. Return ONLY strict JSON:\n{\n  "scores": {\n    "painful_problem": {"score": 1-10, "evidence": "one sentence"},\n    "reachable_buyer": {"score": 1-10, "evidence": "one sentence"},\n    "monetization_path": {"score": 1-10, "evidence": "one sentence"},\n    "buildable_scope": {"score": 1-10, "evidence": "one sentence"},\n    "differentiation": {"score": 1-10, "evidence": "one sentence"}\n  },\n  "pivot": "one sentence — only if verdict is kill, else empty string"\n}\n\nINTAKE ANSWERS\n1. Idea: ${answers?.idea ?? ""}\n2. Buyer: ${answers?.buyer ?? ""}\n3. Pain: ${answers?.pain ?? ""}\n4. Money: ${answers?.money ?? ""}\n5. Inspiration: ${answers?.inspiration ?? ""}\n\nScore honestly. Kill weak ideas fast. If web search results are available, ground your evidence in real competitors and real demand signals — name them in the evidence sentences.`;
}

function parseVerdict(content: string): Verdict | null {
  let parsed: any;
  try { parsed = JSON.parse(content); } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
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
  try { body = await req.json(); } catch { return j(400, { error: "Invalid JSON" }); }
  const intakeId: string | undefined = body?.intake_id;
  if (!intakeId) return j(400, { error: "Missing intake_id" });

  const admin = adminClient();
  const { data: intake, error: ierr } = await admin
    .from("intakes")
    .select("id, project_id, user_id, answers")
    .eq("id", intakeId)
    .maybeSingle();
  if (ierr) return j(500, { error: ierr.message });
  if (!intake || intake.user_id !== userId) return j(404, { error: "Intake not found" });

  const userPrompt = buildUserPrompt(intake.answers);

  let verdict: Verdict | null = null;
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    try {
      const res = await callSeat(
        userId,
        "chair",
        [{ role: "user", content: userPrompt }],
        // First attempt grounds the verdict in live web search; the retry
        // drops the plugin so a search hiccup never blocks validation.
        { json: true, temperature: 0.3, projectId: intake.project_id, online: attempt === 0 },
      );
      verdict = parseVerdict(res.content);
      if (!verdict) lastErr = { status: 200, body: "unparseable" };
    } catch (e) {
      if (e instanceof NoUserKey) return j(200, { status: "no_key" });
      if (e instanceof SeatUnavailable) return j(500, { error: (e as Error).message });
      const status = (e as any).status ?? 500;
      lastErr = { status, body: (e as Error).message };
      if (attempt === 0 || status === 429 || status >= 500) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      break;
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
