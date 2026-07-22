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

import { buildUserPrompt, DIMENSIONS as _DIMS, parseVerdict, type Verdict } from "./prompt.ts";
void _DIMS;


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
        { json: true, temperature: 0.3, projectId: intake.project_id, online: attempt === 0, maxTokens: 3500 },
      );
      verdict = parseVerdict(res.content, intake.answers);
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
