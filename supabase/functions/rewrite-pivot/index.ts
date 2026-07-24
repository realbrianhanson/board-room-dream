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
const ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function buildPrompt(pivot: string, answers: Record<string, any>) {
  const original = String(answers?.idea ?? "").trim();
  return [
    "You rewrite a board's strategic pivot into a plain-language product description",
    'that fills the "What does the app do, in plain words?" field of an intake form.',
    "",
    "Rules:",
    "- 2 to 3 sentences. No preamble, no quotes, no lists, no markdown.",
    "- Say it like you'd say it to a friend at dinner.",
    "- Describe WHAT the product is and WHO it's for, based on the pivot.",
    "- Do NOT include phrases like 'kill the app', 'flip the bundle', 'pivot',",
    "  competitor names, prices, or strategic reasoning. Just the product, in plain words.",
    "- Return ONLY the rewritten description text. No JSON, no labels.",
    "",
    `ORIGINAL IDEA (for tone/context only):\n${original || "(none)"}`,
    "",
    `BOARD'S PIVOT (strategic language, rewrite this into plain product words):\n${pivot}`,
  ].join("\n");
}

function clean(text: string): string {
  return text
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/^\s*(here(?:'s| is)|rewritten|description)\s*:\s*/i, "")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") {
    return j(200, { status: "ok", version: "2026-07-24.rewrite-pivot.r1" });
  }
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const token = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token || token === ANON_KEY) {
    return j(401, { error: "Missing or invalid user JWT" });
  }

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

  const admin = adminClient();
  const { data: intake, error: ierr } = await admin
    .from("intakes")
    .select("id, project_id, user_id, answers, validation_scores")
    .eq("id", intakeId)
    .maybeSingle();
  if (ierr) return j(500, { error: ierr.message });
  if (!intake || intake.user_id !== userId) {
    return j(404, { error: "Intake not found" });
  }

  const pivot =
    (intake.validation_scores as any)?.pivot ??
    (body?.pivot as string | undefined);
  if (!pivot || typeof pivot !== "string" || !pivot.trim()) {
    return j(400, { error: "No pivot available to rewrite" });
  }

  const prompt = buildPrompt(pivot, intake.answers ?? {});

  try {
    const res = await callSeat(
      userId,
      "chair",
      [{ role: "user", content: prompt }],
      { temperature: 0.4, projectId: intake.project_id, maxTokens: 400 },
    );
    const idea = clean(String(res.content ?? "").trim());
    if (!idea) return j(502, { error: "Empty rewrite" });
    return j(200, { status: "ok", idea });
  } catch (e) {
    if (e instanceof NoUserKey) return j(200, { status: "no_key" });
    if (e instanceof SeatUnavailable) {
      return j(500, { error: (e as Error).message });
    }
    return j(500, { error: (e as Error).message });
  }
});
