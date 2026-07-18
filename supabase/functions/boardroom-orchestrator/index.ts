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

const SEAT_LABEL: Record<Seat, string> = {
  chair: "The Chair",
  strategist: "The Strategist",
  contrarian: "The Contrarian",
  inspector: "The Inspector",
};

const RUBRIC = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
  "wow_factor",
] as const;

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

function fireSelfTick(body: any = {}) {
  fetch(SELF_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-pipeline-secret": PIPELINE_SECRET },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ============================== Prompt builders ==============================

async function loadIntake(admin: any, projectId: string) {
  const { data } = await admin
    .from("intakes")
    .select("answers, validation_scores")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? { answers: {}, validation_scores: null };
}

function intakeBlock(intake: any) {
  const a = intake?.answers ?? {};
  return `INTAKE ANSWERS
Idea: ${a.idea ?? ""}
Buyer: ${a.buyer ?? ""}
Pain: ${a.pain ?? ""}
Monetization: ${a.money ?? ""}
Inspiration: ${a.inspiration ?? ""}

VALIDATION SCORES
${JSON.stringify(intake?.validation_scores ?? null, null, 2)}`;
}

function draftsBlock(steps: any[], forSeat?: Seat) {
  return SEATS
    .filter((s) => (forSeat ? s !== forSeat : true))
    .map((s) => {
      const step = steps.find((x) => x.step_key === `r1_draft_${s}` && x.status === "completed");
      return `--- ${SEAT_LABEL[s]} (${s}) DRAFT ---\n${step?.response_text ?? "(no draft)"}`;
    })
    .join("\n\n");
}

function objectionsAndStealsBlock(steps: any[]) {
  const parts: string[] = [];
  for (const s of SEATS) {
    const step = steps.find((x) => x.step_key === `r2_exam_${s}` && x.status === "completed");
    if (!step?.response_json) continue;
    const j = step.response_json;
    parts.push(`--- ${SEAT_LABEL[s]} (${s}) — OBJECTIONS AND STEALS ---
${JSON.stringify(j, null, 2)}`);
  }
  return parts.join("\n\n");
}

function priorRoundFailureBlock(steps: any[], previousLoop: number) {
  const votes = SEATS
    .map((s) => steps.find((x) => x.step_key === `r4_vote_${s}_loop${previousLoop}` && x.status === "completed"))
    .filter(Boolean);
  const blocking: string[] = [];
  const lowScores: string[] = [];
  for (const v of votes as any[]) {
    const jj = v.response_json ?? {};
    (jj.blocking_objections ?? []).forEach((b: string) => blocking.push(`- [${v.seat}] ${b}`));
    for (const k of RUBRIC) {
      const n = Number(jj?.scores?.[k]);
      if (Number.isFinite(n) && n < 8) lowScores.push(`- [${v.seat}] ${k}: ${n}`);
    }
  }
  return `PRIOR VOTE FAILED (loop ${previousLoop})

BLOCKING OBJECTIONS STILL STANDING:
${blocking.length ? blocking.join("\n") : "(none)"}

RUBRIC SCORES BELOW 8:
${lowScores.length ? lowScores.join("\n") : "(none)"}

Revise ONLY the contested parts. Preserve agreed parts verbatim.`;
}

// ============================== Step queuing ==============================

async function queueRound1(admin: any, run: any) {
  const intake = await loadIntake(admin, run.project_id);
  const user = `${intakeBlock(intake)}\n\nWrite your Round 1 draft now.`;
  const system =
    "Round 1 of the board's deliberation. You are drafting INDEPENDENTLY — you cannot see the other seats' drafts. Produce your best version of the app plan: concept, target user, core features (MVP-first, ruthlessly cut), the data the app stores, and what you'd cut. Be specific, concise, and opinionated.";
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
}

async function queueRound2(admin: any, run: any, steps: any[]) {
  const intake = await loadIntake(admin, run.project_id);
  const rows = SEATS.map((seat) => {
    const system = `Round 2 — Cross-examination. You are reviewing the OTHER three seats' drafts. "No objections" is not an option. If you cannot find real flaws you are not looking hard enough.

Return ONLY valid JSON matching this shape:
{
  "objections": [ { "target_seat": "chair"|"strategist"|"contrarian"|"inspector", "severity": "blocking"|"major"|"minor", "text": "..." } ],
  "steals": [ { "from_seat": "chair"|"strategist"|"contrarian"|"inspector", "idea": "..." } ]
}

Requirements: at least ONE objection targeting EACH of the three other seats, at least THREE objections total, and at least ONE steal.`;
    const user = `${intakeBlock(intake)}\n\n${draftsBlock(steps, seat)}\n\nProduce your JSON now.`;
    return {
      run_id: run.id,
      user_id: run.user_id,
      step_key: `r2_exam_${seat}`,
      round: 2,
      seat,
      status: "queued",
      request: {
        json_output: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    };
  });
  await admin.from("run_steps").insert(rows);
}

async function queueRound3(admin: any, run: any, steps: any[], loop: number) {
  const intake = await loadIntake(admin, run.project_id);
  const system = `Round 3 — Chair synthesis${loop > 0 ? ` (loop ${loop}, revising after a failed vote)` : ""}. You are the Chair. Weld the four drafts and the objections into ONE candidate plan.

${loop > 0 ? "Revise ONLY the contested parts from the previous vote. Preserve agreed parts verbatim. " : ""}Return ONLY valid JSON matching this shape:
{
  "candidate_md": "Full markdown plan: concept, target user, MVP features, data stored, cuts.",
  "decision_log": [ { "from_seat": "...", "objection": "...", "decision": "accepted"|"rejected", "reason": "..." } ],
  "steals_adopted": [ "..." ]
}`;
  const parts: string[] = [intakeBlock(intake), draftsBlock(steps), objectionsAndStealsBlock(steps)];
  if (loop > 0) parts.push(priorRoundFailureBlock(steps, loop - 1));
  const user = `${parts.join("\n\n")}\n\nProduce your JSON now.`;
  await admin.from("run_steps").insert({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `r3_synthesis_chair_loop${loop}`,
    round: 3,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
}

async function queueRound4(admin: any, run: any, steps: any[], loop: number) {
  const synth = steps.find((x) => x.step_key === `r3_synthesis_chair_loop${loop}` && x.status === "completed");
  const candidateMd = String(synth?.response_json?.candidate_md ?? synth?.response_text ?? "");
  const rows = SEATS.map((seat) => {
    const myR2 = steps.find((x) => x.step_key === `r2_exam_${seat}` && x.status === "completed");
    const myObjections = myR2?.response_json?.objections ?? [];
    const system = `Round 4 — Scored vote${loop > 0 ? ` (loop ${loop})` : ""}. Vote on the candidate plan against your Round-2 objections.

Return ONLY valid JSON matching this shape:
{
  "scores": {
    "painful_problem": 1-10,
    "reachable_buyer": 1-10,
    "monetization_path": 1-10,
    "buildable_scope": 1-10,
    "differentiation": 1-10,
    "wow_factor": 1-10
  },
  "blocking_objections": [ "..." ],
  "comment": "One paragraph."
}

Every score must be an integer 1-10. State which of your own Round-2 objections are RESOLVED by this candidate and which still STAND (add the still-standing ones to blocking_objections if they are dealbreakers).`;
    const user = `CANDIDATE PLAN\n\n${candidateMd}\n\nYOUR ROUND-2 OBJECTIONS\n${JSON.stringify(myObjections, null, 2)}\n\nProduce your JSON now.`;
    return {
      run_id: run.id,
      user_id: run.user_id,
      step_key: `r4_vote_${seat}_loop${loop}`,
      round: 4,
      seat,
      status: "queued",
      request: {
        json_output: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    };
  });
  await admin.from("run_steps").insert(rows);
}

async function queueFinalRuling(admin: any, run: any, steps: any[]) {
  const intake = await loadIntake(admin, run.project_id);
  const allR3 = steps.filter((x) => x.step_key.startsWith("r3_synthesis_chair_loop") && x.status === "completed");
  const lastR3 = allR3[allR3.length - 1];
  const lastLoop = run.loop_no; // by now already incremented to 3
  const previousLoop = Math.max(0, lastLoop - 1);
  const failure = priorRoundFailureBlock(steps, previousLoop);
  const system = `The board has failed to reach consensus after three synthesis loops. You are the Chair — RULE. Accept some outstanding objections, reject others, and produce the final plan. This is a chair-ruled plan, not a consensus plan.

Return ONLY valid JSON matching this shape:
{
  "final_md": "Full markdown plan.",
  "ruling_note": "One paragraph explaining the ruling.",
  "dissent_ledger": [ { "seat": "...", "objection": "...", "chair_response": "..." } ]
}`;
  const user = `${intakeBlock(intake)}\n\nLAST CANDIDATE\n${lastR3?.response_json?.candidate_md ?? ""}\n\n${failure}\n\nProduce your JSON now.`;
  await admin.from("run_steps").insert({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `r_final_ruling_chair`,
    round: 5,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
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
    await queueRound1(admin, run);
    return;
  }
  await admin
    .from("boardroom_runs")
    .update({ status: "paused", consensus: { awaiting: "future_batch" } })
    .eq("id", run.id);
}

// ============================== Validation ==============================

function validateStepJson(stepKey: string, parsed: any): string | null {
  if (!parsed || typeof parsed !== "object") return "Response is not a JSON object.";
  if (stepKey.startsWith("r2_exam_")) {
    const seat = stepKey.replace("r2_exam_", "");
    const objections = parsed.objections;
    const steals = parsed.steals;
    if (!Array.isArray(objections)) return "Missing objections array.";
    if (!Array.isArray(steals)) return "Missing steals array.";
    if (objections.length < 3) return "Need at least 3 objections total.";
    if (steals.length < 1) return "Need at least 1 steal.";
    const others = SEATS.filter((s) => s !== seat);
    for (const other of others) {
      if (!objections.some((o: any) => o?.target_seat === other)) {
        return `Need at least one objection targeting ${other}.`;
      }
    }
    return null;
  }
  if (stepKey.startsWith("r3_synthesis_chair_loop")) {
    if (typeof parsed.candidate_md !== "string" || !parsed.candidate_md.trim()) {
      return "Missing candidate_md string.";
    }
    if (!Array.isArray(parsed.decision_log)) return "Missing decision_log array.";
    return null;
  }
  if (stepKey.startsWith("r4_vote_")) {
    const scores = parsed.scores;
    if (!scores || typeof scores !== "object") return "Missing scores object.";
    for (const k of RUBRIC) {
      const n = scores[k];
      if (!Number.isInteger(n) || n < 1 || n > 10) return `Score ${k} must be an integer 1-10.`;
    }
    if (!Array.isArray(parsed.blocking_objections)) return "Missing blocking_objections array.";
    return null;
  }
  if (stepKey === "r_final_ruling_chair") {
    if (typeof parsed.final_md !== "string" || !parsed.final_md.trim()) return "Missing final_md.";
    if (!Array.isArray(parsed.dissent_ledger)) return "Missing dissent_ledger array.";
    return null;
  }
  return null;
}

// ============================== Step claim / execute ==============================

async function claimOneStep(admin: any, runId: string) {
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
  return claimed;
}

async function executeStep(admin: any, run: any, step: any) {
  const baseMessages = step.request?.messages ?? [];
  const jsonMode = !!step.request?.json_output;

  let networkAttempt = 0;
  while (true) {
    try {
      let messages = [...baseMessages];
      let parsed: any = null;
      let content = "";
      let usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
      let validationAttempt = 0;

      // Structured JSON path: one re-prompt on invalid.
      while (true) {
        const result = await callSeat(run.user_id, step.seat as Seat, messages, {
          runId: run.id,
          projectId: run.project_id,
          temperature: 0.4,
          json: jsonMode,
        });
        content = result.content;
        usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd };
        if (!jsonMode) break;
        let candidate: any;
        try {
          candidate = JSON.parse(content);
        } catch {
          candidate = null;
        }
        const err = candidate ? validateStepJson(step.step_key, candidate) : "Response was not parseable JSON.";
        if (!err) {
          parsed = candidate;
          break;
        }
        if (validationAttempt >= 1) {
          // Give up, store invalid marker but continue the run
          parsed = { invalid: true, raw: content, validation_error: err };
          break;
        }
        validationAttempt++;
        messages = [
          ...messages,
          { role: "assistant", content },
          {
            role: "user",
            content: `Your previous response failed validation: ${err}\nReturn ONLY the required JSON object, no prose, no code fences.`,
          },
        ];
      }

      await admin
        .from("run_steps")
        .update({
          status: "completed",
          response_text: content,
          response_json: parsed,
          tokens_in: usage.tokensIn,
          tokens_out: usage.tokensOut,
          cost_usd: usage.costUsd,
          completed_at: new Date().toISOString(),
        })
        .eq("id", step.id);
      return;
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        await admin.from("run_steps").update({ status: "queued", error: "budget" }).eq("id", step.id);
        await admin.from("boardroom_runs").update({ status: "paused_budget" }).eq("id", run.id);
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
      if (networkAttempt === 0) {
        networkAttempt++;
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      const msg = (e as Error).message ?? String(e);
      await admin
        .from("run_steps")
        .update({ status: "failed", error: msg, completed_at: new Date().toISOString() })
        .eq("id", step.id);
      await admin.from("boardroom_runs").update({ status: "failed", error: msg }).eq("id", run.id);
      return;
    }
  }
}

// ============================== Consensus / locking ==============================

function checkConsensus(voteSteps: any[]): { pass: boolean; scores: any } {
  const scoreSets: Record<string, any> = {};
  let pass = true;
  if (voteSteps.length < 4) return { pass: false, scores: {} };
  for (const v of voteSteps) {
    const j = v.response_json ?? {};
    scoreSets[v.seat] = { scores: j.scores ?? null, blocking_objections: j.blocking_objections ?? [] };
    if (!j.scores) { pass = false; continue; }
    for (const k of RUBRIC) {
      const n = Number(j.scores[k]);
      if (!Number.isFinite(n) || n < 8) pass = false;
    }
    if (Array.isArray(j.blocking_objections) && j.blocking_objections.length > 0) pass = false;
  }
  return { pass, scores: scoreSets };
}

async function lockPlan(
  admin: any,
  run: any,
  steps: any[],
  mode: "consensus" | "chair_ruled",
) {
  const { data: existing } = await admin
    .from("plan_versions")
    .select("version")
    .eq("project_id", run.project_id)
    .eq("kind", "plan")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;

  let contentMd = "";
  let decisionLog: any[] = [];
  let dissentLedger: any = null;
  let isChairRuled = false;

  if (mode === "chair_ruled") {
    const final = steps.find((x) => x.step_key === "r_final_ruling_chair" && x.status === "completed");
    contentMd = String(final?.response_json?.final_md ?? final?.response_text ?? "");
    dissentLedger = final?.response_json?.dissent_ledger ?? null;
    isChairRuled = true;
    // Include ruling note into decision log for provenance
    if (final?.response_json?.ruling_note) {
      decisionLog = [{ from_seat: "chair", decision: "ruled", reason: final.response_json.ruling_note }];
    }
  } else {
    // Consensus: use latest r3 candidate_md and merge decision logs from all loops
    const allR3 = steps
      .filter((x) => x.step_key.startsWith("r3_synthesis_chair_loop") && x.status === "completed")
      .sort((a, b) => a.step_key.localeCompare(b.step_key));
    const lastR3 = allR3[allR3.length - 1];
    contentMd = String(lastR3?.response_json?.candidate_md ?? lastR3?.response_text ?? "");
    for (const r3 of allR3) {
      const dl = r3?.response_json?.decision_log;
      if (Array.isArray(dl)) decisionLog.push(...dl);
    }
  }

  const voteSteps = steps.filter((x) => x.step_key.startsWith("r4_vote_") && x.status === "completed");
  const latestLoop = Math.max(-1, ...voteSteps.map((v: any) => {
    const m = /_loop(\d+)$/.exec(v.step_key);
    return m ? Number(m[1]) : -1;
  }));
  const latestVotes = voteSteps.filter((v: any) => v.step_key.endsWith(`_loop${latestLoop}`));
  const { scores } = checkConsensus(latestVotes);

  await admin.from("plan_versions").insert({
    project_id: run.project_id,
    user_id: run.user_id,
    kind: "plan",
    version: nextVersion,
    content_md: contentMd,
    decision_log: decisionLog,
    dissent_ledger: dissentLedger,
    is_chair_ruled: isChairRuled,
    source_run_id: run.id,
  });

  await admin
    .from("boardroom_runs")
    .update({
      status: mode,
      consensus: scores,
      dissent_ledger: dissentLedger,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  await admin
    .from("projects")
    .update({ status: "locked" })
    .eq("id", run.project_id);
}

// ============================== Round advancement ==============================

async function loadAllSteps(admin: any, runId: string) {
  const { data } = await admin
    .from("run_steps")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function getRun(admin: any, runId: string) {
  const { data } = await admin.from("boardroom_runs").select("*").eq("id", runId).maybeSingle();
  return data;
}

async function afterStepComplete(admin: any, runIn: any) {
  const run = await getRun(admin, runIn.id);
  if (!run) return;
  const steps = await loadAllSteps(admin, run.id);
  const active = steps.some((s: any) => s.status === "queued" || s.status === "running");
  if (active) {
    fireSelfTick();
    return;
  }

  if (run.kind === "test") {
    await admin
      .from("boardroom_runs")
      .update({ status: "consensus", consensus: { test: true }, updated_at: new Date().toISOString() })
      .eq("id", run.id);
    return;
  }

  if (run.kind !== "plan") {
    await admin
      .from("boardroom_runs")
      .update({ status: "paused", consensus: { awaiting: "future_batch" } })
      .eq("id", run.id);
    return;
  }

  const round = run.round_no;
  const loop = run.loop_no;

  if (round === 1) {
    await queueRound2(admin, run, steps);
    await admin
      .from("boardroom_runs")
      .update({ round_no: 2, updated_at: new Date().toISOString() })
      .eq("id", run.id);
    fireSelfTick();
    return;
  }

  if (round === 2) {
    await queueRound3(admin, run, steps, loop);
    await admin
      .from("boardroom_runs")
      .update({ round_no: 3, updated_at: new Date().toISOString() })
      .eq("id", run.id);
    fireSelfTick();
    return;
  }

  if (round === 3) {
    await queueRound4(admin, run, steps, loop);
    await admin
      .from("boardroom_runs")
      .update({ round_no: 4, updated_at: new Date().toISOString() })
      .eq("id", run.id);
    fireSelfTick();
    return;
  }

  if (round === 4) {
    const votes = steps.filter(
      (x: any) => x.step_key.startsWith("r4_vote_") && x.step_key.endsWith(`_loop${loop}`) && x.status === "completed",
    );
    const { pass } = checkConsensus(votes);
    if (pass) {
      await lockPlan(admin, run, steps, "consensus");
      return;
    }
    const nextLoop = loop + 1;
    if (nextLoop < 3) {
      await queueRound3(admin, run, steps, nextLoop);
      await admin
        .from("boardroom_runs")
        .update({ round_no: 3, loop_no: nextLoop, updated_at: new Date().toISOString() })
        .eq("id", run.id);
      fireSelfTick();
      return;
    }
    // Final ruling
    await admin
      .from("boardroom_runs")
      .update({ round_no: 5, loop_no: nextLoop, updated_at: new Date().toISOString() })
      .eq("id", run.id);
    const refreshed = await getRun(admin, run.id);
    await queueFinalRuling(admin, refreshed, steps);
    fireSelfTick();
    return;
  }

  if (round === 5) {
    await lockPlan(admin, run, steps, "chair_ruled");
    return;
  }
}

// ============================== Run processing ==============================

async function processRun(admin: any, runId: string) {
  const run = await getRun(admin, runId);
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
  const freshRun = await getRun(admin, runId);
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

// ============================== HTTP ==============================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const admin = adminClient();
  const pipelineHeader = req.headers.get("x-pipeline-secret");

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

    if (kind === "plan") {
      await admin.from("projects").update({ status: "boardroom" }).eq("id", projectId);
    }

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
    fireSelfTick();
    return j(200, { ok: true });
  }

  if (action === "retry_step") {
    const runId: string = body?.run_id;
    const stepId: string = body?.step_id;
    if (!runId || !stepId) return j(400, { error: "Missing run_id or step_id" });
    const { data: run } = await admin
      .from("boardroom_runs")
      .select("id, user_id, status")
      .eq("id", runId)
      .maybeSingle();
    if (!run || run.user_id !== userId) return j(404, { error: "Run not found" });
    const { data: step } = await admin
      .from("run_steps")
      .select("id, status")
      .eq("id", stepId)
      .eq("run_id", runId)
      .maybeSingle();
    if (!step) return j(404, { error: "Step not found" });
    if (step.status !== "failed") return j(400, { error: "Only failed steps can be retried" });
    await admin
      .from("run_steps")
      .update({ status: "queued", error: null, completed_at: null })
      .eq("id", stepId);
    if (run.status === "failed") {
      await admin.from("boardroom_runs").update({ status: "running", error: null }).eq("id", runId);
    }
    fireSelfTick();
    return j(200, { ok: true });
  }

  return j(400, { error: "Unknown action" });
});
