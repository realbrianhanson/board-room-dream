// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import {
  adminClient,
  BudgetExceeded,
  DailyCapExceeded,
  callSeat,
  decideTransportRequeue,
  isBodyTransportError,
  NoUserKey,
  SeatUnavailable,
  shouldQuickRetry,
} from "../_shared/openrouter-proxy.ts";


import {
  SEATS,
  type Seat,
  candidateForLoop,
  lastCandidateLoop,
  checkConsensus,
  resolveConsensusThreshold,
  validateStepJson,
  correctionForStep,
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
  RepoContractUnavailable,
} from "./queues.ts";
import { BatchContextTooLarge, buildValidationRetryRequest } from "../_shared/batch-context.ts";
import {
  finalizeChangeRequestAuthorityError,
  finalizePlanAuthorityError,
  loadOwnerAuthority,
  preLockAuthorityError,
} from "../_shared/owner-authority.ts";



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


// Runtime build stamp, returned on unauthenticated requests so the live build
// is verifiable with a single curl. Bump on every orchestrator change.
const BUILD_VERSION = "2026-07-27.batch-compact.l2";

import {
  failRun,
  requeueLegacyNullStartOrphans,
  requeueStepIfParentActive,
  TERMINAL_RUN_STATUSES,
} from "./hygiene.ts";

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


// Claim a queued step for this run under an aggregate per-run capacity that
// holds across overlapping cron / self-tick invocations. The database RPC
// takes a transaction-scoped advisory lock keyed on run_id, counts currently
// running steps, and only then claims the oldest queued row (FOR UPDATE SKIP
// LOCKED). Enforcing the cap in-process is not enough — the platform runs
// multiple invocations concurrently and each has its own MAX_STEP_CONCURRENCY
// counter, so N invocations could otherwise claim N × capacity in parallel.
async function claimOneStep(admin: any, runId: string, capacity: number) {
  const { data, error } = await admin.rpc("claim_run_step_with_capacity", {
    p_run_id: runId,
    p_capacity: capacity,
  });
  if (error) {
    // Surface loudly — silently returning null would falsely report "no work"
    // and stall the run.
    throw new Error(`claim_run_step_with_capacity failed: ${error.message ?? error}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}



// Hard ceiling on a single model call, enforced at the ORCHESTRATOR level so
// a step can never hang the pipeline regardless of what the proxy does. Kept
// under the platform's ~150s invocation cap so the abort fires while the
// isolate is still alive — otherwise the timer dies with the invocation and
// only the once-a-minute watchdog rescues the step. Any hard-timeout is
// treated exactly like a proxy timeout: requeue with force_fallback.
const STEP_HARD_TIMEOUT_MS = 120_000;

function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`Step ${label} exceeded hard timeout ${ms}ms`);
      (err as any).isHardTimeout = true;
      (err as any).isTimeout = true;
      reject(err);
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// requeueStepIfParentActive / failRun / requeueLegacyNullStartOrphans /
// TERMINAL_RUN_STATUSES live in ./hygiene.ts so they can be unit tested
// without booting Deno.serve. See that module for behavior contracts.


async function requeueForTimeout(admin: any, step: any): Promise<string> {
  const timeoutAttempts = Number(step.request?._timeout_attempts ?? 0) + 1;
  return await requeueStepIfParentActive(
    admin,
    step.id,
    {
      ...(step.request ?? {}),
      _timeout_attempts: timeoutAttempts,
      // Never switch back to the timed-out primary — the reserve answers next.
      force_fallback: true,
    },
    "timeout_failover",
  );
}

// Body-stream/transport failure on a 2xx OpenRouter response. Fresh retry on
// the SAME model (transport is not a model-quality signal); one retry max —
// caller already decided that via decideTransportRequeue.
async function requeueForBodyTransport(admin: any, step: any, attempts: number): Promise<string> {
  return await requeueStepIfParentActive(
    admin,
    step.id,
    {
      ...(step.request ?? {}),
      _transport_attempts: attempts,
    },
    "body_transport_requeued",
  );
}

async function requeueForValidation(admin: any, run: any, step: any, baseMessages: any[], assistantContent: string, validationError: string, truncated: boolean): Promise<string> {
  const attempts = Number(step.request?._validation_attempts ?? 0) + 1;
  try {
    const { request: newRequest, mode } = buildValidationRetryRequest({
      stepKey: String(step.step_key ?? ""),
      baseRequest: step.request ?? {},
      baseMessages,
      assistantContent,
      validationError,
      truncated,
      correction: correctionForStep(step.step_key),
    });
    return await requeueStepIfParentActive(
      admin,
      step.id,
      {
        ...newRequest,
        _validation_attempts: attempts,
        _validation_retry_mode: mode,
      },
      truncated ? "truncated_output_requeued" : "invalid_json_requeued",
    );
  } catch (e) {
    if (e instanceof BatchContextTooLarge) {
      // Even the fallback (base + correction, no echo) does not fit. Fail
      // closed rather than leave the step "running" forever — the watchdog
      // would otherwise churn on a payload that can never be shrunk safely.
      await admin
        .from("run_steps")
        .update({
          status: "failed",
          error: e.message,
          response_text: assistantContent,
          completed_at: new Date().toISOString(),
        })
        .eq("id", step.id)
        .eq("status", "running");
      await failRun(admin, run, e.message);
      return "cancelled_parent_terminal";
    }
    throw e;
  }
}


async function executeStep(admin: any, run: any, step: any) {
  const baseMessages = step.request?.messages ?? [];
  const jsonMode = !!step.request?.json_output;
  console.log(`[exec] start step=${step.step_key} seat=${step.seat} run=${run.id}`);

  // Quick 429/5xx retry is capped at 1 AND only fires for errors that hit
  // before the model produced any response — timeouts requeue in a fresh
  // invocation instead, and invalid JSON requeues for a fresh correction.
  let networkAttempt = 0;
  while (true) {
    let result: Awaited<ReturnType<typeof callSeat>>;
    try {
      console.log(`[exec] calling model step=${step.step_key} attempt=${networkAttempt} force_fallback=${!!step.request?.force_fallback}`);
      result = await withHardTimeout(
        callSeat(run.user_id, step.seat as Seat, baseMessages, {
          runId: run.id,
          projectId: run.project_id,
          temperature: Number(step.request?.temperature ?? 0.4),
          reasoningEffort: step.request?.reasoning_effort,
          json: jsonMode,
          forceFallback: !!step.request?.force_fallback,
          maxTokens: Number(step.request?.max_tokens) > 0 ? Number(step.request.max_tokens) : undefined,
        }),
        STEP_HARD_TIMEOUT_MS,
        step.step_key,
      );
    } catch (e) {
      if (e instanceof DailyCapExceeded) {
        const capCopy =
          `Daily spend cap hit — ${e.scope} scope. ` +
          `Cap $${Number(e.cap).toFixed(2)}, spent $${Number(e.spent).toFixed(2)}. ` +
          `Resets at 00:00 UTC or an admin can raise the cap in Settings.`;
        await admin.from("run_steps").update({ status: "queued", error: "daily_cap" }).eq("id", step.id);
        await admin.from("boardroom_runs").update({ status: "paused_budget", error: capCopy }).eq("id", run.id);
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
        const budgetCopy =
          `Run budget hit — spent $${Number(run.spent_usd ?? 0).toFixed(2)} of $${Number(run.budget_usd ?? 0).toFixed(2)}. ` +
          `You can resume this run with extra budget.`;
        await admin.from("run_steps").update({ status: "queued", error: "budget" }).eq("id", step.id);
        await admin.from("boardroom_runs").update({ status: "paused_budget", error: budgetCopy }).eq("id", run.id);
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
      if (e instanceof NoUserKey || e instanceof SeatUnavailable) {
        await admin
          .from("run_steps")
          .update({ status: "failed", error: (e as Error).message, completed_at: new Date().toISOString() })
          .eq("id", step.id)
          .eq("status", "running");
        await failRun(admin, run, (e as Error).message);
        return;
      }
      // Timeout (proxy abort OR orchestrator hard-timeout): invocation-safe
      // failover. Requeue with force_fallback so the reserve answers in a
      // FRESH invocation. If we already forced the fallback and it also
      // timed out, fail loudly — the seat is truly stuck.
      if ((e as any)?.isTimeout || (e as any)?.isHardTimeout) {
        const model = (e as any)?.attemptedModel ?? "unknown";
        console.log(`[exec] TIMEOUT step=${step.step_key} run=${run.id} model=${model} force_fallback=${!!step.request?.force_fallback}`);
        if (step.request?.force_fallback) {
          const tmsg = `Step ${step.step_key} timed out on the reserve model — even the fallback could not answer in time.`;
          await admin
            .from("run_steps")
            .update({ status: "failed", error: "timeout_failover_exhausted", completed_at: new Date().toISOString() })
            .eq("id", step.id)
            .eq("status", "running");
          await failRun(admin, run, tmsg);
          return;
        }
        const outcome = await requeueForTimeout(admin, step);
        if (outcome === "cancelled_parent_terminal") {
          console.log(`[exec] TIMEOUT step=${step.step_key} run=${run.id} parent already terminal — step cancelled`);
        }
        return;
      }
      // Response-body transport failure on a 2xx response (e.g.
      // "error reading a body from connection"). No usable response was ever
      // read, so the proxy did NOT record cost/tokens. Do NOT quick-retry in
      // the same invocation (that just spawns another 100s+ model call inside
      // a dying isolate) and do NOT switch to the fallback model (transport
      // is not a model-quality signal). Requeue fresh on the SAME model,
      // capped at one retry; second occurrence is terminal.
      if (isBodyTransportError(e)) {
        const decision = decideTransportRequeue(step);
        console.log(`[exec] BODY_TRANSPORT step=${step.step_key} run=${run.id} decision=${decision.action} attempts=${decision.attempts}`);
        if (decision.action === "requeue") {
          const outcome = await requeueForBodyTransport(admin, step, decision.attempts);
          if (outcome === "cancelled_parent_terminal") {
            console.log(`[exec] BODY_TRANSPORT step=${step.step_key} parent already terminal — step cancelled`);
          }
          return;
        }
        await admin
          .from("run_steps")
          .update({
            status: "failed",
            error: "transport_retry_exhausted",
            completed_at: new Date().toISOString(),
          })
          .eq("id", step.id)
          .eq("status", "running");
        await failRun(admin, run, decision.message);
        return;
      }
      // Strictly classified quick retry: ONLY pre-response network failures,
      // 429, or 5xx. Any other 4xx, validation, budget, or unexpected error
      // fails the step immediately — no blind same-invocation retry.
      if (networkAttempt === 0 && shouldQuickRetry(e)) {
        networkAttempt++;
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      const msg = (e as Error).message ?? String(e);
      console.log(`[exec] ERROR step=${step.step_key} run=${run.id} msg=${msg}`);
      await admin
        .from("run_steps")
        .update({ status: "failed", error: msg, completed_at: new Date().toISOString() })
        .eq("id", step.id)
        .eq("status", "running");
      await failRun(admin, run, msg);
      return;
    }

    // Success path — the model answered. Validate structured output.
    const content = result.content;
    const usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd };
    const fallbackMeta = result.fallback ?? null;

    if (jsonMode) {
      let candidate: any = null;
      try { candidate = JSON.parse(content); } catch { candidate = null; }
      const err = candidate ? validateStepJson(step.step_key, candidate, run.kind) : "Response was not parseable JSON.";
      if (err) {
        // Detect truncation: provider finish_reason of length/max_tokens, OR
        // unparseable JSON whose content is close to the requested max_tokens
        // ceiling (heuristic: >=95% of max_tokens * ~4 chars/token).
        const finishReason = (result as any)?.finishReason;
        const maxTokens = Number(step.request?.max_tokens) > 0 ? Number(step.request.max_tokens) : 0;
        const nearMax = !candidate && maxTokens > 0 && content.length >= Math.floor(maxTokens * 4 * 0.95);
        const truncated = finishReason === "length" || finishReason === "max_tokens" || nearMax;

        // Invocation-safe correction: NEVER mark completed with invalid output
        // and NEVER make two long model calls in one invocation. Queue the
        // correction into a fresh invocation, exactly one retry before failing.
        const validationAttempts = Number(step.request?._validation_attempts ?? 0);
        if (validationAttempts >= 1) {
          const vmsg = `Step ${step.step_key} produced invalid JSON after one correction pass: ${err}`;
          await admin
            .from("run_steps")
            .update({
              status: "failed",
              error: truncated ? "truncated_after_correction" : "invalid_json_after_correction",
              response_text: content,
              tokens_in: usage.tokensIn,
              tokens_out: usage.tokensOut,
              cost_usd: usage.costUsd,
              completed_at: new Date().toISOString(),
            })
            .eq("id", step.id)
            .eq("status", "running");
          await failRun(admin, run, vmsg);
          return;
        }
        const vOutcome = await requeueForValidation(admin, run, step, baseMessages, content, err, truncated);
        if (vOutcome === "cancelled_parent_terminal") {
          console.log(`[exec] VALIDATION step=${step.step_key} parent already terminal — step cancelled`);
        }
        return;
      }
      let parsed: any = candidate;
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
        .eq("id", step.id)
        .eq("status", "running");
      return;
    }

    // Non-JSON free-markdown path — complete as-is.
    await admin
      .from("run_steps")
      .update({
        status: "completed",
        response_text: content,
        response_json: fallbackMeta ? { _meta: { fallback: fallbackMeta } } : null,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        cost_usd: usage.costUsd,
        completed_at: new Date().toISOString(),
      })
      .eq("id", step.id)
      .eq("status", "running");
    return;
  }
}



async function lockPlanAndQueueBlueprint(
  admin: any,
  run: any,
  steps: any[],
  mode: "consensus" | "chair_ruled",
) {
  const planKind = run.kind === "design" ? "design" : "plan";

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

  // Never lock an empty document: fail loudly instead of finalizing garbage.
  if (!contentMd.trim()) {
    await failRun(admin, run, "empty_final_document");
    await insertAlert(admin, {
      user_id: run.user_id,
      project_id: run.project_id,
      kind: "never_locked",
      detail: { run_id: run.id, mode, reason: "final document was empty" },
    });
    return;
  }

  // Pre-lock owner-authority gate: independently load owner sources and run
  // the high-impact validator over the exact artifacts we are about to lock.
  // Chair/loop3 CANNOT override — a violation terminalizes the run before any
  // downstream blueprint work is queued.
  try {
    const authority = await loadOwnerAuthority(admin, {
      projectId: run.project_id,
      founderNotes: run.founder_notes ?? null,
    });
    const preErr = preLockAuthorityError(
      [{ label: `${planKind}.content_md (pending lock)`, text: contentMd }],
      authority,
    );
    if (preErr) {
      await failRun(admin, run, preErr);
      await insertAlert(admin, {
        user_id: run.user_id,
        project_id: run.project_id,
        kind: "owner_authority_violation",
        detail: { run_id: run.id, mode, phase: "pre_lock", excerpt: preErr.slice(0, 800) },
      });
      return;
    }
  } catch (e) {
    // Loader failure is safe-fail: block the lock, not the process.
    await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
    return;
  }


  // Atomically claim the lock transition: two concurrent ticks can both reach
  // this point; flipping round_no to 6 in one guarded UPDATE lets exactly one
  // win, so duplicate plan_versions are impossible.
  const { data: claimRows } = await admin
    .from("boardroom_runs")
    .update({ round_no: 6, updated_at: new Date().toISOString() })
    .eq("id", run.id)
    .lt("round_no", 6)
    .select("id");
  if (!claimRows || claimRows.length === 0) {
    return;
  }

  const { data: existing } = await admin
    .from("plan_versions")
    .select("version")
    .eq("project_id", run.project_id)
    .eq("kind", planKind)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;

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

  // Pre-finalization owner-authority gate: the PRD markdown + features are
  // generated AFTER lockPlanAndQueueBlueprint and would otherwise bypass the
  // deterministic gate. Independently load owner sources and validate both
  // artifacts. On violation: do NOT update plan_versions, do NOT mark the
  // run completed. Fail with proposal_requires_owner_approval + alert.
  // Chair-ruled and consensus flows are treated identically.
  if (planVersionId && (prdMd || (features && features.length))) {
    try {
      const authority = await loadOwnerAuthority(admin, {
        projectId: run.project_id,
        founderNotes: run.founder_notes ?? null,
      });
      const preErr = finalizePlanAuthorityError(prdMd, features, authority);
      if (preErr) {
        await failRun(admin, run, preErr);
        await insertAlert(admin, {
          user_id: run.user_id,
          project_id: run.project_id,
          kind: "owner_authority_violation",
          detail: {
            run_id: run.id,
            mode: finalStatus,
            phase: "pre_finalize_blueprint",
            excerpt: preErr.slice(0, 800),
          },
        });
        return;
      }
    } catch (e) {
      await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
      return;
    }
  }

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
    // Pre-finalization owner-authority gate for change requests. Load the
    // EXACT current change_requests.description as an explicit owner source
    // scoped to THIS CR run only. A Chair cannot expand beyond the submitted
    // change (e.g. tack on Stripe/DROP TABLE). On violation: insert NO plan
    // version, do NOT mark the CR approved, fail clearly.
    let crDescription = "";
    try {
      const { data: crRow } = await admin
        .from("change_requests")
        .select("description")
        .eq("id", crId)
        .maybeSingle();
      crDescription = String(crRow?.description ?? "");
    } catch { /* ignore — an empty CR description simply blocks any high-impact expansion */ }
    try {
      const authority = await loadOwnerAuthority(admin, {
        projectId: run.project_id,
        founderNotes: run.founder_notes ?? null,
        extraFounderNotes: crDescription
          ? [{ source: `approved_change_request:${crId}`, text: crDescription }]
          : [],
      });
      const preErr = finalizeChangeRequestAuthorityError(v, authority);
      if (preErr) {
        await failRun(admin, run, preErr);
        await insertAlert(admin, {
          user_id: run.user_id,
          project_id: run.project_id,
          kind: "owner_authority_violation",
          detail: {
            run_id: run.id,
            change_request_id: crId,
            phase: "pre_finalize_change_request",
            excerpt: preErr.slice(0, 800),
          },
        });
        return;
      }
    } catch (e) {
      await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
      return;
    }

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

  // Pre-promotion owner-authority gate: independently validate the complete
  // batch set BEFORE any executable row is saved. Reviewer/reviser upstream
  // signals are advisory; this is the deterministic last-line gate.
  try {
    const authority = await loadOwnerAuthority(admin, {
      projectId: run.project_id,
      founderNotes: run.founder_notes ?? null,
    });
    const preErr = preLockAuthorityError(
      rows.map((r) => ({ label: `batch[${r.batch_no}] "${r.title}".prompt_md`, text: r.prompt_md })),
      authority,
    );
    if (preErr) {
      await failRun(admin, run, preErr);
      await insertAlert(admin, {
        user_id: run.user_id,
        project_id: run.project_id,
        kind: "owner_authority_violation",
        detail: { run_id: run.id, phase: "pre_promote_batches", excerpt: preErr.slice(0, 800) },
      });
      return;
    }
  } catch (e) {
    await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
    return;
  }

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
    await failRun(admin, run, "audit row missing");
    return;
  }

  // Normalize → dedupe → downgrade unsupported P0/P1. Validators live in
  // _shared/audit-findings.ts; we always end up with schema-clean rows.
  const { normalizeFindings, dedupeFindings, downgradeUnsupported, validateMerged } =
    await import("../_shared/audit-findings.ts");
  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const normalized = normalizeFindings(rawFindings);
  const deduped = dedupeFindings(normalized);
  const { findings, downgrades } = downgradeUnsupported(deduped);

  // Hard validator gate. If model produced structurally impossible data
  // (too many, oversize, bad lines) after normalization, treat as merge
  // failure — audit ends failed, no partial findings, no fix batch.
  const vErr = validateMerged(findings);
  if (vErr) {
    await admin
      .from("audits")
      .update({ status: "failed", completed_at: new Date().toISOString(), summary: { error: `merge_validation_failed: ${vErr}` } })
      .eq("id", auditId);
    await failRun(admin, run, `audit_chair_merge failed validation: ${vErr}`);
    return;
  }

  const verdict = parsed?.verdict === "clean" || findings.length === 0 ? "clean" : "findings";
  const filesAnalyzed = Number(run.consensus?.files_analyzed ?? 0) || null;

  const summary = {
    verdict,
    text: String(parsed?.summary ?? ""),
    counts: {
      P0: findings.filter((f) => f.severity === "P0").length,
      P1: findings.filter((f) => f.severity === "P1").length,
      P2: findings.filter((f) => f.severity === "P2").length,
      P3: findings.filter((f) => f.severity === "P3").length,
    },
    validation_downgrades: downgrades,
  };

  const isFinal = audit.kind === "final_az";

  if (verdict === "clean") {
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
      const { data: fixBatch } = await admin
        .from("batches")
        .select("parent_batch_id")
        .eq("id", audit.batch_id)
        .maybeSingle();
      if (fixBatch?.parent_batch_id) {
        await admin.from("batches").update({ status: "passed" }).eq("id", fixBatch.parent_batch_id);
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
          channel: "human",
          prompt_md: qa,
          status: "pending",
        });
      }
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
  // Only SUPPORTED (post-downgrade) P0/P1 can trigger a fix batch.
  const supportedSerious = findings.filter((f) => f.severity === "P0" || f.severity === "P1");
  const hasSupportedSerious = supportedSerious.length > 0;

  if (!isFinal && audit.batch_id && hasSupportedSerious && fixPrompt) {
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

  if (isFinal && hasSupportedSerious && fixPrompt) {
    const { data: last } = await admin
      .from("batches")
      .select("batch_no")
      .eq("project_id", audit.project_id)
      .order("batch_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNo = Math.floor(Number(last?.batch_no ?? 0)) + 1;
    const { data: inserted } = await admin
      .from("batches")
      .insert({
        project_id: audit.project_id,
        user_id: audit.user_id,
        batch_no: nextNo,
        title: "Fix — Final A-Z Audit",
        channel: "lovable",
        prompt_md: fixPrompt,
        status: "pending",
        is_fix: true,
      })
      .select("id")
      .single();
    fixBatchId = inserted?.id ?? null;
  }

  if (findings.length) {
    await admin.from("audit_findings").insert(
      findings.map((f) => ({
        audit_id: auditId,
        user_id: audit.user_id,
        seat: f.seat,
        severity: f.severity,
        file_path: f.file_path,
        title: f.title,
        description: f.description,
        evidence: f.evidence || null,
        confidence: f.confidence,
        line_start: f.line_start,
        line_end: f.line_end,
        fix_batch_id: (f.severity === "P0" || f.severity === "P1") ? fixBatchId : null,
        status: (f.severity === "P0" || f.severity === "P1") && fixBatchId ? "fix_drafted" : "open",
      })),
    );
  }

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
  // Queued steps = claimable work -> kick one tick to pick them up.
  if (steps.some((s: any) => s.status === "queued")) {
    fireSelfTick();
    return;
  }
  // Running steps = another invocation is on it. Do NOT self-tick here: that
  // invocation calls afterStepComplete itself when its step finishes, and the
  // per-minute cron rescues orphans. Re-firing on merely-running steps created
  // an infinite tick storm that maxed the instance and kept old warm isolates
  // permanently busy so redeployed code never took effect.
  if (steps.some((s: any) => s.status === "running")) {
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

    // Stage 3: a revision exists — ship it, but NEVER fall back to the
    // unrevised draft once reviewers demanded changes. A silent fallback is
    // what shipped invented UPDATE targets.
    const revise = steps.find((x: any) => x.step_key === "batches_revise_chair");
    if (revise) {
      const ok = revise.status === "completed" && revise.response_json && !revise.response_json.invalid;
      const revisedList: any[] = ok && Array.isArray(revise.response_json.batches)
        ? revise.response_json.batches
        : [];
      // Extra guard: re-run validation even if executeStep already accepted it.
      const validationError = ok
        ? validateStepJson("batches_revise_chair", revise.response_json)
        : (revise.response_json?.validation_error ?? revise.error ?? "batches_revise_chair did not complete");
      if (!ok || validationError || !revisedList.length) {
        await admin
          .from("boardroom_runs")
          .update({
            status: "failed",
            error: `The Chair's revision failed after reviewers flagged blocking issues: ${validationError ?? "empty batches list"}. Draft and reviewer notes are preserved in run_steps for diagnosis.`,
          })
          .eq("id", run.id);
        return;
      }
      await finalizeBatches(admin, run, revisedList);
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
        try {
          await queueBatchesRevise(admin, run, draft.response_json, completed);
        } catch (e) {
          if (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge) {
            await failRun(admin, run, e.message);
            return;
          }
          throw e;
        }
        fireSelfTick();
        return;
      }
      await finalizeBatches(admin, run, draft.response_json.batches ?? []);
      return;
    }

    // Stage 1: the draft just landed — send it to review.
    try {
      await queueBatchesReview(admin, run, draft.response_json);
    } catch (e) {
      if (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge) {
        await failRun(admin, run, e.message);
        return;
      }
      throw e;
    }
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
  // The RPC enforces the aggregate cap across overlapping invocations, so this
  // invocation may request up to MAX_STEP_CONCURRENCY but never pushes the run
  // above the per-run limit.
  const claimed: any[] = [];
  while (claimed.length < MAX_STEP_CONCURRENCY) {
    const step = await claimOneStep(admin, runId, MAX_STEP_CONCURRENCY);
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
  // Last-resort backup for steps orphaned by a dead invocation: the platform
  // can kill an isolate at any moment (~150s cap) and take its in-isolate
  // timers with it, so a step 'running' for 3+ minutes belongs to an
  // invocation that no longer exists. The primary timeout failover lives in
  // executeStep — this watchdog only catches the rare case where the
  // invocation died BEFORE executeStep's catch block could requeue.
  //
  // Escalation preserves prior state so we never switch back to the timed-out
  // primary model: existing force_fallback stays sticky, existing
  // _timeout_attempts is preserved, and _attempts caps the rescue count.
  const staleCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: staleSteps } = await admin
    .from("run_steps")
    .select("id, run_id, step_key, request")
    .eq("status", "running")
    .lt("started_at", staleCutoff);
  for (const st of staleSteps ?? []) {
    // Never resurrect steps whose parent is already terminal — go straight to
    // failed/cancelled and skip the requeue path entirely.
    const { data: parentRun } = await admin
      .from("boardroom_runs")
      .select("id, kind, status, consensus")
      .eq("id", st.run_id)
      .maybeSingle();
    if (parentRun && (TERMINAL_RUN_STATUSES as readonly string[]).includes(parentRun.status)) {
      await admin
        .from("run_steps")
        .update({ status: "failed", error: "cancelled_parent_terminal", completed_at: new Date().toISOString() })
        .eq("id", st.id)
        .eq("status", "running");
      continue;
    }
    const attempts = Number(st.request?._attempts ?? 0) + 1;
    const alreadyForced = !!st.request?.force_fallback;
    if (attempts >= 4 || (alreadyForced && attempts >= 2)) {
      await admin
        .from("run_steps")
        .update({ status: "failed", error: "stuck_model_call", completed_at: new Date().toISOString() })
        .eq("id", st.id)
        .eq("status", "running");
      if (parentRun) {
        await failRun(admin, parentRun, `Step ${st.step_key} kept timing out — even the fallback model could not answer in time.`);
      }
      continue;
    }
    // Atomic parent-aware requeue via RPC — if the parent flips terminal
    // between the check above and this call, the RPC cancels the step
    // instead of resurrecting it.
    await requeueStepIfParentActive(
      admin,
      st.id,
      {
        ...(st.request ?? {}),
        _attempts: attempts,
        // Sticky: once force_fallback is on, NEVER switch back to the
        // timed-out primary. First rescue also forces the fallback.
        force_fallback: alreadyForced || attempts >= 1,
      },
      "requeued_stale",
    );
  }

  // Legacy/pre-migration orphans have no started_at at all — every live claim
  // now stamps it, so a 'running' row with started_at IS NULL can only be an
  // orphan. Route each row through the parent-aware RPC so a terminal parent
  // gets 'cancelled_parent_terminal' instead of the row being bulk-flipped
  // back to 'queued' and resurrected under a dead run.
  await requeueLegacyNullStartOrphans(admin, staleCutoff);


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
  if (!userId) return j(401, { error: "Missing or invalid user JWT", version: BUILD_VERSION });

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

    // At most one active run per (project_id, kind). If one exists, return it
    // instead of inserting a duplicate. Ordered by most progress: higher
    // spent_usd first, then older created_at.
    {
      const { data: existingActive } = await admin
        .from("boardroom_runs")
        .select("id, status, spent_usd, created_at")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("kind", kind)
        .in("status", ["queued", "running", "paused", "paused_budget"])
        .order("spent_usd", { ascending: false })
        .order("created_at", { ascending: true });
      if (existingActive && existingActive.length > 0) {
        const winner = existingActive[0];
        return j(200, { run_id: winner.id, status: winner.status, existing: true });
      }
    }

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

    try {
      await createInitialSteps(admin, run);
    } catch (e) {
      if (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge) {
        await admin
          .from("boardroom_runs")
          .update({ status: "failed", error: e.message })
          .eq("id", run.id);
        return j(400, { error: e.message });
      }
      throw e;
    }
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
      const patch: any = { status: "queued", error: null };
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

  if (action === "regenerate_batches") {
    const projectId: string = body?.project_id;
    if (!projectId) return j(400, { error: "Missing project_id" });
    const { data: project } = await admin
      .from("projects")
      .select("id, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (!project || project.user_id !== userId) return j(404, { error: "Project not found" });

    // Refuse if an active batches run is already in flight.
    {
      const { data: activeRuns } = await admin
        .from("boardroom_runs")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("kind", "batches")
        .in("status", ["queued", "running", "paused", "paused_budget"]);
      if (activeRuns && activeRuns.length > 0) {
        return j(409, { error: "A batches run is already in flight. Resume or cancel it before regenerating." });
      }
    }

    // Refuse unless every current batch is completely untouched.
    const { data: currentBatches } = await admin
      .from("batches")
      .select("*")
      .eq("project_id", projectId)
      .order("batch_no", { ascending: true });
    const list = currentBatches ?? [];
    if (!list.length) return j(400, { error: "No batches to regenerate. Run the Chair's batches step from Runway." });
    const touched = list.find((b: any) =>
      b.status !== "pending" ||
      b.sent_at !== null ||
      b.built_at !== null ||
      (b.outcome_md !== null && b.outcome_md !== "") ||
      b.compiled_at !== null,
    );
    if (touched) {
      return j(409, { error: `Batch ${touched.batch_no} has already been touched (status=${touched.status}). Safe regenerate only works when the whole sequence is still untouched.` });
    }
    const batchIds = list.map((b: any) => b.id);
    const { data: refAudits } = await admin
      .from("audits")
      .select("id")
      .in("batch_id", batchIds);
    if (refAudits && refAudits.length > 0) {
      return j(409, { error: "One or more current batches already have audits linked. Cannot safely regenerate." });
    }

    // 1. Archive.
    const { data: archive, error: archErr } = await admin
      .from("batch_generation_archives")
      .insert({
        project_id: projectId,
        user_id: userId,
        batches_json: list,
      })
      .select("id")
      .single();
    if (archErr || !archive) return j(500, { error: `Failed to archive batches: ${archErr?.message ?? "unknown"}` });

    // 2. Delete only the verified-untouched batches.
    const { error: delErr } = await admin
      .from("batches")
      .delete()
      .in("id", batchIds);
    if (delErr) {
      // Nothing was deleted yet — safe to abort. Archive remains for auditability.
      return j(500, { error: `Failed to clear old batches: ${delErr.message}` });
    }

    // 3. Kick off a fresh batches run. On any failure, restore from archive.
    async function restore() {
      await admin.from("batches").insert(
        list.map((b: any) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { id: _oldId, ...rest } = b;
          return rest;
        }),
      );
    }

    const { data: constRow } = await admin
      .from("app_settings")
      .select("version")
      .eq("key", "constitution")
      .maybeSingle();

    const { data: run, error: rerr } = await admin
      .from("boardroom_runs")
      .insert({
        project_id: projectId,
        user_id: userId,
        kind: "batches",
        status: "queued",
        round_no: 1,
        loop_no: 0,
        constitution_version: constRow?.version ?? 1,
        budget_usd: 3.0,
        consensus: { regenerated_from_archive: archive.id },
      })
      .select("*")
      .single();
    if (rerr || !run) {
      await restore();
      return j(500, { error: `Failed to create regen run (restored old batches): ${rerr?.message ?? "unknown"}` });
    }
    try {
      await createInitialSteps(admin, run);
    } catch (e) {
      await admin.from("boardroom_runs").delete().eq("id", run.id);
      await restore();
      const msg = (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge)
        ? e.message
        : `Failed to seed regen run (restored old batches): ${(e as Error).message}`;
      return j(400, { error: msg });
    }
    fireSelfTick();
    return j(200, { run_id: run.id, archived_count: list.length });
  }

  return j(400, { error: "Unknown action" });
}

