// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  adminClient,
  BudgetExceeded,
  callSeat,
  NoUserKey,
  SeatUnavailable,
} from "../_shared/openrouter-proxy.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-pipeline-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const PIPELINE_SECRET = Deno.env.get("PIPELINE_SECRET")!;
const SELF_URL = `${SUPABASE_URL}/functions/v1/boardroom-orchestrator`;

const SEATS = ["chair", "strategist", "contrarian", "inspector"] as const;
type Seat = typeof SEATS[number];

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function verifyUser(token: string): Promise<string | null> {
  if (!token || token === ANON_KEY) return null;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

function fireSelfTick() {
  // fire-and-forget chain the pipeline
  fetch(SELF_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-pipeline-secret": PIPELINE_SECRET },
    body: JSON.stringify({}),
  }).catch(() => {});
}

async function buildRound1Prompt(admin: any, run: any): Promise<{ system: string; user: string }> {
  const { data: intake } = await admin
    .from("intakes")
    .select("answers, validation_scores")
    .eq("project_id", run.project_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const answers = intake?.answers ?? {};
  const scores = intake?.validation_scores ?? null;
  const system =
    "Round 1 of the board's deliberation. You are drafting INDEPENDENTLY — you cannot see the other seats' drafts. Produce your best version of the app plan: concept, target user, core features (MVP-first, ruthlessly cut), the data the app stores, and what you'd cut. Be specific, concise, and opinionated.";
  const user = `INTAKE ANSWERS\nIdea: ${answers.idea ?? ""}\nBuyer: ${answers.buyer ?? ""}\nPain: ${answers.pain ?? ""}\nMonetization: ${answers.money ?? ""}\nInspiration: ${answers.inspiration ?? ""}\n\nVALIDATION SCORES\n${JSON.stringify(scores, null, 2)}\n\nWrite your Round 1 draft now.`;
  return { system, user };
}

async function createInitialSteps(admin: any, run: any) {
  if (run.kind === "test") {
    await admin.from("run_steps").insert({
      run_id: run.id,
      user_id: run.user_id,
      step_key: "r1_test_chair",
      round: 1,
      seat: "chair",
      status: "queued",
      request: {
        messages: [
          { role: "user", content: "Reply with exactly one sentence confirming the pipeline is live." },
        ],
      },
    });
    return;
  }
  if (run.kind === "plan") {
    const { system, user } = await buildRound1Prompt(admin, run);
    const rows = SEATS.map((seat) => ({
      run_id: run.id,
      user_id: run.user_id,
      step_key: `r1_draft_${seat}`,
      round: 1,
      seat,
      status: "queued",
      request: {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    }));
    await admin.from("run_steps").insert(rows);
    return;
  }
  // Other kinds arrive in later batches
  await admin
    .from("boardroom_runs")
    .update({ status: "paused", consensus: { awaiting: "batch6_protocol" } })
    .eq("id", run.id);
}

async function claimOneStep(admin: any, runId: string) {
  // Atomic claim: pick a queued step, flip to running, return it. Idempotent by UNIQUE(run_id,step_key).
  const { data: candidate } = await admin
    .from("run_steps")
    .select("id")
    .eq("run_id", runId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) return null;
  const { data: claimed } = await admin
    .from("run_steps")
    .update({ status: "running" })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
  return claimed; // null if lost the race
}

async function executeStep(admin: any, run: any, step: any) {
  const messages = step.request?.messages ?? [];
  const opts = { runId: run.id, projectId: run.project_id, temperature: 0.4 };
  let attempt = 0;
  // one retry
  while (true) {
    try {
      const result = await callSeat(run.user_id, step.seat as Seat, messages, opts);
      await admin
        .from("run_steps")
        .update({
          status: "completed",
          response_text: result.content,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          cost_usd: result.costUsd,
          completed_at: new Date().toISOString(),
        })
        .eq("id", step.id);
      return;
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        await admin
          .from("run_steps")
          .update({ status: "queued", error: "budget" })
          .eq("id", step.id);
        await admin
          .from("boardroom_runs")
          .update({ status: "paused_budget" })
          .eq("id", run.id);
        return;
      }
      if (e instanceof NoUserKey || e instanceof SeatUnavailable) {
        await admin
          .from("run_steps")
          .update({ status: "failed", error: (e as Error).message, completed_at: new Date().toISOString() })
          .eq("id", step.id);
        await admin
          .from("boardroom_runs")
          .update({ status: "failed", error: (e as Error).message })
          .eq("id", run.id);
        return;
      }
      if (attempt === 0) {
        attempt++;
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      const msg = (e as Error).message ?? String(e);
      await admin
        .from("run_steps")
        .update({ status: "failed", error: msg, completed_at: new Date().toISOString() })
        .eq("id", step.id);
      await admin
        .from("boardroom_runs")
        .update({ status: "failed", error: msg })
        .eq("id", run.id);
      return;
    }
  }
}

async function afterStepComplete(admin: any, run: any) {
  const { count: queuedCount } = await admin
    .from("run_steps")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run.id)
    .eq("status", "queued");
  const { count: runningCount } = await admin
    .from("run_steps")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run.id)
    .eq("status", "running");
  if ((queuedCount ?? 0) > 0) {
    fireSelfTick();
    return;
  }
  if ((runningCount ?? 0) > 0) return;
  // All Round 1 steps complete → hand off
  await admin
    .from("boardroom_runs")
    .update({ status: "paused", consensus: { awaiting: "batch6_protocol" } })
    .eq("id", run.id);
}

async function processRun(admin: any, runId: string) {
  const { data: run } = await admin
    .from("boardroom_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (!run) return;
  if (!["queued", "running"].includes(run.status)) return;
  if (run.status === "queued") {
    await admin.from("boardroom_runs").update({ status: "running" }).eq("id", runId);
  }
  const step = await claimOneStep(admin, runId);
  if (!step) {
    await afterStepComplete(admin, run);
    return;
  }
  await executeStep(admin, run, step);
  const { data: freshRun } = await admin
    .from("boardroom_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (freshRun && freshRun.status === "running") {
    await afterStepComplete(admin, freshRun);
  }
}

async function pipelineTick(admin: any) {
  const { data: runs } = await admin
    .from("boardroom_runs")
    .select("id")
    .in("status", ["queued", "running"])
    .limit(20);
  for (const r of runs ?? []) {
    await processRun(admin, r.id);
  }
  return { processed: (runs ?? []).length };
}

// ================================== HTTP ==================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const admin = adminClient();
  const pipelineHeader = req.headers.get("x-pipeline-secret");

  // Pipeline path (cron / self-chain)
  if (pipelineHeader && PIPELINE_SECRET && pipelineHeader === PIPELINE_SECRET) {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty */ }
    if (body?.run_id) {
      await processRun(admin, String(body.run_id));
      return j(200, { ok: true });
    }
    const res = await pipelineTick(admin);
    return j(200, res);
  }

  // User path
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = await verifyUser(token);
  if (!userId) return j(401, { error: "Missing or invalid user JWT" });

  let body: any;
  try { body = await req.json(); } catch { return j(400, { error: "Invalid JSON" }); }
  const action: string = body?.action;

  if (action === "start_run") {
    const projectId: string = body?.project_id;
    const kind: string = body?.kind;
    if (!projectId || !kind) return j(400, { error: "Missing project_id or kind" });
    if (!["test", "plan", "features", "design", "change_request", "audit"].includes(kind)) {
      return j(400, { error: "Invalid kind" });
    }
    const { data: project } = await admin
      .from("projects")
      .select("id, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (!project || project.user_id !== userId) return j(404, { error: "Project not found" });

    // Constitution version
    const { data: constRow } = await admin
      .from("app_settings")
      .select("version")
      .eq("key", "constitution")
      .maybeSingle();

    const budget = kind === "test" ? 0.25 : 10.0;
    const { data: run, error: rerr } = await admin
      .from("boardroom_runs")
      .insert({
        project_id: projectId,
        user_id: userId,
        kind,
        status: "queued",
        round_no: 1,
        loop_no: 0,
        constitution_version: constRow?.version ?? 1,
        budget_usd: budget,
      })
      .select("*")
      .single();
    if (rerr || !run) return j(500, { error: rerr?.message ?? "Failed to create run" });

    await createInitialSteps(admin, run);
    fireSelfTick();
    return j(200, { run_id: run.id, status: "queued" });
  }

  if (action === "advance" || action === "pause" || action === "resume") {
    const runId: string = body?.run_id;
    if (!runId) return j(400, { error: "Missing run_id" });
    const { data: run } = await admin
      .from("boardroom_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();
    if (!run || run.user_id !== userId) return j(404, { error: "Run not found" });

    if (action === "pause") {
      await admin.from("boardroom_runs").update({ status: "paused" }).eq("id", runId);
      return j(200, { ok: true });
    }
    if (action === "resume") {
      const extra = Number(body?.extra_budget_usd ?? 0);
      const patch: any = { status: "queued" };
      if (extra > 0) patch.budget_usd = Number(run.budget_usd) + extra;
      await admin.from("boardroom_runs").update(patch).eq("id", runId);
      fireSelfTick();
      return j(200, { ok: true });
    }
    // advance
    fireSelfTick();
    return j(200, { ok: true });
  }

  return j(400, { error: "Unknown action" });
});
