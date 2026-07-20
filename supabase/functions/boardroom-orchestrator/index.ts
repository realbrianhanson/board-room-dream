// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import {
  adminClient,
  BudgetExceeded,
  DailyCapExceeded,
  callSeat,
  NoUserKey,
  SeatBudgetExceeded,
  SeatUnavailable,
} from "../_shared/openrouter-proxy.ts";

import {
  SEATS,
  type Seat,
  candidateForLoop,
  lastCandidateLoop,
  checkConsensus,
  resolveConsensusThreshold,
  validateStepJson,
} from "./protocol.ts";
import {
  createInitialSteps,
  loadIntake,
  loadLockedPlan,
  queueAuditChairMerge,
  queueBatchesReview,
  queueBatchesRevise,
  queueBlueprint,
  queueBlueprintExtract,
  queueChangeRequestReview,
  queueChangeRequestRevise,
  queueChangeRequestVerdict,
  queueFinalRuling,
  queueRound2,
  queueRound3,
  queueRound3Extract,
  queueRound4,
} from "./queues.ts";


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

// How many seat steps run concurrently per invocation. Board rounds queue 3-4
// steps and map-reduce audits up to 12; capping the fan-out keeps peak DB +
// OpenRouter pressure gentle so a run can't tip a loaded instance over. The
// rest process on the next self-tick. Tunable without a redeploy via the
// MAX_STEP_CONCURRENCY secret; clamped to a sane 1-8.
const MAX_STEP_CONCURRENCY = Math.min(8, Math.max(1, Number(Deno.env.get("MAX_STEP_CONCURRENCY") ?? 3)));


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
  // Register the background kick with EdgeRuntime.waitUntil so the platform
  // keeps the isolate alive to dispatch it. A bare un-awaited fetch is dropped
  // the instant the handler returns its Response — which silently breaks the
  // self-chain and stalls the run until the once-a-minute cron happens to
  // rescue it (or forever, if the cron is also overwhelmed).
  const p = fetch(SELF_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-pipeline-secret": PIPELINE_SECRET },
    body: JSON.stringify(body),
  }).catch(() => {});
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* not on Edge runtime */ }
}


// Idempotent alert insert: skip if there's an OPEN alert for (project, kind).
async function insertAlert(
  admin: any,
  args: { user_id: string; project_id: string; kind: "stuck_48h" | "audit_loop" | "spend_cap" | "never_locked"; detail?: any },
) {
  try {
    const { data: proj } = await admin
      .from("profiles")
      .select("cohort_id")
      .eq("id", args.user_id)
      .maybeSingle();
    const cohort_id = proj?.cohort_id ?? null;
    const { data: existing } = await admin
      .from("alerts")
      .select("id")
      .eq("project_id", args.project_id)
      .eq("kind", args.kind)
      .eq("status", "open")
      .limit(1);
    if ((existing ?? []).length) return;
    await admin.from("alerts").insert({
      cohort_id,
      user_id: args.user_id,
      project_id: args.project_id,
      kind: args.kind,
      detail: args.detail ?? null,
    });
  } catch (_e) { /* alerts must never break the run */ }
}


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
    .update({ status: "running", started_at: new Date().toISOString() })
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
      let fallbackMeta: any = null;
      let validationAttempt = 0;

      // Structured JSON path: one re-prompt on invalid.
      while (true) {
        const result = await callSeat(run.user_id, step.seat as Seat, messages, {
          runId: run.id,
          projectId: run.project_id,
          temperature: Number(step.request?.temperature ?? 0.4),
          reasoningEffort: step.request?.reasoning_effort,
          json: jsonMode,
        });
        content = result.content;
        usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd };
        if (result.fallback) fallbackMeta = result.fallback;
        if (!jsonMode) break;
        let candidate: any;
        try {
          candidate = JSON.parse(content);
        } catch {
          candidate = null;
        }
        const err = candidate ? validateStepJson(step.step_key, candidate, run.kind) : "Response was not parseable JSON.";
        if (!err) {
          parsed = candidate;
          break;
        }
        if (validationAttempt >= 1) {
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

      if (fallbackMeta) {
        if (!parsed || typeof parsed !== "object") parsed = {};
        parsed._meta = { ...(parsed._meta ?? {}), fallback: fallbackMeta };
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
      if (e instanceof DailyCapExceeded) {
        await admin.from("run_steps").update({ status: "queued", error: "daily_cap" }).eq("id", step.id);
        await admin.from("boardroom_runs").update({ status: "paused_budget" }).eq("id", run.id);
        if (run.project_id && run.user_id) {
          await insertAlert(admin, {
            user_id: run.user_id,
            project_id: run.project_id,
            kind: "spend_cap",
            detail: { scope: "daily", cap_usd: e.cap, spent_usd: e.spent, source: e.scope },
          });
        }
        return;
      }
      if (e instanceof BudgetExceeded) {
        await admin.from("run_steps").update({ status: "queued", error: "budget" }).eq("id", step.id);
        await admin.from("boardroom_runs").update({ status: "paused_budget" }).eq("id", run.id);
        if (run.project_id && run.user_id) {
          await insertAlert(admin, {
            user_id: run.user_id,
            project_id: run.project_id,
            kind: "spend_cap",
            detail: { scope: "run", run_kind: run.kind, spent_usd: Number(run.spent_usd ?? 0), budget_usd: Number(run.budget_usd ?? 0) },
          });
        }
        return;
      }
      if (e instanceof SeatBudgetExceeded) {
        // One seat hit its per-run cap — pause the run (the owner can raise the
        // seat's cap in Settings and resume), same UX as the run budget.
        await admin.from("run_steps").update({ status: "queued", error: "seat_budget" }).eq("id", step.id);
        await admin.from("boardroom_runs").update({ status: "paused_budget" }).eq("id", run.id);
        if (run.project_id && run.user_id) {
          await insertAlert(admin, {
            user_id: run.user_id,
            project_id: run.project_id,
            kind: "spend_cap",
            detail: { scope: "seat", seat: e.seat, cap_usd: e.cap, spent_usd: e.spent },
          });
        }
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


async function lockPlanAndQueueBlueprint(
  admin: any,
  run: any,
  steps: any[],
  mode: "consensus" | "chair_ruled",
) {
  const planKind = run.kind === "design" ? "design" : "plan";
  const { data: existing } = await admin
    .from("plan_versions")
    .select("version")
    .eq("project_id", run.project_id)
    .eq("kind", planKind)
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
    if (final?.response_json?.ruling_note) {
      decisionLog = [{ from_seat: "chair", decision: "ruled", reason: final.response_json.ruling_note }];
    }
  } else {
    contentMd = candidateForLoop(steps, lastCandidateLoop(steps));
    // Decision logs live in the extract steps (two-phase) or legacy synthesis JSON.
    const logSteps = steps
      .filter((x) => (x.step_key.startsWith("r3_extract_chair_loop") || x.step_key.startsWith("r3_synthesis_chair_loop")) && x.status === "completed")
      .sort((a, b) => a.step_key.localeCompare(b.step_key));
    for (const s of logSteps) {
      const dl = s?.response_json?.decision_log;
      if (Array.isArray(dl)) decisionLog.push(...dl);
    }
  }

  const voteSteps = steps.filter((x) => x.step_key.startsWith("r4_vote_") && x.status === "completed");
  const latestLoop = Math.max(-1, ...voteSteps.map((v: any) => {
    const m = /_loop(\d+)$/.exec(v.step_key);
    return m ? Number(m[1]) : -1;
  }));
  const latestVotes = voteSteps.filter((v: any) => v.step_key.endsWith(`_loop${latestLoop}`));
  const { scores } = checkConsensus(latestVotes, run.kind);

  const { data: inserted } = await admin
    .from("plan_versions")
    .insert({
      project_id: run.project_id,
      user_id: run.user_id,
      kind: planKind,
      version: nextVersion,
      content_md: contentMd,
      decision_log: decisionLog,
      dissent_ledger: dissentLedger,
      is_chair_ruled: isChairRuled,
      source_run_id: run.id,
    })
    .select("id")
    .single();

  if (run.kind === "design") {
    // Design runs skip the blueprint step — the candidate IS the deliverable.
    // Project status is left untouched by design runs.
    const finalStatus = mode === "chair_ruled" ? "chair_ruled" : "consensus";
    await admin
      .from("boardroom_runs")
      .update({
        status: finalStatus,
        consensus: { scores, plan_version_id: inserted?.id ?? null },
        dissent_ledger: dissentLedger,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return;
  }

  await admin.from("projects").update({ status: "locked" }).eq("id", run.project_id);

  // Stash pending finalization on run.consensus so blueprint completion can finalize.
  await admin
    .from("boardroom_runs")
    .update({
      round_no: 6,
      consensus: {
        pending_final_status: mode,
        scores,
        plan_version_id: inserted?.id ?? null,
      },
      dissent_ledger: dissentLedger,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  const intake = await loadIntake(admin, run.project_id);
  const refreshed = await getRun(admin, run.id);
  await queueBlueprint(admin, refreshed, contentMd, intake);
}


async function finalizeBlueprint(admin: any, run: any, steps: any[]) {
  const bp = steps.find((x) => x.step_key === "r5_blueprint_chair" && x.status === "completed");
  const extract = steps.find((x) => x.step_key === "r5_blueprint_extract_chair" && x.status === "completed");
  const meta = run.consensus ?? {};
  const finalStatus = meta.pending_final_status === "chair_ruled" ? "chair_ruled" : "consensus";
  const planVersionId = meta.plan_version_id;
  // Two-phase: PRD is the draft's raw markdown, features come from the
  // extract step. Legacy single-phase JSON runs still finalize correctly.
  const prdMd = String(bp?.response_json?.prd_md ?? bp?.response_text ?? "");
  const features = Array.isArray(extract?.response_json?.features)
    ? extract!.response_json.features
    : Array.isArray(bp?.response_json?.features) ? bp!.response_json.features : [];
  if (planVersionId && prdMd) {
    await admin
      .from("plan_versions")
      .update({ prd_md: prdMd, features })
      .eq("id", planVersionId);
  }
  await admin
    .from("boardroom_runs")
    .update({
      status: finalStatus,
      consensus: meta.scores ?? {},
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);
}


async function finalizeChangeRequest(admin: any, run: any, steps: any[]) {
  const crId = run.consensus?.change_request_id;
  const verdictStep = steps.find((x) => x.step_key === "cr_verdict_chair" && x.status === "completed");
  // If the Inspector sent the amendment back and the Chair produced a valid
  // revision, the revision is the document of record.
  const reviseStep = steps.find((x) => x.step_key === "cr_revise_chair" && x.status === "completed");
  const chosen = reviseStep?.response_json && !reviseStep.response_json.invalid ? reviseStep : verdictStep;
  const v = chosen?.response_json ?? {};
  const verdict = v.verdict === "approved" ? "approved" : "rejected";
  let newVersionId: string | null = null;
  if (verdict === "approved" && crId) {
    const { data: existing } = await admin
      .from("plan_versions")
      .select("version")
      .eq("project_id", run.project_id)
      .eq("kind", "plan")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (existing?.version ?? 0) + 1;
    const { data: inserted } = await admin
      .from("plan_versions")
      .insert({
        project_id: run.project_id,
        user_id: run.user_id,
        kind: "plan",
        version: nextVersion,
        content_md: String(v.amended_plan_md ?? ""),
        prd_md: String(v.amended_prd_md ?? ""),
        features: Array.isArray(v.amended_features) ? v.amended_features : [],
        decision_log: [{ change_request_id: crId, rationale: v.rationale ?? "" }],
        source_run_id: run.id,
      })
      .select("id")
      .single();
    newVersionId = inserted?.id ?? null;
  }
  if (crId) {
    await admin
      .from("change_requests")
      .update({
        status: verdict,
        board_verdict: { ...v, new_plan_version_id: newVersionId },
        run_id: run.id,
      })
      .eq("id", crId);
  }
  await admin
    .from("boardroom_runs")
    .update({
      status: "consensus",
      consensus: { ...(run.consensus ?? {}), verdict, new_plan_version_id: newVersionId },
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);
}


// ============================== Round advancement ==============================

async function finalizeBatches(admin: any, run: any, batchesJson: any[]) {
  const { data: plan } = await admin
    .from("plan_versions")
    .select("id")
    .eq("project_id", run.project_id)
    .eq("kind", "plan")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rows = batchesJson.map((b: any) => ({
    project_id: run.project_id,
    user_id: run.user_id,
    plan_version_id: plan?.id ?? null,
    batch_no: Number(b.batch_no),
    title: String(b.title),
    channel: String(b.channel),
    prompt_md: String(b.prompt_md),
    status: "pending",
    is_fix: false,
  }));
  const { error: insErr } = await admin.from("batches").insert(rows);
  if (insErr) {
    await admin
      .from("boardroom_runs")
      .update({ status: "failed", error: `Failed to insert batches: ${insErr.message}` })
      .eq("id", run.id);
    return;
  }
  await admin.from("projects").update({ status: "building", current_batch_no: 1 }).eq("id", run.project_id);
  await admin
    .from("boardroom_runs")
    .update({ status: "completed", consensus: { batches_inserted: rows.length }, updated_at: new Date().toISOString() })
    .eq("id", run.id);
}


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


async function finalizeAudit(admin: any, run: any, steps: any[]) {
  const chair = steps.find((x: any) => x.step_key === "audit_chair_merge");
  const parsed = chair?.response_json ?? {};
  const auditId: string | undefined = run.consensus?.audit_id;
  if (!auditId) {
    await admin.from("boardroom_runs").update({ status: "failed", error: "audit_id missing" }).eq("id", run.id);
    return;
  }
  const { data: audit } = await admin.from("audits").select("*").eq("id", auditId).maybeSingle();
  if (!audit) {
    await admin.from("boardroom_runs").update({ status: "failed", error: "audit row missing" }).eq("id", run.id);
    return;
  }

  const verdict = parsed?.verdict === "clean" ? "clean" : "findings";
  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const findings = rawFindings.filter((f: any) => f && typeof f.title === "string" && f.title.trim());

  const filesAnalyzed = Number(run.consensus?.files_analyzed ?? 0) || null;

  const summary = {
    verdict,
    text: String(parsed?.summary ?? ""),
    counts: {
      P0: findings.filter((f: any) => f.severity === "P0").length,
      P1: findings.filter((f: any) => f.severity === "P1").length,
      P2: findings.filter((f: any) => f.severity === "P2").length,
      P3: findings.filter((f: any) => f.severity === "P3").length,
    },
  };

  const isFinal = audit.kind === "final_az";

  if (verdict === "clean") {
    // Resolve any prior open findings for this batch.
    if (audit.batch_id) {
      await admin
        .from("audit_findings")
        .update({ status: "resolved" })
        .eq("user_id", audit.user_id)
        .in("status", ["open", "fix_drafted"])
        .in("audit_id", (
          await admin.from("audits").select("id").eq("batch_id", audit.batch_id)
        ).data?.map((r: any) => r.id) ?? []);
    }
    await admin
      .from("audits")
      .update({ status: "clean", summary, files_analyzed: filesAnalyzed, completed_at: new Date().toISOString() })
      .eq("id", auditId);
    if (audit.batch_id) {
      await admin.from("batches").update({ status: "passed" }).eq("id", audit.batch_id);
      // If this batch is a fix, also pass the parent.
      const { data: fixBatch } = await admin
        .from("batches")
        .select("parent_batch_id")
        .eq("id", audit.batch_id)
        .maybeSingle();
      if (fixBatch?.parent_batch_id) {
        await admin.from("batches").update({ status: "passed" }).eq("id", fixBatch.parent_batch_id);
        // Resolve prior open findings on the parent's audits too.
        const { data: parentAudits } = await admin
          .from("audits")
          .select("id")
          .eq("batch_id", fixBatch.parent_batch_id);
        const parentIds = (parentAudits ?? []).map((r: any) => r.id);
        if (parentIds.length) {
          await admin
            .from("audit_findings")
            .update({ status: "resolved" })
            .in("audit_id", parentIds)
            .in("status", ["open", "fix_drafted"]);
        }
      }
    }

    if (isFinal) {
      // Append a final human QA batch to the runway.
      const qa = String(parsed?.final_qa_prompt_md ?? "").trim();
      if (qa) {
        const { data: last } = await admin
          .from("batches")
          .select("batch_no")
          .eq("project_id", audit.project_id)
          .order("batch_no", { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextNo = Math.floor(Number(last?.batch_no ?? 0)) + 1;
        await admin.from("batches").insert({
          project_id: audit.project_id,
          user_id: audit.user_id,
          batch_no: nextNo,
          title: "Final A-Z QA",
          channel: "lovable",
          prompt_md: qa,
          status: "pending",
        });
      }
      // Imports continue into improvement work — do NOT mark 'done'.
      const { data: proj } = await admin
        .from("projects")
        .select("is_import")
        .eq("id", audit.project_id)
        .maybeSingle();
      if (!proj?.is_import) {
        await admin.from("projects").update({ status: "done" }).eq("id", audit.project_id);
      }
    }

    await admin
      .from("boardroom_runs")
      .update({ status: "consensus", consensus: { ...(run.consensus ?? {}), verdict: "clean" } })
      .eq("id", run.id);
    return;
  }

  // Findings path.
  await admin
    .from("audits")
    .update({ status: "findings", summary, files_analyzed: filesAnalyzed, completed_at: new Date().toISOString() })
    .eq("id", auditId);

  let fixBatchId: string | null = null;
  const fixPrompt = String(parsed?.fix_prompt_md ?? "").trim();
  const hasSerious = findings.some((f: any) => ["P0", "P1", "P2"].includes(f.severity));

  if (!isFinal && audit.batch_id && hasSerious && fixPrompt) {
    const { data: parent } = await admin
      .from("batches")
      .select("batch_no, title")
      .eq("id", audit.batch_id)
      .maybeSingle();
    if (parent) {
      const parentNo = Math.floor(Number(parent.batch_no));
      const fixNo = Number((parentNo + 0.1 * Number(audit.loop_no ?? 1)).toFixed(2));
      const { data: inserted } = await admin
        .from("batches")
        .insert({
          project_id: audit.project_id,
          user_id: audit.user_id,
          batch_no: fixNo,
          title: `Fix — ${parent.title}`,
          channel: "lovable",
          prompt_md: fixPrompt,
          status: "pending",
          is_fix: true,
          parent_batch_id: audit.batch_id,
        })
        .select("id")
        .single();
      fixBatchId = inserted?.id ?? null;
    }
    await admin.from("batches").update({ status: "fix_needed" }).eq("id", audit.batch_id);
  }

  if (findings.length) {
    await admin.from("audit_findings").insert(
      findings.map((f: any) => ({
        audit_id: auditId,
        user_id: audit.user_id,
        seat: typeof f.seat === "string" ? f.seat : null,
        severity: ["P0", "P1", "P2", "P3"].includes(f.severity) ? f.severity : "P2",
        file_path: typeof f.file_path === "string" ? f.file_path : null,
        title: String(f.title).slice(0, 500),
        description: typeof f.description === "string" ? f.description : null,
        fix_batch_id: fixBatchId,
        status: fixBatchId ? "fix_drafted" : "open",
      })),
    );
  }

  // Loop-2+ with unresolved findings → needs human eyes.
  if (Number(audit.loop_no ?? 1) >= 2 && findings.length && audit.project_id) {
    let batchTitle = "";
    if (audit.batch_id) {
      const { data: b } = await admin.from("batches").select("title").eq("id", audit.batch_id).maybeSingle();
      batchTitle = b?.title ?? "";
    }
    await insertAlert(admin, {
      user_id: audit.user_id,
      project_id: audit.project_id,
      kind: "audit_loop",
      detail: { batch_title: batchTitle, loop_no: Number(audit.loop_no ?? 1), counts: summary.counts },
    });
  }


  await admin
    .from("boardroom_runs")
    .update({ status: "consensus", consensus: { ...(run.consensus ?? {}), verdict: "findings", fix_batch_id: fixBatchId } })
    .eq("id", run.id);
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

  if (run.kind === "change_request") {
    // cr_exam_* → cr_verdict_chair → (if approved) cr_review_inspector → (if blocking) cr_revise_chair
    const examsDone = SEATS.every((s) =>
      steps.some((x: any) => x.step_key === `cr_exam_${s}` && x.status === "completed"),
    );
    const verdictStep = steps.find((x: any) => x.step_key === "cr_verdict_chair" && x.status === "completed");
    if (verdictStep) {
      const v = verdictStep.response_json ?? {};
      // Rejections and invalid verdicts finalize directly — nothing to inspect.
      if (v.invalid || v.verdict !== "approved") {
        await finalizeChangeRequest(admin, run, steps);
        return;
      }
      const revise = steps.find((x: any) => x.step_key === "cr_revise_chair");
      if (revise) {
        await finalizeChangeRequest(admin, run, steps);
        return;
      }
      const review = steps.find((x: any) => x.step_key === "cr_review_inspector");
      if (!review) {
        await queueChangeRequestReview(admin, run, v);
        fireSelfTick();
        return;
      }
      if (review.status === "completed") {
        const rj = review.response_json ?? {};
        const needsRevision = !rj.invalid && (
          rj.verdict === "revise" ||
          (Array.isArray(rj.issues) && rj.issues.some((i: any) => i?.severity === "blocking"))
        );
        if (needsRevision) {
          await queueChangeRequestRevise(admin, run, v, rj);
          fireSelfTick();
          return;
        }
        await finalizeChangeRequest(admin, run, steps);
      }
      return;
    }
    if (examsDone) {
      const crId = run.consensus?.change_request_id;
      const { data: cr } = crId
        ? await admin.from("change_requests").select("*").eq("id", crId).maybeSingle()
        : { data: null };
      const { data: plan } = await admin
        .from("plan_versions")
        .select("content_md, prd_md")
        .eq("project_id", run.project_id)
        .eq("kind", "plan")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cr) await queueChangeRequestVerdict(admin, run, cr, plan ?? {}, steps);
      fireSelfTick();
      return;
    }
    return;
  }

  if (run.kind === "audit") {
    const chair = steps.find((x: any) => x.step_key === "audit_chair_merge");
    if (chair?.status === "completed") {
      await finalizeAudit(admin, run, steps);
      return;
    }
    if (chair) return; // waiting on chair
    const seatSteps = steps.filter((x: any) => /^audit_(inspector|contrarian|strategist)/.test(x.step_key));
    const parallelDone = seatSteps.length > 0 && seatSteps.every((x: any) => x.status === "completed");
    if (parallelDone) {
      await queueAuditChairMerge(admin, run, steps);
      fireSelfTick();
    }
    return;
  }

  if (run.kind === "batches") {
    const draft = steps.find((x: any) => x.step_key === "batches_chair");
    if (!(draft?.status === "completed" && draft.response_json && !draft.response_json.invalid)) {
      await admin
        .from("boardroom_runs")
        .update({ status: "failed", error: draft?.response_json?.validation_error ?? "batches_chair did not produce a valid response" })
        .eq("id", run.id);
      return;
    }

    // Stage 3: a revision exists — ship it (fall back to the draft if the
    // revision came back invalid; a reviewed draft beats a dead run).
    const revise = steps.find((x: any) => x.step_key === "batches_revise_chair");
    if (revise) {
      const revised = revise.status === "completed" && revise.response_json && !revise.response_json.invalid
        ? revise.response_json
        : draft.response_json;
      await finalizeBatches(admin, run, revised.batches ?? []);
      return;
    }

    // Stage 2: reviews are in — decide whether the Chair must revise.
    const reviews = steps.filter((x: any) => x.step_key.startsWith("batches_review_"));
    if (reviews.length) {
      const completed = reviews.filter((x: any) => x.status === "completed" && x.response_json && !x.response_json.invalid);
      const needsRevision = completed.some((x: any) =>
        x.response_json.verdict === "revise" ||
        (Array.isArray(x.response_json.issues) && x.response_json.issues.some((i: any) => i?.severity === "blocking")),
      );
      if (needsRevision) {
        await queueBatchesRevise(admin, run, draft.response_json, completed);
        fireSelfTick();
        return;
      }
      await finalizeBatches(admin, run, draft.response_json.batches ?? []);
      return;
    }

    // Stage 1: the draft just landed — send it to review.
    await queueBatchesReview(admin, run, draft.response_json);
    fireSelfTick();
    return;
  }


  if (run.kind !== "plan" && run.kind !== "design") {
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
    // Two-phase synthesis: draft done → queue the decision-log extract;
    // extract done → move to the vote. Legacy runs (JSON synthesis step,
    // no draft) go straight to the vote.
    const draftDone = steps.some((x: any) => x.step_key === `r3_draft_chair_loop${loop}` && x.status === "completed");
    const extractDone = steps.some((x: any) => x.step_key === `r3_extract_chair_loop${loop}` && x.status === "completed");
    if (draftDone && !extractDone) {
      await queueRound3Extract(admin, run, steps, loop);
      fireSelfTick();
      return;
    }
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
    const threshold = await resolveConsensusThreshold(admin, run.user_id);
    const { pass } = checkConsensus(votes, run.kind, threshold);
    if (pass) {
      await lockPlanAndQueueBlueprint(admin, run, steps, "consensus");
      fireSelfTick();
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
    await lockPlanAndQueueBlueprint(admin, run, steps, "chair_ruled");
    fireSelfTick();
    return;
  }

  if (round === 6) {
    // Two-phase blueprint: PRD draft done → queue the features extract;
    // extract done → finalize. Legacy JSON blueprints finalize directly.
    const bp = steps.find((x: any) => x.step_key === "r5_blueprint_chair" && x.status === "completed");
    const extractDone = steps.some((x: any) => x.step_key === "r5_blueprint_extract_chair" && x.status === "completed");
    const isLegacyJson = !!bp?.response_json?.prd_md;
    if (bp && !extractDone && !isLegacyJson) {
      await queueBlueprintExtract(admin, run, steps);
      fireSelfTick();
      return;
    }
    await finalizeBlueprint(admin, run, steps);
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
  // Claim up to MAX_STEP_CONCURRENCY queued steps of the current round and run
  // them concurrently — a round takes ~one seat's latency instead of four,
  // without firing every step at the DB/OpenRouter at once. Remaining steps
  // process on the next self-tick. The proxy still checks budget/caps before
  // each call; parallel seats can overshoot the run budget by at most the
  // in-flight calls, the same order of magnitude the serial path allowed.
  const claimed: any[] = [];
  while (claimed.length < MAX_STEP_CONCURRENCY) {
    const step = await claimOneStep(admin, runId);
    if (!step) break;
    claimed.push(step);
  }
  if (!claimed.length) {
    await afterStepComplete(admin, run);
    return;
  }
  await Promise.all(claimed.map((step) => executeStep(admin, run, step)));
  const freshRun = await getRun(admin, runId);
  if (freshRun && freshRun.status === "running") {
    await afterStepComplete(admin, freshRun);
  }
}


async function pipelineTick(admin: any) {
  // Rescue steps orphaned by a dead invocation: an edge function caps out
  // near ~400s wall clock, so anything 'running' for 15+ minutes belongs to
  // an invocation that no longer exists. Requeue it; the atomic claim keeps
  // double-execution impossible for live invocations.
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  // Steps claimed long ago by an invocation that has since died.
  await admin
    .from("run_steps")
    .update({ status: "queued", started_at: null, error: "requeued_stale" })
    .eq("status", "running")
    .lt("started_at", staleCutoff);
  // Legacy/pre-migration orphans have no started_at at all — every live claim
  // now stamps it, so a 'running' row with started_at IS NULL can only be an
  // orphan. Requeue those too (gated on run age as a belt-and-suspenders).
  await admin
    .from("run_steps")
    .update({ status: "queued", error: "requeued_stale" })
    .eq("status", "running")
    .is("started_at", null)
    .lt("created_at", staleCutoff);

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

  try {
    return await handleRequest(req);
  } catch (e) {
    // Never let a transient throw (auth blip, socket error, DB hiccup) escape
    // as a bare non-2xx with no body/CORS — that surfaces to the client as
    // "Edge Function returned a non-2xx status code" with nothing to act on.
    // Return a structured, CORS-headed 500 the frontend can read and retry.
    return j(500, { error: (e as Error)?.message ?? "Internal error" });
  }
});

async function handleRequest(req: Request): Promise<Response> {
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
    const changeRequestId: string | undefined = body?.change_request_id;
    if (!projectId || !kind) return j(400, { error: "Missing project_id or kind" });
    if (!["test", "plan", "features", "design", "change_request", "audit", "batches"].includes(kind)) {
      return j(400, { error: "Invalid kind" });
    }
    const { data: project } = await admin
      .from("projects")
      .select("id, user_id, is_import, github_repo")
      .eq("id", projectId)
      .maybeSingle();
    if (!project || project.user_id !== userId) return j(404, { error: "Project not found" });

    if (kind === "design" || kind === "batches") {
      const locked = await loadLockedPlan(admin, projectId);
      if (!locked) {
        if (kind === "design" && project.is_import) {
          // Design Council for imports may run without a locked plan: need repo or description.
          const intake = await loadIntake(admin, projectId);
          const hasDesc = !!intake?.answers?.description;
          if (!project.github_repo && !hasDesc) {
            return j(400, { error: "Link your repo or describe the app so the board can see it." });
          }
        } else {
          // 'batches' ALWAYS requires a locked plan — imports must lock their improvement plan first.
          return j(400, { error: kind === "design" ? "The board locks the plan before it debates the look." : "The board locks the plan before it sequences the build." });
        }
      }
    }
    if (kind === "batches") {
      const { count } = await admin
        .from("batches")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId);
      if ((count ?? 0) > 0) return j(400, { error: "This project already has a build sequence." });
    }


    let consensusMeta: any = null;
    if (kind === "change_request") {
      if (!changeRequestId) return j(400, { error: "Missing change_request_id" });
      const { data: cr } = await admin
        .from("change_requests")
        .select("id, user_id, project_id, status")
        .eq("id", changeRequestId)
        .maybeSingle();
      if (!cr || cr.user_id !== userId || cr.project_id !== projectId) {
        return j(404, { error: "Change request not found" });
      }
      if (cr.status !== "pending") return j(400, { error: "Change request is not pending" });
      consensusMeta = { change_request_id: changeRequestId };
    }

    const { data: constRow } = await admin
      .from("app_settings")
      .select("version")
      .eq("key", "constitution")
      .maybeSingle();

    const budget = kind === "test" ? 0.25 : kind === "change_request" ? 3.0 : kind === "batches" ? 3.0 : 10.0;
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
        consensus: consensusMeta,
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
}
