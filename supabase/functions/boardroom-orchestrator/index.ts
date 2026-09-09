// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import {
  adminClient,
  BudgetExceeded,
  DailyCapExceeded,
  callSeat,
  decideTransportRequeue,
  isBodyTransportError,
  isRefusal,
  ledgerHasCallId,
  NoUserKey,
  prepareSeatCall,
  ProxyTimeoutError,
  type ProxyResult,
  recordTimeoutEstimate,
  SeatBudgetExceeded,
  SeatUnavailable,
  settleSeatCall,
  settleSeatUsage,
  shouldQuickRetry,
} from "../_shared/openrouter-proxy.ts";
// Batch 17 — Cloudflare executor (spec §2, §5, §9.6). With EXECUTOR_URL /
// EXECUTOR_SECRET unset every import below is inert: executorMode answers
// "inline" without a query and the collector finds no rows to poll.
import {
  buildDispatchSpec,
  executorCancel,
  executorDispatch,
  executorEnvFromDeno,
  executorPoll,
  type PollResult,
} from "../_shared/executor-client.ts";
import { sealApiKey, verifyExecutorRequest } from "../_shared/executor-auth.ts";
import {
  type CallOutput,
  type DispatchLabels,
  EXECUTOR_CALLBACK_PATH,
  type SettleOutcome,
} from "../_shared/executor-protocol.ts";
import {
  budgetPausePatch,
  buildExecutorMeta,
  decideOnPoll,
  errorFromExecutor,
  EXECUTOR_COLLECT_BUDGET_MS,
  EXECUTOR_DEFAULT_IDLE_MS,
  EXECUTOR_GRACE_MS,
  EXECUTOR_UNREACHABLE_BREAKER,
  type ExecutorMeta,
  type ExecutorSettings,
  executorMode,
  executorTimeoutMs,
  fromMeta,
  isWellFormedCallOutput,
  lostRequeueRequest,
  parseExecutorSettings,
  refusalRequeueDecision,
} from "./executor-policy.ts";


import {
  SEATS,
  type Seat,
  candidateForLoop,
  lastCandidateLoop,
  checkConsensus,
  resolveConsensusThreshold,
  resolveSynthesisLoopCap,
  scorecardDecisionEntry,
  voteScorecard,
  validateStepJson,
  normalizeStepJson,
  batchPromptLengthWarnings,
  degradedStepJson,
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
import { BatchContextTooLarge, MarkdownCompactionImpossible, buildValidationRetryRequest, continuationPrefix, joinContinuation } from "../_shared/batch-context.ts";
import { isSmokeRun, keepSmoke, runBudgetUsd } from "../_shared/smoke-mode.ts";
import { repairTruncatedStepJson } from "../_shared/json-extract.ts";
import { acceptStepJson, revalidateStoredStep } from "./accept-json.ts";
import {
  decideConflictOutcome,
  isUniqueViolation,
  type ExistingBatchRow,
  type PlannedBatchRow,
} from "../_shared/batch-persist-idempotency.ts";
import {
  absorbCorrectionStep,
  type Artifact,
  computeAuthorityViolationError,
  enforceAuthorityOrCorrect,
  findAwaitedCorrectionStep,
  loadOwnerAuthority,
} from "../_shared/authority-correction.ts";



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
const BUILD_VERSION = "2026-09-09.executor.r1";

// ============================== Executor config (§9.6) ==============================

// null when either secret is missing → executeStep takes the inline branch
// byte-for-byte and nothing below ever makes a network call.
const EXECUTOR_ENV = executorEnvFromDeno();
const EXECUTOR_SECRET = EXECUTOR_ENV?.secret ?? "";
// The callback the Worker POSTs its result to. CALLBACK_PATH is the ONLY path
// the callback signature is verified against (§5.3): inside a hosted edge
// function the gateway strips /functions/v1, so new URL(req.url).pathname
// would be "/boardroom-orchestrator" and every callback would 401.
const CALLBACK_URL = SELF_URL;
const CALLBACK_PATH = (() => {
  try {
    return new URL(CALLBACK_URL).pathname;
  } catch {
    return EXECUTOR_CALLBACK_PATH;
  }
})();
// Per-isolate optimisation only: after a definitive dispatch rejection (bad
// secret, oversize) skip the POST we know will fail for a minute. Correctness
// never depends on it — every rejected dispatch falls through inline.
let executorBackoffUntil = 0;

// app_settings.executor with the proxy's 30 s module-cache pattern. Missing
// row = disabled. The collector and the callback route never consult it.
// `fresh` bypasses the cache (the Settings card's executor_status, so the
// toggle is reflected at once instead of up to 30 s later).
const EXECUTOR_SETTINGS_TTL_MS = 30_000;
let _executorSettingsCache: { value: ExecutorSettings | null; at: number } | null = null;
async function loadExecutorSettings(admin: any, fresh = false): Promise<ExecutorSettings | null> {
  const now = Date.now();
  if (!fresh && _executorSettingsCache && now - _executorSettingsCache.at < EXECUTOR_SETTINGS_TTL_MS) {
    return _executorSettingsCache.value;
  }
  const { data } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "executor")
    .maybeSingle();
  const value = parseExecutorSettings(data?.value);
  _executorSettingsCache = { value, at: now };
  return value;
}

import {
  auditSeatCoverage,
  decideInfraRequeue,
  failRun,
  hasActiveSteps,
  hasRunningSteps,
  isAbandonedSeed,
  isStepLocalFailure,
  isTransientInfraError,
  seatCapPause,
  planResumeFailed,
  requeueLegacyNullStartOrphans,
  requeueStepIfParentActive,
  resetRequestForResume,
  reverseAuditFailure,
  runStepsPhase,
  STALE_RUNNING_STEP_MS,
  STALLED_RUN_MS,
  sweepOrphanSteps,
  TERMINAL_RUN_STATUSES,
  validationRetryBudget,
  timeoutRequeueRequest,
  staleRequeueRequest,
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
  args: { user_id: string; project_id: string; kind: "stuck_48h" | "audit_loop" | "spend_cap" | "never_locked" | "owner_authority_violation" | "fix_batch_sanitize_empty"; detail?: any },
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

// Executor ownership guard (§0 "no double-write"). Every terminal write on
// the executor path is additionally filtered on executor_call_id = C so two
// settles of the same call converge on one winner. `.match({})` adds no
// filter, so the inline path's requests are byte-identical to before.
type ExecutorGuard = { callId: string } | undefined;
function guardFilter(guard: ExecutorGuard): Record<string, string> {
  return guard ? { executor_call_id: guard.callId } : {};
}

// Payload built by the pure timeoutRequeueRequest (hygiene.ts): reserve
// model, low reasoning, same visible cap.
async function requeueForTimeout(admin: any, step: any, expectCallId?: string): Promise<string> {
  return await requeueStepIfParentActive(
    admin,
    step.id,
    timeoutRequeueRequest(step.request),
    "timeout_failover",
    expectCallId,
  );
}

// Body-stream/transport failure on a 2xx OpenRouter response. Fresh retry on
// the SAME model (transport is not a model-quality signal); one retry max —
// caller already decided that via decideTransportRequeue.
async function requeueForBodyTransport(admin: any, step: any, attempts: number, expectCallId?: string): Promise<string> {
  return await requeueStepIfParentActive(
    admin,
    step.id,
    {
      ...(step.request ?? {}),
      _transport_attempts: attempts,
    },
    "body_transport_requeued",
    expectCallId,
  );
}

async function requeueForValidation(
  admin: any,
  run: any,
  step: any,
  baseMessages: any[],
  assistantContent: string,
  validationError: string,
  truncated: boolean,
  continuation = false,
  expectCallId?: string,
): Promise<string> {
  const attempts = Number(step.request?._validation_attempts ?? 0) + 1;
  try {
    const { request: newRequest, mode } = buildValidationRetryRequest({
      stepKey: String(step.step_key ?? ""),
      baseRequest: step.request ?? {},
      baseMessages,
      assistantContent,
      validationError,
      truncated,
      continuation,
      correction: correctionForStep(step.step_key, { isImport: step.request?._is_import === true ? true : step.request?._is_import === false ? false : undefined }),
    });
    // The correction pass used to re-send the identical max_tokens / effort
    // that just failed, so a reasoning-eaten cap failed identically and the
    // second miss killed the run. Force low reasoning on every retry and,
    // when the output was truncated, widen the visible cap (bounded so the
    // call still finishes inside the proxy abort). Applied HERE, not in
    // buildValidationRetryRequest, which stays a pure message builder.
    // A markdown continuation keeps its visible cap: only the remainder is
    // requested, and a bounded "widening" could SHRINK a draft's cap (8,000 ->
    // 6,000) and re-cut a genuinely long document.
    const bumped = continuation ? { reasoning_effort: "low" as const } : validationRetryBudget(step, truncated);
    return await requeueStepIfParentActive(
      admin,
      step.id,
      {
        ...newRequest,
        ...bumped,
        _validation_attempts: attempts,
        _validation_retry_mode: mode,
      },
      truncated ? "truncated_output_requeued" : "invalid_json_requeued",
      expectCallId,
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
        .eq("status", "running")
        .match(guardFilter(expectCallId ? { callId: expectCallId } : undefined));
      await failRun(admin, run, e.message);
      return "cancelled_parent_terminal";
    }
    throw e;
  }
}


// The catch block of executeStep, moved verbatim (Batch 17, §9.6) so the
// executor settle path (settleExecutorStep) and the deadline backstop reuse
// the same pause / fail / requeue branches. `opts.guard` adds the executor
// ownership filter to every terminal step write and the ownership token to
// every requeue; with `quickRetryAllowed` the pre-response/429/5xx branch
// answers "quick_retry" and the inline loop retries in place, otherwise
// (executor) it requeues the step once via executorQuickRequeue.
async function handleCallFailure(
  admin: any,
  run: any,
  step: any,
  e: unknown,
  opts: { quickRetryAllowed: boolean; guard?: { callId: string } },
): Promise<"quick_retry" | void> {
      if (e instanceof DailyCapExceeded) {
        const capCopy =
          `Daily spend cap hit — ${e.scope} scope. ` +
          `Cap $${Number(e.cap).toFixed(2)}, spent $${Number(e.spent).toFixed(2)}. ` +
          `Resets at 00:00 UTC or an admin can raise the cap in Settings.`;
        await admin.from("run_steps").update({ status: "queued", error: "daily_cap" }).eq("id", step.id).in("status", budgetPausePatch("daily_cap").stepGuard).match(guardFilter(opts.guard));
        await admin.from("boardroom_runs").update({ status: "paused_budget", error: capCopy }).eq("id", run.id).in("status", budgetPausePatch("daily_cap").runGuard);
        if (opts.guard) await clearExecutorColumns(admin, step.id, opts.guard.callId);
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
        await admin.from("run_steps").update({ status: "queued", error: "budget" }).eq("id", step.id).in("status", budgetPausePatch("budget").stepGuard).match(guardFilter(opts.guard));
        await admin.from("boardroom_runs").update({ status: "paused_budget", error: budgetCopy }).eq("id", run.id).in("status", budgetPausePatch("budget").runGuard);
        if (opts.guard) await clearExecutorColumns(admin, step.id, opts.guard.callId);
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
      // Per-seat cap (model_registry.max_cost_per_run): pause exactly like
      // the run budget instead of failing the run. The proxy re-checks the
      // cap before every call, so resuming with the cap unchanged pauses
      // again without spending (RC-10).
      if (e instanceof SeatBudgetExceeded) {
        const pause = seatCapPause(e, run);
        await admin.from("run_steps").update(pause.step).eq("id", step.id).in("status", budgetPausePatch("seat_cap").stepGuard).match(guardFilter(opts.guard));
        await admin.from("boardroom_runs").update(pause.run).eq("id", run.id).in("status", budgetPausePatch("seat_cap").runGuard);
        if (opts.guard) await clearExecutorColumns(admin, step.id, opts.guard.callId);
        if (run.project_id && run.user_id) {
          await insertAlert(admin, {
            user_id: run.user_id,
            project_id: run.project_id,
            kind: "spend_cap",
            detail: pause.alert,
          });
        }
        return;
      }
      if (e instanceof NoUserKey || e instanceof SeatUnavailable) {
        await admin
          .from("run_steps")
          .update({ status: "failed", error: (e as Error).message, completed_at: new Date().toISOString() })
          .eq("id", step.id)
          .eq("status", "running")
          .match(guardFilter(opts.guard));
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
            .eq("status", "running")
            .match(guardFilter(opts.guard));
          // An audit map chunk fails alone; the merge reports the gap (RC-2).
          if (isStepLocalFailure(run, step)) { fireSelfTick(); return; }
          await failRun(admin, run, tmsg);
          return;
        }
        const outcome = await requeueForTimeout(admin, step, opts.guard?.callId);
        if (outcome === "cancelled_parent_terminal" || outcome === "stale_call") {
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
          const outcome = await requeueForBodyTransport(admin, step, decision.attempts, opts.guard?.callId);
          if (outcome === "cancelled_parent_terminal" || outcome === "stale_call") {
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
          .eq("status", "running")
          .match(guardFilter(opts.guard));
        if (isStepLocalFailure(run, step)) { fireSelfTick(); return; }
        await failRun(admin, run, decision.message);
        return;
      }
      // Strictly classified quick retry: ONLY pre-response network failures,
      // 429, or 5xx. Any other 4xx, validation, budget, or unexpected error
      // fails the step immediately — no blind same-invocation retry.
      if (shouldQuickRetry(e)) {
        if (opts.quickRetryAllowed) return "quick_retry";
        // Executor path (§5.4 step 3): the analogue of the 800 ms in-invocation
        // retry is ONE requeue with _executor_errors+1; a second falls through
        // to the generic failed branch below.
        if (opts.guard && Number(step.request?._executor_errors ?? 0) < 1) {
          await executorQuickRequeue(admin, step, opts.guard.callId, e as Error);
          return;
        }
      }
      const msg = (e as Error).message ?? String(e);
      console.log(`[exec] ERROR step=${step.step_key} run=${run.id} msg=${msg}`);
      // A database RPC failing around the call (the cost ledger after the
      // model answered) is not a verdict on the step: requeue fresh on the
      // same model, bounded by INFRA_REQUEUE_MAX, instead of failing the run.
      if (isTransientInfraError(msg)) {
        const decision = decideInfraRequeue(step);
        console.log(`[exec] INFRA step=${step.step_key} run=${run.id} decision=${decision.action} attempts=${decision.attempts}`);
        if (decision.action === "requeue") {
          const outcome = await requeueStepIfParentActive(admin, step.id, decision.request, "infra_requeued", opts.guard?.callId);
          if (outcome === "cancelled_parent_terminal" || outcome === "stale_call") {
            console.log(`[exec] INFRA step=${step.step_key} parent already terminal — step cancelled`);
          }
          return;
        }
      }
      await admin
        .from("run_steps")
        .update({ status: "failed", error: msg, completed_at: new Date().toISOString() })
        .eq("id", step.id)
        .eq("status", "running")
        .match(guardFilter(opts.guard));
      if (isStepLocalFailure(run, step)) { fireSelfTick(); return; }
      await failRun(admin, run, msg);
      return;
}

// The success half of executeStep, moved verbatim (Batch 17, §9.6): JSON
// acceptance, correction pass, continuation, degraded and terminal writes.
// Reached inline with the ProxyResult callSeat produced, and from
// settleExecutorStep with the ProxyResult settleSeatCall produced from the
// Workflow's stored output — the two are indistinguishable here. `guard`
// adds the executor ownership filter to every terminal write and the
// ownership token to every requeue.
async function settleStepResult(
  admin: any,
  run: any,
  step: any,
  result: ProxyResult,
  baseMessages: any[],
  guard?: { callId: string },
): Promise<void> {
  const jsonMode = !!step.request?.json_output;
    // Success path — the model answered. Validate structured output.
    const content = result.content;
    const usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd };
    const fallbackMeta = result.fallback ?? null;
    // Persisted on every step so a truncation is diagnosable from the row
    // alone (finish_reason + how much of the wire cap the thinking consumed).
    const outputMeta = {
      finish_reason: result.finishReason ?? null,
      tokens_out: usage.tokensOut,
      reasoning_tokens: Number(result.reasoningTokens ?? 0) || 0,
      wire_max_tokens: Number(result.wireMaxTokens ?? 0) || 0,
      // The model that actually answered. A smoke run borrows the smoke (or
      // inspector) row's model for every seat, so the row must say which.
      model: result.model ?? null,
      ...(result.smokeSource ? { smoke_model_source: result.smokeSource } : {}),
    };

    if (jsonMode) {
      // Parse -> recover -> extract -> tail-close -> normalize/validate, shared
      // with the resume paths (accept-json.ts). The attempt count decides the
      // soft batch-length rule: a code prompt above the target maximum is an
      // error on the first answer only and a warning on the correction pass.
      const validationAttempts = Number(step.request?._validation_attempts ?? 0);
      const accepted = acceptStepJson(step.step_key, content, run.kind, { attempt: validationAttempts });
      const candidate: any = accepted.candidate;
      const tailClosed: string | null = accepted.tailClosed;
      const recoveryMode: string | null = accepted.recoveryMode;
      let lengthWarning = accepted.lengthWarning;
      let normalized: { value: any; error: string | null } = { value: accepted.value, error: accepted.error };
      let err = normalized.error;
      let repairedMeta: { mode: string; dropped_chars: number } | null = null;
      if (err) {
        // Detect truncation: the proxy's budgetExhausted signal (provider
        // finish_reason of length/max_tokens OR completion tokens at the wire
        // cap), OR — secondary heuristics — unparseable JSON whose content is
        // close to the requested visible max_tokens ceiling (>=95% of
        // max_tokens * ~4 chars/token), OR completion tokens at >=90% of the
        // wire cap. The last one catches a reasoning-eaten budget: 300 visible
        // chars out of 2,500 tokens never trips the chars heuristic, and some
        // providers still report "stop" after cutting at the cap.
        const maxTokens = Number(step.request?.max_tokens) > 0 ? Number(step.request.max_tokens) : 0;
        const nearMax = !candidate && maxTokens > 0 && content.length >= Math.floor(maxTokens * 4 * 0.95);
        const wireMax = outputMeta.wire_max_tokens;
        const nearWireCap = !candidate && wireMax > 0 && usage.tokensOut >= Math.floor(wireMax * 0.9);
        const truncated = !!result.budgetExhausted || nearMax || nearWireCap;

        // Invocation-safe correction: NEVER mark completed with invalid output
        // and NEVER make two long model calls in one invocation. Queue the
        // correction into a fresh invocation, exactly one retry before failing.
        if (validationAttempts >= 1 && truncated) {
          // Last resort, AFTER the widened correction pass also came back
          // cut: keep the complete elements of a count-tolerant list step
          // (audit map / merge findings, batch plans above the contract
          // minimum) rather than fail the run. Allow-list and minimum-count
          // guard live in repairTruncatedStepJson; the repaired value must
          // still pass the same normalize/validate gate as a clean answer.
          const repaired = repairTruncatedStepJson(step.step_key, content, {
            isImport: step.request?._is_import === true,
          });
          if (repaired.ok) {
            const again = normalizeStepJson(step.step_key, repaired.value, run.kind, { attempt: validationAttempts });
            if (!again.error) {
              normalized = again;
              err = null;
              lengthWarning = batchPromptLengthWarnings(step.step_key, again.value, validationAttempts);
              repairedMeta = { mode: "truncation_cut", dropped_chars: repaired.dropped_chars };
              console.log(`[exec] REPAIRED step=${step.step_key} run=${run.id} dropped_chars=${repaired.dropped_chars}`);
            } else {
              console.log(`[exec] REPAIR_REJECTED step=${step.step_key} run=${run.id} reason=${again.error}`);
            }
          } else {
            console.log(`[exec] REPAIR_REFUSED step=${step.step_key} run=${run.id} reason=${repaired.reason}`);
          }
        }
        if (err && validationAttempts >= 1) {
          const vmsg = `Step ${step.step_key} produced invalid JSON after one correction pass: ${err}`;
          // A dead vote or reviewer degrades (fails that loop's consensus /
          // counts as an empty review) instead of cancelling every paid
          // sibling; chair steps and everything else stay run-fatal.
          const degraded = degradedStepJson(step.step_key, err);
          if (degraded) {
            console.log(`[exec] DEGRADED step=${step.step_key} run=${run.id} err=${err}`);
            await admin
              .from("run_steps")
              .update({
                status: "completed",
                response_text: content,
                response_json: {
                  ...degraded,
                  _meta: { ...outputMeta, ...(fallbackMeta ? { fallback: fallbackMeta } : {}), ...(degraded._meta as any) },
                },
                tokens_in: usage.tokensIn,
                tokens_out: usage.tokensOut,
                cost_usd: usage.costUsd,
                completed_at: new Date().toISOString(),
              })
              .eq("id", step.id)
              .eq("status", "running")
              .match(guardFilter(guard));
            return;
          }
          await admin
            .from("run_steps")
            .update({
              status: "failed",
              error: truncated ? "truncated_after_correction" : "invalid_json_after_correction",
              response_text: content,
              response_json: { _meta: { ...outputMeta, ...(fallbackMeta ? { fallback: fallbackMeta } : {}) } },
              tokens_in: usage.tokensIn,
              tokens_out: usage.tokensOut,
              cost_usd: usage.costUsd,
              completed_at: new Date().toISOString(),
            })
            .eq("id", step.id)
            .eq("status", "running")
            .match(guardFilter(guard));
          if (isStepLocalFailure(run, step)) { fireSelfTick(); return; }
          await failRun(admin, run, vmsg);
          return;
        }
        if (err) {
          const vOutcome = await requeueForValidation(admin, run, step, baseMessages, content, err, truncated, false, guard?.callId);
          if (vOutcome === "cancelled_parent_terminal" || vOutcome === "stale_call") {
            console.log(`[exec] VALIDATION step=${step.step_key} parent already terminal — step cancelled`);
          }
          return;
        }
      }
      let parsed: any = normalized.value;
      if (!parsed || typeof parsed !== "object") parsed = {};
      parsed._meta = {
        ...(parsed._meta ?? {}),
        ...outputMeta,
        ...(fallbackMeta ? { fallback: fallbackMeta } : {}),
        ...(tailClosed ? { tail_closed: tailClosed } : {}),
        ...(recoveryMode ? { recovery_mode: recoveryMode } : {}),
        ...(repairedMeta ? { repaired: repairedMeta } : {}),
        ...(lengthWarning.length ? { length_warning: lengthWarning } : {}),
      };
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
        .eq("status", "running")
        .match(guardFilter(guard));
      return;
    }

    // Non-JSON free-markdown path. A draft cut at the budget used to complete
    // as-is and become the locked plan verbatim (RC-4). Now: one continuation
    // pass in a fresh invocation (text so far replayed, low reasoning, same
    // cap), joined here on completion; a continuation that is itself cut
    // completes with what exists and is stamped truncated for the UI.
    const validationAttempts = Number(step.request?._validation_attempts ?? 0);
    if (result.budgetExhausted && validationAttempts === 0) {
      console.log(`[exec] TRUNCATED_MARKDOWN step=${step.step_key} run=${run.id} chars=${content.length} — queueing continuation`);
      const cOutcome = await requeueForValidation(admin, run, step, baseMessages, content, "truncated markdown", true, true, guard?.callId);
      if (cOutcome === "cancelled_parent_terminal" || cOutcome === "stale_call") {
        console.log(`[exec] TRUNCATED_MARKDOWN step=${step.step_key} parent already terminal — step cancelled`);
      }
      return;
    }
    const prefix = continuationPrefix(step.request);
    const fullText = prefix ? joinContinuation(prefix, content) : content;
    const stillCut = !!result.budgetExhausted && validationAttempts >= 1;
    if (stillCut) console.log(`[exec] TRUNCATED_MARKDOWN step=${step.step_key} run=${run.id} continuation also cut — completing with ${fullText.length} chars`);
    await admin
      .from("run_steps")
      .update({
        status: "completed",
        response_text: fullText,
        response_json: {
          _meta: {
            ...outputMeta,
            ...(fallbackMeta ? { fallback: fallbackMeta } : {}),
            ...(prefix ? { continued: true, continuation_prefix_chars: prefix.length } : {}),
            ...(stillCut ? { truncated: true } : {}),
          },
        },
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        cost_usd: usage.costUsd,
        completed_at: new Date().toISOString(),
      })
      .eq("id", step.id)
      .eq("status", "running")
      .match(guardFilter(guard));
    return;
}


async function executeStep(admin: any, run: any, step: any) {
  const baseMessages = step.request?.messages ?? [];
  const jsonMode = !!step.request?.json_output;
  console.log(`[exec] start step=${step.step_key} seat=${step.seat} run=${run.id}`);

  // Batch 17 mode switch (§4, §5.1): with the executor configured AND
  // enabled for this step, dispatch the prepared call to the Cloudflare
  // Worker and return with the row still 'running' (executor_call_id set);
  // the settle path finishes it. A definitive dispatch rejection falls
  // through to today's inline call in the same invocation. With no
  // EXECUTOR_URL / EXECUTOR_SECRET this block is skipped without a query.
  if (EXECUTOR_ENV) {
    const setting = await loadExecutorSettings(admin);
    if (executorMode(EXECUTOR_ENV, setting, run, step) === "executor" && Date.now() >= executorBackoffUntil) {
      const d = await dispatchStepToExecutor(admin, run, step);
      if (d !== "fallthrough_inline") return;
    }
  }

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
          smoke: isSmokeRun(run),
        }),
        STEP_HARD_TIMEOUT_MS,
        step.step_key,
      );
    } catch (e) {
      if (await handleCallFailure(admin, run, step, e, { quickRetryAllowed: networkAttempt === 0 }) === "quick_retry") {
        networkAttempt++;
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      return;
    }
    await settleStepResult(admin, run, step, result, baseMessages);
    return;
  }
}


// ============================== Executor path (Batch 17, §5, §9.6) ==============================

// The inline seatOptions, shared by the executor dispatch so prepareSeatCall
// runs exactly the checks and builds exactly the body callSeat would.
function seatOptionsFor(run: any, step: any) {
  return {
    runId: run.id,
    projectId: run.project_id,
    temperature: Number(step.request?.temperature ?? 0.4),
    reasoningEffort: step.request?.reasoning_effort,
    json: !!step.request?.json_output,
    forceFallback: !!step.request?.force_fallback,
    maxTokens: Number(step.request?.max_tokens) > 0 ? Number(step.request.max_tokens) : undefined,
    smoke: isSmokeRun(run),
  };
}

// RPC reserve_executor_call: CAS on status='running' AND executor_call_id IS
// NULL → `<step_id>-<n>`; null when the row is not reservable (already
// dispatched, moved on, missing). The reservation lands BEFORE the network
// call so an isolate death between the two leaves a resumable row, never an
// untracked instance (§5.1 b).
async function reserveExecutorCall(admin: any, stepId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("reserve_executor_call", { p_step_id: stepId });
  if (error) throw new Error(`reserve_executor_call failed: ${error.message ?? error}`);
  return typeof data === "string" && data.length ? data : null;
}

// Guarded on the id: a row that has since been re-reserved is left alone.
async function clearExecutorColumns(admin: any, stepId: string, callId: string): Promise<void> {
  const { error } = await admin
    .from("run_steps")
    .update({ executor_call_id: null, executor_dispatched_at: null, executor_meta: null })
    .eq("id", stepId)
    .eq("executor_call_id", callId);
  if (error) console.error(`[exec] clearExecutorColumns failed step=${stepId} call=${callId}: ${error.message ?? error}`);
}

// Best-effort mark so the Settings card and §13 can prove the fast path is
// alive: a card that only ever shows `poll` means callbacks are rejected.
async function writeExecutorSettleMark(admin: any, source: "callback" | "poll", callId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await admin
      .from("app_settings")
      .upsert({ key: "executor_last_settle", value: { source, call_id: callId, at: now }, updated_at: now }, { onConflict: "key" });
    if (error) console.error(`[exec] settle mark write failed: ${error.message ?? error}`);
  } catch (e) {
    console.error(`[exec] settle mark write failed: ${(e as Error)?.message ?? e}`);
  }
}

// §5.1: prepare (today's pre-checks + body) → reserve → meta → seal → POST.
//   dispatched          the Worker holds the call; the row stays 'running' with executor_call_id set
//   skipped             nothing reservable / nothing written that needs handling
//   fallthrough_inline  definitive rejection: columns cleared, caller runs the inline call now
//   handled             a pre-check threw and handleCallFailure paused/failed/requeued the step
// `existingCallId` is the collector's re-dispatch (§5.6 `redispatch`): same
// id (Worker create({id}) is idempotent), prep rebuilt from the row.
async function dispatchStepToExecutor(
  admin: any,
  run: any,
  step: any,
  existingCallId?: string,
): Promise<"dispatched" | "skipped" | "fallthrough_inline" | "handled"> {
  const env = EXECUTOR_ENV;
  if (!env) return "skipped";
  const baseMessages = step.request?.messages ?? [];
  const guard = existingCallId ? { callId: existingCallId } : undefined;

  // a. today's pre-checks and body. Any thrown cap / key / seat error goes to
  //    the same catch block the inline path uses.
  let prep: Awaited<ReturnType<typeof prepareSeatCall>>;
  try {
    prep = await prepareSeatCall(run.user_id, step.seat as Seat, baseMessages, seatOptionsFor(run, step));
  } catch (e) {
    await handleCallFailure(admin, run, step, e, { quickRetryAllowed: false, guard });
    return "handled";
  }

  // b. reserve the call id (CAS) before anything leaves this function.
  let callId = existingCallId ?? null;
  if (!callId) {
    callId = await reserveExecutorCall(admin, step.id);
    if (!callId) {
      console.log(`[exec] EXECUTOR_RESERVE_SKIPPED step=${step.step_key} run=${run.id} — row not reservable`);
      return "skipped";
    }
  }

  // c. per-dispatch facts the settle needs (never the key, never the messages).
  const setting = await loadExecutorSettings(admin);
  const transport = setting?.transport ?? "sse";
  const timeoutMs = executorTimeoutMs(prep.modelId, step.request?.reasoning_effort, setting?.timeouts_ms);
  const meta = buildExecutorMeta(prep, callId, timeoutMs, transport, new Date().toISOString(), BUILD_VERSION, !!step.request?.force_fallback);
  if (existingCallId) {
    // A re-dispatch is attempt ≥ 2 even when the first attempt died before
    // its meta write (executor_meta NULL), so EXECUTOR_DISPATCH_MAX counts
    // real attempts; and the deadline stays anchored at the ORIGINAL
    // dispatch (kept from the prior meta, else rebuilt from
    // executor_dispatched_at — the same fallback decideOnPoll applies) so a
    // re-dispatch never extends the wait past dispatched_at + timeout + grace.
    meta.dispatch_attempts = Math.max(1, Number(step.executor_meta?.dispatch_attempts ?? 0) || 0) + 1;
    const priorDeadline = step.executor_meta?.deadline_at;
    const dispatchedAt = Date.parse(String(step.executor_dispatched_at ?? ""));
    if (typeof priorDeadline === "string" && Number.isFinite(Date.parse(priorDeadline))) {
      meta.deadline_at = priorDeadline;
    } else if (Number.isFinite(dispatchedAt)) {
      meta.deadline_at = new Date(dispatchedAt + timeoutMs + EXECUTOR_GRACE_MS).toISOString();
    }
  }
  const { error: metaErr } = await admin
    .from("run_steps")
    .update({ executor_meta: meta })
    .eq("id", step.id)
    .eq("executor_call_id", callId);
  if (metaErr) {
    // The reservation stands and no instance exists: the collector sees
    // not_found and re-dispatches with the same id next tick.
    console.error(`[exec] EXECUTOR_META_WRITE_FAILED step=${step.step_key} call=${callId}: ${metaErr.message ?? metaErr}`);
    return "skipped";
  }

  // d. seal the key to this call id and POST.
  const sealed = await sealApiKey(env.secret, callId, prep.apiKey);
  const labels: DispatchLabels = {
    run_id: String(run.id),
    step_id: String(step.id),
    step_key: String(step.step_key ?? ""),
    seat: String(step.seat ?? ""),
    smoke: isSmokeRun(run),
  };
  const spec = buildDispatchSpec(prep, callId, labels, timeoutMs, EXECUTOR_DEFAULT_IDLE_MS, transport, sealed, CALLBACK_URL, BUILD_VERSION);
  const outcome = await executorDispatch(env, spec);

  // e. decideDispatchResponse already classified the answer.
  if (outcome.kind === "accepted") {
    console.log(`[exec] EXECUTOR_DISPATCHED step=${step.step_key} run=${run.id} call=${callId} model=${prep.modelId} timeout_ms=${timeoutMs} created=${outcome.created} attempt=${meta.dispatch_attempts}`);
    return "dispatched";
  }
  if (outcome.kind === "rejected") {
    console.log(`[exec] executor_dispatch_rejected step=${step.step_key} run=${run.id} call=${callId} reason=${outcome.status}${outcome.detail ? ` ${outcome.detail}` : ""}`);
    executorBackoffUntil = Date.now() + 60_000;
    if (existingCallId) {
      // Re-dispatch from the collector: no inline step may run inside the
      // collector, so the row is requeued (columns NULLed by the RPC) and the
      // next claim runs inline while the backoff holds.
      const lost = lostRequeueRequest(step.request);
      const r = await requeueStepIfParentActive(admin, step.id, lost.request, "executor_dispatch_rejected", callId);
      if (r !== "requeued") await clearExecutorColumns(admin, step.id, callId);
      return "handled";
    }
    await clearExecutorColumns(admin, step.id, callId);
    return "fallthrough_inline";
  }
  // Ambiguous (5xx, fetch timeout, socket cut after send): keep the
  // reservation; the collector polls next tick and re-dispatches on not_found.
  console.log(`[exec] EXECUTOR_DISPATCH_AMBIGUOUS step=${step.step_key} run=${run.id} call=${callId} msg=${outcome.message}`);
  return "dispatched";
}

// The executor analogue of the 800 ms in-invocation quick retry: one requeue
// with _executor_errors+1 (a second falls to the generic failed branch).
async function executorQuickRequeue(admin: any, step: any, callId: string, e: Error): Promise<void> {
  const n = (Number(step.request?._executor_errors ?? 0) || 0) + 1;
  console.log(`[exec] EXECUTOR_QUICK_REQUEUE step=${step.step_key} call=${callId} errors=${n} msg=${e?.message ?? e}`);
  const outcome = await requeueStepIfParentActive(
    admin,
    step.id,
    { ...(step.request ?? {}), _executor_errors: n },
    "executor_quick_requeue",
    callId,
  );
  if (outcome === "cancelled_parent_terminal" || outcome === "stale_call") {
    console.log(`[exec] EXECUTOR_QUICK_REQUEUE step=${step.step_key} outcome=${outcome} — nothing written`);
  }
}

// §5.10 stale_ledgered rule. The row has moved on (requeued, retried,
// re-claimed) so its executor_meta is NULL — the ledger args come from the
// row's seat column, the run row and the callback itself. One lookup covers
// both keys so a deadline estimate already charged for this call is never
// joined by the real row (§7: one row per call, never both).
async function ledgerStaleExecutorResult(
  admin: any,
  run: { id: string; user_id: string; project_id: string | null },
  step: { id: string; seat: string },
  callId: string,
  output: CallOutput & { ok: true },
): Promise<"stale" | "stale_ledgered"> {
  if (await ledgerHasCallId(admin, [callId, `${callId}:timeout`])) return "stale";
  const model = String(output.model ?? output.response?.model ?? "unknown");
  const { tokensIn, tokensOut, costUsd } = settleSeatUsage(model, output.response?.usage ?? {});
  const { error } = await admin.rpc("record_model_call_idempotent", {
    p_user_id: run.user_id,
    p_project_id: run.project_id ?? null,
    p_run_id: run.id,
    p_seat: step.seat,
    p_model_id: model,
    p_tokens_in: tokensIn,
    p_tokens_out: tokensOut,
    p_cost_usd: costUsd,
    p_call_id: callId,
  });
  if (error) throw new Error(`record_model_call_idempotent failed: ${error.message ?? error}`);
  console.log(`[exec] EXECUTOR_STALE_LEDGERED step=${step.id} call=${callId} model=${model} cost=${costUsd}`);
  return "stale_ledgered";
}

// What a settle did, read back from the row (the moved bodies return void).
async function settleOutcomeFromRow(admin: any, stepId: string, runId: string): Promise<SettleOutcome> {
  const { data: after } = await admin.from("run_steps").select("status").eq("id", stepId).maybeSingle();
  const status = String(after?.status ?? "");
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "queued") {
    const fresh = await getRun(admin, runId);
    return fresh?.status === "paused_budget" ? "budget_pause" : "requeued";
  }
  return "stale";
}

// §5.4 — reachable from the signed callback (fast path) and from the tick
// collector (guarantee). Every write is idempotent or guarded on
// status='running' AND executor_call_id = C, so two settles of the same
// call converge on one winner without a lease.
async function settleExecutorStep(
  admin: any,
  ref: { stepId: string; callId: string },
  output: CallOutput,
  source: "callback" | "poll",
): Promise<SettleOutcome> {
  const { stepId, callId } = ref;
  const { data: step } = await admin.from("run_steps").select("*").eq("id", stepId).maybeSingle();
  if (!step) {
    console.log(`[exec] EXECUTOR_SETTLE step=${stepId} call=${callId} source=${source} — step row missing`);
    return "stale";
  }
  const run = await getRun(admin, step.run_id);
  if (!run) {
    console.log(`[exec] EXECUTOR_SETTLE step=${stepId} call=${callId} source=${source} — run row missing`);
    return "stale";
  }

  // 1. Ownership. A different (or NULL) id means the row moved on; the only
  //    question left is money (§5.10).
  if (step.executor_call_id !== callId) {
    console.log(`[exec] EXECUTOR_SETTLE_STALE step=${step.step_key} call=${callId} row_call=${step.executor_call_id ?? "null"} source=${source}`);
    if (output.ok === true) {
      const r = await ledgerStaleExecutorResult(admin, run, step, callId, output);
      if (r === "stale_ledgered") await writeExecutorSettleMark(admin, source, callId);
      return r;
    }
    return "stale";
  }

  const meta = (step.executor_meta ?? null) as ExecutorMeta | null;
  let outcome: SettleOutcome;

  if (!meta || !meta.model_id) {
    // Unreachable in practice (the meta write precedes the POST); never
    // crash on it: ledger real usage from the row + callback, then release
    // the row the way a lost call is released (a requeued row falls through
    // to step 4 so it is advanced now, not on the next cron tick).
    console.error(`[exec] EXECUTOR_SETTLE step=${step.step_key} call=${callId} has no executor_meta — treating as lost`);
    if (output.ok === true) await ledgerStaleExecutorResult(admin, run, step, callId, output);
    if (step.status === "running") {
      const r = await requeueStepIfParentActive(admin, step.id, lostRequeueRequest(step.request).request, "executor_call_lost", callId);
      outcome = r === "requeued" ? "requeued" : "ledger_only";
    } else {
      await clearExecutorColumns(admin, step.id, callId);
      outcome = "ledger_only";
    }
  } else if (output.ok === true) {
    // 2a. Parse + ledger (idempotent on call_id). An RPC error throws before
    //     anything else is written: callback 500 / collector log, retried.
    //     If the deadline backstop has already charged <C>:timeout it owns
    //     this call (§7: one row per call, never both) — the late real
    //     output is dropped, exactly as inline drops the usage of an aborted
    //     fetch. But this branch must NEVER leave a running row in place:
    //     the backstop may have died between its estimate and its
    //     handleCallFailure (a transient requeue RPC error), the cancel may
    //     have been unreachable, and the instance has since completed — so
    //     every later poll answers `complete` (which beats the deadline
    //     clock in decideOnPoll) and lands here. Give the row the
    //     backstop's own exit instead: the timeout branch (requeue via
    //     timeout_failover, or timeout_failover_exhausted) for a running
    //     row, a column clear for a finished one. No <C> insert either way.
    if (await ledgerHasCallId(admin, [`${callId}:timeout`])) {
      console.log(`[exec] EXECUTOR_SETTLE_AFTER_DEADLINE step=${step.step_key} call=${callId} source=${source} status=${step.status} — estimate already charged, output dropped`);
      if (step.status !== "running") {
        await clearExecutorColumns(admin, step.id, callId);
        outcome = "ledger_only";
      } else {
        const e = new ProxyTimeoutError(meta.model_id, Number(meta.timeout_ms) || 0);
        await handleCallFailure(admin, run, step, e, { quickRetryAllowed: false, guard: { callId } });
        await clearExecutorColumns(admin, step.id, callId);
        outcome = await settleOutcomeFromRow(admin, step.id, run.id);
      }
    } else {
      const p = fromMeta(meta, run, step);
      const fallbackReason = meta.force_fallback && step.request?._refusal_fallback === true ? "refusal" as const : undefined;
      const result = await settleSeatCall(admin, p, output.response, { callId, ...(fallbackReason ? { fallbackReason } : {}) });
      // 2b. Cancelled / swept / paused-then-cancelled: the money was real, the
      //     verdict is not wanted.
      if (step.status !== "running") {
        await clearExecutorColumns(admin, step.id, callId);
        console.log(`[exec] EXECUTOR_SETTLE_LEDGER_ONLY step=${step.step_key} call=${callId} status=${step.status} cost=${result.costUsd}`);
        outcome = "ledger_only";
      } else {
        // 2c. Refusal mirror (§5.7) — the same 15 s rule callSeat honours.
        const refused = isRefusal(result.content, result.finishReason, meta.json);
        const rd = refused
          ? refusalRequeueDecision(step.request, Number(output.latency_ms ?? 0), meta.fallback_allowed)
          : { action: "accept" as const };
        if (rd.action === "requeue") {
          console.log(`[exec] EXECUTOR_REFUSAL step=${step.step_key} call=${callId} → ${rd.error}`);
          const r = await requeueStepIfParentActive(admin, step.id, rd.request, rd.error, callId);
          outcome = r === "requeued" ? "refusal_requeued" : "stale";
        } else {
          // 2d. Today's success half, guarded.
          await settleStepResult(admin, run, step, result, step.request?.messages ?? [], { callId });
          outcome = await settleOutcomeFromRow(admin, step.id, run.id);
        }
      }
    }
  } else {
    const p = fromMeta(meta, run, step);
    // 3. Classified failure → the proxy's own error shapes → today's catch block.
    const e = errorFromExecutor(output.error);
    if (output.error?.kind === "timeout" || output.error?.kind === "idle") {
      await recordTimeoutEstimate(admin, p, { callId, suffix: ":timeout" });
    }
    if (step.status !== "running") {
      await clearExecutorColumns(admin, step.id, callId);
      console.log(`[exec] EXECUTOR_SETTLE_LEDGER_ONLY step=${step.step_key} call=${callId} status=${step.status} kind=${output.error?.kind}`);
      outcome = "ledger_only";
    } else {
      await handleCallFailure(admin, run, step, e, { quickRetryAllowed: false, guard: { callId } });
      outcome = await settleOutcomeFromRow(admin, step.id, run.id);
    }
  }

  // Release the row once the owning settle terminalised it (guarded on the
  // id): a late duplicate delivery then lands in the stale branch and finds
  // <C> in the ledger, in_flight is honest, and the collector never selects
  // the row again — no ledger-only re-settle, no second estimate at the
  // deadline, no self-tick per already-settled row.
  if (outcome === "completed" || outcome === "failed") await clearExecutorColumns(admin, step.id, callId);

  // 4. Mirrors processRun: a paused / paused_budget run gets its step settled
  //    but is not advanced; resume's tick advances it. A ledger-only settle
  //    changed nothing about the run (the row was already terminal), but it
  //    still proves the path is alive (§5.3), so the mark is written for
  //    every settle that wrote something.
  if (outcome !== "ledger_only") {
    const fresh = await getRun(admin, run.id);
    if (fresh?.status === "running") await afterStepComplete(admin, fresh);
  }
  await writeExecutorSettleMark(admin, source, callId);
  console.log(`[exec] EXECUTOR_SETTLED step=${step.step_key} run=${run.id} call=${callId} source=${source} outcome=${outcome}`);
  return outcome;
}

// §5.6 `deadline`: dispatched_at + timeout + grace has passed and the Worker
// has not reported completion (or cannot be reached, or the env is gone).
// Terminate best effort, charge the estimate (idempotent), then today's
// timeout branch for a running row / a column clear for a finished one.
async function handleExecutorDeadline(admin: any, row: any): Promise<void> {
  const callId = String(row.executor_call_id);
  const meta = (row.executor_meta ?? null) as ExecutorMeta | null;
  console.log(`[exec] EXECUTOR_DEADLINE step=${row.step_key} run=${row.run_id} call=${callId} status=${row.status}`);
  if (EXECUTOR_ENV) {
    try {
      const cancel = await executorCancel(EXECUTOR_ENV, callId);
      if (cancel?.state === "complete") {
        // The instance finished between the poll and the cancel: the real
        // output exists on the Worker, so settle it instead of charging an
        // estimate and re-buying the step.
        const poll = await executorPoll(EXECUTOR_ENV, callId);
        if (poll.kind === "state" && poll.state === "complete" && poll.output) {
          console.log(`[exec] EXECUTOR_DEADLINE call=${callId} completed before cancel — settling the real output`);
          await settleExecutorStep(admin, { stepId: row.id, callId }, poll.output, "poll");
          return;
        }
      }
    } catch (e) {
      console.error(`[exec] EXECUTOR_DEADLINE cancel failed call=${callId}: ${(e as Error)?.message ?? e}`);
    }
  }
  // Re-read after the cancel, never act on the collector's snapshot: a
  // callback POST already in flight when the instance was terminated may
  // have settled the row meanwhile (§5.9 — CAS decides). Acting on the stale
  // snapshot would write an estimate for a call the callback already
  // settled, and — on a force_fallback step — let the verbatim timeout
  // branch's guarded update no-op and then failRun() a run whose step just
  // completed. A moved id means another settle owns the row: nothing to do.
  const { data: cur } = await admin
    .from("run_steps")
    .select("status, executor_call_id")
    .eq("id", row.id)
    .maybeSingle();
  if (!cur || cur.executor_call_id !== callId) {
    console.log(`[exec] EXECUTOR_DEADLINE call=${callId} row moved on (row_call=${cur?.executor_call_id ?? "null"}) — settled meanwhile, nothing to do`);
    return;
  }
  const status = String(cur.status ?? row.status);
  const run = await getRun(admin, row.run_id);
  if (run && meta?.model_id) {
    try {
      // Skipped (no second ledger row) when the call's real usage is already
      // under <C> — a settled row still carrying its id, or the no_env rule
      // reaching rows the callback already paid for (§0 no double-charge).
      const est = await recordTimeoutEstimate(admin, fromMeta(meta, run, row), { callId, suffix: ":timeout" });
      if (est === "skipped") console.log(`[exec] EXECUTOR_DEADLINE call=${callId} real usage already ledgered — no estimate`);
    } catch (e) {
      console.error(`[exec] EXECUTOR_DEADLINE estimate failed call=${callId}: ${(e as Error)?.message ?? e}`);
    }
  }
  if (!run || status !== "running") {
    await clearExecutorColumns(admin, row.id, callId);
    return;
  }
  const e = new ProxyTimeoutError(meta?.model_id ?? "unknown", Number(meta?.timeout_ms ?? 0) || 0);
  try {
    await handleCallFailure(admin, run, row, e, { quickRetryAllowed: false, guard: { callId } });
  } catch (err) {
    // The estimate is already ledgered and the row is still running with
    // its id: the next tick releases it — `terminated` polls as lost
    // (requeue, no second estimate), an unreachable cancel re-enters here,
    // and a completed instance takes the ok-after-deadline branch of
    // settleExecutorStep, which has the same exit — never stranded.
    console.error(`[exec] EXECUTOR_DEADLINE timeout branch failed step=${row.step_key} run=${row.run_id} call=${callId}: ${(err as Error)?.message ?? err}`);
    throw err;
  }
  // A requeue already NULLed the columns (RPC); a row the timeout branch
  // failed (timeout_failover_exhausted) is released here so a late result
  // lands in the stale branch and the collector stops selecting it.
  await clearExecutorColumns(admin, row.id, callId);
  // Same exit as the settle_error path (§5.4 step 4): a requeued row is
  // advanced now rather than waiting for the next cron tick.
  const fresh = await getRun(admin, run.id);
  if (fresh?.status === "running") await afterStepComplete(admin, fresh);
}

type CollectorStats = {
  polled: number;
  settled: number;
  requeued: number;
  deadline: number;
  lost: number;
  unreached: number;
  exhausted: boolean;
  breaker_tripped: boolean;
};

// §5.2 / §5.4 — the guarantee. Runs on every tick whenever ANY run_steps row
// carries an executor_call_id (any status; not gated on env or flag), least
// recently polled first, concurrency 6, until EXECUTOR_COLLECT_BUDGET_MS
// measured from TICK start is spent. Three consecutive unreachable polls
// end the pass (a Worker outage never starves the runs loop); a pass that
// runs out of budget with rows unpolled reports `exhausted` and the tick
// self-ticks instead of starting an inline step it could not finish.
async function collectExecutorCalls(admin: any, tickStartedAt: number): Promise<CollectorStats> {
  const stats: CollectorStats = { polled: 0, settled: 0, requeued: 0, deadline: 0, lost: 0, unreached: 0, exhausted: false, breaker_tripped: false };
  const { data: rows, error } = await admin
    .from("run_steps")
    .select("id, run_id, step_key, seat, status, request, executor_call_id, executor_dispatched_at, executor_meta")
    .not("executor_call_id", "is", null)
    .order("executor_meta->>last_polled_at", { ascending: true, nullsFirst: true })
    .order("executor_dispatched_at", { ascending: true })
    .limit(60);
  if (error) throw new Error(`collector select failed: ${error.message ?? error}`);
  const list: any[] = rows ?? [];
  if (!list.length) return stats;

  const env = EXECUTOR_ENV;
  const budgetSpent = () => Date.now() - tickStartedAt >= EXECUTOR_COLLECT_BUDGET_MS;

  const pollOne = async (row: any): Promise<"unreachable" | "other"> => {
    const callId = String(row.executor_call_id);
    const meta = (row.executor_meta ?? null) as ExecutorMeta | null;
    const poll: PollResult | null = env ? await executorPoll(env, callId) : null;
    const decision = decideOnPoll(row, poll, Date.now(), !!env);
    const bumpMeta = async (patch: Partial<ExecutorMeta>) => {
      await admin
        .from("run_steps")
        .update({ executor_meta: { ...(meta ?? {}), ...patch, last_polled_at: new Date().toISOString() } })
        .eq("id", row.id)
        .eq("executor_call_id", callId);
    };
    switch (decision.action) {
      case "wait": {
        await bumpMeta({ last_state: poll && poll.kind === "state" ? poll.state : (meta?.last_state ?? null) });
        return "other";
      }
      case "settle_ok":
      case "settle_error": {
        await settleExecutorStep(admin, { stepId: row.id, callId }, decision.output, "poll");
        stats.settled++;
        return "other";
      }
      case "unreachable": {
        await bumpMeta({
          poll_failures: (Number(meta?.poll_failures ?? 0) || 0) + 1,
          last_state: poll && poll.kind === "state" ? poll.state : "unreachable",
        });
        stats.unreached++;
        return "unreachable";
      }
      case "no_env":
        return "other";
      case "deadline": {
        await handleExecutorDeadline(admin, row);
        stats.deadline++;
        return "other";
      }
      case "redispatch": {
        if (row.status !== "running") {
          // Nothing ran and the row no longer wants a verdict: release it.
          await clearExecutorColumns(admin, row.id, callId);
          return "other";
        }
        const run = await getRun(admin, row.run_id);
        if (!run) {
          await clearExecutorColumns(admin, row.id, callId);
          return "other";
        }
        console.log(`[exec] EXECUTOR_REDISPATCH step=${row.step_key} run=${row.run_id} call=${callId}`);
        await dispatchStepToExecutor(admin, run, row, callId);
        stats.requeued++;
        return "other";
      }
      case "lost": {
        console.log(`[exec] EXECUTOR_LOST step=${row.step_key} run=${row.run_id} call=${callId} reason=${decision.reason} status=${row.status}`);
        if (row.status !== "running") {
          await clearExecutorColumns(admin, row.id, callId);
        } else {
          const lost = lostRequeueRequest(row.request);
          const r = await requeueStepIfParentActive(admin, row.id, lost.request, "executor_call_lost", callId);
          if (r !== "requeued") await clearExecutorColumns(admin, row.id, callId);
          if (lost.bypass) console.log(`[exec] EXECUTOR_BYPASS step=${row.step_key} — next claim runs inline`);
        }
        stats.lost++;
        return "other";
      }
    }
  };

  let next = 0;
  let consecutiveUnreachable = 0;
  let stop = false;
  // Progress guarantee: the first batch (one row per worker) is polled even
  // when the phases before the collector already spent the budget —
  // otherwise a slow sweep/watchdog would make every tick report
  // `exhausted` with zero rows polled, self-tick, and never reach the runs
  // loop while executor rows exist.
  const firstBatch = Math.min(6, list.length);
  const worker = async () => {
    while (!stop) {
      if (next >= firstBatch && budgetSpent()) {
        stop = true;
        break;
      }
      const i = next++;
      if (i >= list.length) break;
      const row = list[i];
      let kind: "unreachable" | "other" = "other";
      try {
        kind = await pollOne(row);
      } catch (e) {
        console.error(`[exec] collector: step=${row.id} call=${row.executor_call_id} failed: ${(e as Error)?.message ?? e}`);
      }
      stats.polled++;
      if (kind === "unreachable") {
        consecutiveUnreachable++;
        if (consecutiveUnreachable >= EXECUTOR_UNREACHABLE_BREAKER) {
          stats.breaker_tripped = true;
          stop = true;
        }
      } else {
        consecutiveUnreachable = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, () => worker()));
  stats.exhausted = !stats.breaker_tripped && stats.polled < list.length && budgetSpent();
  return stats;
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

  // Pre-lock owner-authority gate (R6 correction wrapper). Chair/loop3 CANNOT
  // override — but a candidate that violates owner-authority is now sent
  // through a bounded Chair authority-correction step (up to
  // AUTHORITY_CORRECTION_MAX attempts) before the run is terminated. This is
  // orthogonal to the synthesis-loop consensus protocol: dissent and loop_no
  // are preserved verbatim on the run.
  let authority: Awaited<ReturnType<typeof loadOwnerAuthority>>;
  try {
    authority = await loadOwnerAuthority(admin, {
      projectId: run.project_id,
      founderNotes: run.founder_notes ?? null,
    });
  } catch (e) {
    await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
    return;
  }
  const enforceRes = await enforceAuthorityOrCorrect({
    admin,
    run,
    phase: "pre_lock_plan",
    authority,
    artifacts: [
      { key: "content_md", label: `${planKind}.content_md (pending lock)`, text: contentMd },
    ],
    onTerminalFail: async (err) => {
      await failRun(admin, run, err);
      await insertAlert(admin, {
        user_id: run.user_id,
        project_id: run.project_id,
        kind: "owner_authority_violation",
        detail: { run_id: run.id, mode, phase: "pre_lock", excerpt: err.slice(0, 800) },
      });
    },
    restartMeta: { original_mode: mode },
  });
  if (enforceRes.status === "failed_terminal") return;
  if (enforceRes.status === "pending") return;
  contentMd = enforceRes.artifacts.find((a) => a.key === "content_md")!.text;


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
  const threshold = await resolveConsensusThreshold(admin, run.user_id);
  const { scores } = checkConsensus(latestVotes, run.kind, threshold);
  // The vote as a scorecard (derived from the stored vote steps, no model
  // call): on the run for the UI, in the decision log for the record.
  const scorecard = voteScorecard(latestVotes, run.kind, threshold, mode === "consensus");
  decisionLog.push(scorecardDecisionEntry(scorecard));

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
        consensus: keepSmoke(run, { scores, scorecard, plan_version_id: inserted?.id ?? null }),
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
      consensus: keepSmoke(run, {
        pending_final_status: mode,
        scores,
        scorecard,
        plan_version_id: inserted?.id ?? null,
      }),
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

  // Pre-finalization owner-authority gate (R6 correction wrapper). PRD + features
  // are generated AFTER lockPlanAndQueueBlueprint; block the row update behind
  // the correction path so a fixable violation does not discard the plan.
  let prdOut = prdMd;
  let featuresOut: any = features;
  if (planVersionId && (prdMd || (features && features.length))) {
    let authority: Awaited<ReturnType<typeof loadOwnerAuthority>>;
    try {
      authority = await loadOwnerAuthority(admin, {
        projectId: run.project_id,
        founderNotes: run.founder_notes ?? null,
      });
    } catch (e) {
      await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
      return;
    }
    const enforceRes = await enforceAuthorityOrCorrect({
      admin,
      run,
      phase: "pre_finalize_blueprint",
      authority,
      artifacts: [
        { key: "prd_md", label: "plan.prd_md (pending finalization)", text: String(prdMd ?? "") },
        { key: "features_json", label: "plan.features (pending finalization)", text: JSON.stringify(features ?? []) },
      ],
      onTerminalFail: async (err) => {
        // Invalidate the plan_versions row that was inserted upstream: PRD
        // failed the owner-authority gate after AUTHORITY_CORRECTION_MAX
        // attempts, so this plan must not be used as a build-safe input by
        // later design/batches/compiler reads.
        try {
          await admin
            .from("plan_versions")
            .update({ is_build_safe: false, invalidated_reason: "owner_authority_prd_gate_failed" })
            .eq("id", planVersionId);
        } catch { /* best-effort */ }
        await failRun(admin, run, err);
        await insertAlert(admin, {
          user_id: run.user_id,
          project_id: run.project_id,
          kind: "owner_authority_violation",
          detail: {
            run_id: run.id,
            mode: finalStatus,
            phase: "pre_finalize_blueprint",
            excerpt: err.slice(0, 800),
          },
        });
      },
    });
    if (enforceRes.status === "failed_terminal") return;
    if (enforceRes.status === "pending") return;
    prdOut = enforceRes.artifacts.find((a) => a.key === "prd_md")!.text;
    const featuresText = enforceRes.artifacts.find((a) => a.key === "features_json")!.text;
    try { featuresOut = JSON.parse(featuresText); } catch { featuresOut = features; }
  }

  if (planVersionId && prdOut) {
    await admin
      .from("plan_versions")
      .update({ prd_md: prdOut, features: featuresOut })
      .eq("id", planVersionId);
  }
  await admin
    .from("boardroom_runs")
    .update({
      status: finalStatus,
      consensus: keepSmoke(run, { ...(meta.scores ?? {}), ...(meta.scorecard ? { scorecard: meta.scorecard } : {}) }),
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
    // Pre-finalization owner-authority gate (R6 correction wrapper) for
    // change requests. Load the EXACT current change_requests.description as
    // an explicit owner source scoped to THIS CR run only so the Chair cannot
    // expand beyond the submitted change.
    let crDescription = "";
    try {
      const { data: crRow } = await admin
        .from("change_requests")
        .select("description")
        .eq("id", crId)
        .maybeSingle();
      crDescription = String(crRow?.description ?? "");
    } catch { /* ignore — an empty CR description simply blocks any high-impact expansion */ }
    let authority: Awaited<ReturnType<typeof loadOwnerAuthority>>;
    try {
      authority = await loadOwnerAuthority(admin, {
        projectId: run.project_id,
        founderNotes: run.founder_notes ?? null,
        extraFounderNotes: crDescription
          ? [{ source: `approved_change_request:${crId}`, text: crDescription }]
          : [],
      });
    } catch (e) {
      await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
      return;
    }
    const enforceRes = await enforceAuthorityOrCorrect({
      admin,
      run,
      phase: "pre_finalize_change_request",
      authority,
      artifacts: [
        { key: "amended_plan_md", label: "change_request.amended_plan_md (pending finalization)", text: String(v?.amended_plan_md ?? "") },
        { key: "amended_prd_md", label: "change_request.amended_prd_md (pending finalization)", text: String(v?.amended_prd_md ?? "") },
        { key: "amended_features_json", label: "change_request.amended_features (pending finalization)", text: JSON.stringify(v?.amended_features ?? []) },
      ],
      onTerminalFail: async (err) => {
        await failRun(admin, run, err);
        await insertAlert(admin, {
          user_id: run.user_id,
          project_id: run.project_id,
          kind: "owner_authority_violation",
          detail: {
            run_id: run.id,
            change_request_id: crId,
            phase: "pre_finalize_change_request",
            excerpt: err.slice(0, 800),
          },
        });
      },
    });
    if (enforceRes.status === "failed_terminal") return;
    if (enforceRes.status === "pending") return;
    const amendedPlan = enforceRes.artifacts.find((a) => a.key === "amended_plan_md")!.text;
    const amendedPrd = enforceRes.artifacts.find((a) => a.key === "amended_prd_md")!.text;
    const amendedFeaturesText = enforceRes.artifacts.find((a) => a.key === "amended_features_json")!.text;
    let amendedFeatures: any[] = [];
    try { const parsed = JSON.parse(amendedFeaturesText); if (Array.isArray(parsed)) amendedFeatures = parsed; }
    catch { amendedFeatures = Array.isArray(v.amended_features) ? v.amended_features : []; }

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
        content_md: amendedPlan,
        prd_md: amendedPrd,
        features: amendedFeatures,
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

  // Pre-promotion owner-authority gate (R6 correction wrapper): validate the
  // complete batch set BEFORE any executable row is saved. A fixable violation
  // now runs through a bounded Chair correction step before terminating.
  let authority: Awaited<ReturnType<typeof loadOwnerAuthority>>;
  try {
    authority = await loadOwnerAuthority(admin, {
      projectId: run.project_id,
      founderNotes: run.founder_notes ?? null,
    });
  } catch (e) {
    await failRun(admin, run, `owner_authority_load_failed: ${(e as Error).message}`);
    return;
  }
  const artifacts: Artifact[] = rows.map((r) => ({
    key: `batch_${r.batch_no}_prompt_md`,
    label: `batch[${r.batch_no}] "${r.title}".prompt_md`,
    text: r.prompt_md,
  }));
  const enforceRes = await enforceAuthorityOrCorrect({
    admin,
    run,
    phase: "pre_promote_batches",
    authority,
    artifacts,
    onTerminalFail: async (err) => {
      await failRun(admin, run, err);
      await insertAlert(admin, {
        user_id: run.user_id,
        project_id: run.project_id,
        kind: "owner_authority_violation",
        detail: { run_id: run.id, phase: "pre_promote_batches", excerpt: err.slice(0, 800) },
      });
    },
    restartMeta: { pending_batches: batchesJson },
  });
  if (enforceRes.status === "failed_terminal") return;
  if (enforceRes.status === "pending") return;
  for (const a of enforceRes.artifacts) {
    const m = /^batch_(\d+(?:\.\d+)?)_prompt_md$/.exec(a.key);
    if (!m) continue;
    const bno = Number(m[1]);
    const r = rows.find((r) => r.batch_no === bno);
    if (r) r.prompt_md = a.text;
  }

  // Idempotent persistence + first-terminal-wins run finalization.
  //
  // Live run 0ed1f4e7 proved two ticks can concurrently reach this tail:
  // worker A inserts six rows and marks the run "completed"; worker B's
  // identical INSERT trips batches_project_id_batch_no_key and the old
  // handler overwrote "completed" with "failed". Fix:
  //   1. Bail out early if the run is already terminal (another worker
  //      finished the job).
  //   2. On duplicate-key conflict, re-read the persisted set and only
  //      accept it if planned == existing on project/user/plan/batch_no/
  //      title/channel/prompt_md AND every row is still in the safe
  //      pre-execution shape (pending, uncompiled, unsent, no outcome).
  //      Any mismatch fails loudly.
  //   3. All boardroom_runs status writes are compare-and-set on the
  //      non-terminal set, so a late loser can never demote "completed"
  //      or overwrite a prior "failed".
  //   4. projects.status only advances to "building" from the pre-build
  //      set (locked/imported/auditing/validated) — a project that raced
  //      further along the lifecycle is left alone.
  const plannedRows: PlannedBatchRow[] = rows as PlannedBatchRow[];

  const preRun = await getRun(admin, run.id);
  if (preRun && (TERMINAL_RUN_STATUSES as readonly string[]).includes(preRun.status)) {
    // Peer worker already finalized (success or failure). Do nothing.
    return;
  }

  const { error: insErr } = await admin.from("batches").insert(plannedRows);

  if (insErr) {
    if (!isUniqueViolation(insErr)) {
      await failRun(admin, run, `Failed to insert batches: ${insErr.message ?? String(insErr)}`);
      return;
    }
    // Duplicate-key: check for exact-match idempotency against the batches
    // already persisted for THIS project. Deliberately scoped by
    // project_id ONLY — NOT plan_version_id. A stale set left behind by an
    // earlier plan/design revision carries the OLD plan_version_id, so a
    // filter on the NEW plan_version_id would miss it entirely and report a
    // false "no existing rows" even though the unique constraint just
    // proved rows exist. The comparator (decideConflictOutcome) is what
    // judges plan-version and user mismatches, not this query.
    const { data: existingRaw, error: readErr } = await admin
      .from("batches")
      .select(
        "project_id,user_id,plan_version_id,batch_no,title,channel,prompt_md,status,is_fix,sent_at,built_at,compiled_at,compiled_prompt_md,compiled_verification_prompt_md,compile_meta,outcome_md",
      )
      .eq("project_id", run.project_id)
      .order("batch_no", { ascending: true });
    if (readErr) {
      await failRun(admin, run, `Failed to insert batches (conflict readback failed): ${readErr.message ?? String(readErr)}`);
      return;
    }
    const decision = decideConflictOutcome(
      plannedRows,
      (existingRaw ?? []) as ExistingBatchRow[],
    );
    if (decision.kind === "reject") {
      await failRun(
        admin,
        run,
        `Failed to insert batches: duplicate_key_conflict_not_idempotent (${decision.reason})`,
      );
      return;
    }
    if (decision.kind === "supersede_stale") {
      // The existing set is untouched (never sent, built, or compiled) but
      // stale — left behind by an earlier plan/design revision. Nothing the
      // founder acted on is destroyed: replace it with the freshly-drafted
      // set. Scoped to project_id + the safe-pre-execution predicate so this
      // can never delete a row with real progress, even if the comparator's
      // judgment and the live table state have drifted between the read and
      // this write.
      const { error: delErr } = await admin
        .from("batches")
        .delete()
        .eq("project_id", run.project_id)
        .eq("status", "pending")
        .eq("is_fix", false)
        .is("sent_at", null)
        .is("built_at", null)
        .is("compiled_at", null);
      if (delErr) {
        await failRun(admin, run, `Failed to supersede stale batches: ${delErr.message ?? String(delErr)}`);
        return;
      }
      const { error: reinsErr } = await admin.from("batches").insert(plannedRows);
      if (reinsErr) {
        await failRun(admin, run, `Failed to insert batches after superseding stale set: ${reinsErr.message ?? String(reinsErr)}`);
        return;
      }
    }
    // Fall through — treat as if we just inserted the set ourselves.
  }

  // Advance the project from the canonical pre-build predecessor. A
  // 'batches' finalization is valid after locked plan + locked design
  // (projects.status='locked') OR for imported design-only / imports where
  // the project sits at 'imported' with no plan/design required by scope.
  // Compare-and-set on the safe predecessor set enforces "never rewind"
  // for building/auditing/polishing/done/killed. Surface DB errors into
  // failRun so a silent completion never masks a persistence failure.
  const { error: projAdvanceErr } = await admin
    .from("projects")
    .update({ status: "building", current_batch_no: 1 })
    .eq("id", run.project_id)
    .in("status", ["locked", "imported"]);
  if (projAdvanceErr) {
    await failRun(admin, run, `Failed to advance project to building: ${projAdvanceErr.message ?? String(projAdvanceErr)}`);
    return;
  }

  // Compare-and-set: only mark completed if the run is still non-terminal.
  // Prevents a losing worker from ever downgrading a peer's terminal write.
  await admin
    .from("boardroom_runs")
    .update({
      status: "completed",
      consensus: keepSmoke(run, { batches_inserted: plannedRows.length }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .not("status", "in", `(${TERMINAL_RUN_STATUSES.join(",")})`);
}


// Resume / retry: before a failed step is bought again, re-judge the text it
// stored under the CURRENT acceptance rules (accept-json.ts). A pass marks
// the step completed with the normalized value (+ _meta.revalidated) and
// clears its error — no model call — so afterStepComplete advances the run
// from it. Returns false (nothing written) when the stored text still fails,
// or the row was no longer 'failed'.
async function completeStepFromStoredOutput(admin: any, run: any, step: any): Promise<boolean> {
  const verdict = revalidateStoredStep(step, run.kind);
  if (!verdict.ok) {
    if (step?.response_text) console.log(`[resume] REVALIDATE_FALLTHROUGH step=${step.step_key} run=${run.id} reason=${verdict.reason}`);
    return false;
  }
  const { data: done, error } = await admin
    .from("run_steps")
    .update({
      status: "completed",
      error: null,
      response_json: verdict.response_json,
      completed_at: new Date().toISOString(),
    })
    .eq("id", step.id)
    .eq("status", "failed")
    .select("id");
  if (error || !done?.length) return false;
  console.log(`[resume] REVALIDATED step=${step.step_key} run=${run.id} — completed from stored output`);
  return true;
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

// SUPPORTED-FINDINGS-R3 gate: every model-authored fix/QA prompt_md must
// pass the owner-authority pre-lock check BEFORE being inserted as a
// pending batch. A prompt that names an unauthorized pricing move, external
// integration, destructive SQL, or feature-disable directive is dropped
// (an alert is written for the owner) rather than silently promoted into
// the build sequence. finalizeBatches already gates its own inserts.
async function insertModelAuthoredBatchOrAlert(
  admin: any,
  run: any,
  audit: any,
  row: { title: string; prompt_md: string; [k: string]: any },
): Promise<{ inserted: { id: string } | null; blocked: boolean; error: string | null }> {
  try {
    const authority = await loadOwnerAuthority(admin, {
      projectId: audit.project_id,
      founderNotes: run?.founder_notes ?? null,
    });
    const preErr = computeAuthorityViolationError(
      [{ key: "prompt_md", label: `fix_batch "${row.title}".prompt_md`, text: String(row.prompt_md ?? "") }],
      authority,
    );
    if (preErr) {
      await insertAlert(admin, {
        user_id: audit.user_id,
        project_id: audit.project_id,
        kind: "owner_authority_violation",
        detail: {
          audit_id: audit.id,
          run_id: run?.id ?? null,
          phase: "pre_insert_fix_batch",
          title: row.title,
          excerpt: preErr.slice(0, 800),
        },
      });
      return { inserted: null, blocked: true, error: preErr };
    }
  } catch (e) {
    // Fail closed on authority-load errors — do not insert an ungated batch.
    await insertAlert(admin, {
      user_id: audit.user_id,
      project_id: audit.project_id,
      kind: "owner_authority_violation",
      detail: {
        audit_id: audit.id,
        run_id: run?.id ?? null,
        phase: "pre_insert_fix_batch_load_error",
        title: row.title,
        excerpt: String((e as Error)?.message ?? e).slice(0, 800),
      },
    });
    return { inserted: null, blocked: true, error: String((e as Error)?.message ?? e) };
  }
  const { data: inserted, error } = await admin
    .from("batches")
    .insert(row)
    .select("id")
    .single();
  if (error) return { inserted: null, blocked: false, error: error.message };
  return { inserted: inserted as { id: string }, blocked: false, error: null };
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

  // Normalize → dedupe → downgrade unsupported P0/P1, then re-validate
  // caps. validateStepJson("audit_chair_merge", …) already ran the same
  // pipeline before the step was marked completed (AUDIT-FINALIZATION-R2),
  // so a residual error here means someone bypassed the step path or a
  // schema drifted — see the validation_warning handling below.
  const { evaluateChairMergeCandidate } = await import("../_shared/audit-findings.ts");
  // OWNER-AUTHORITY monetization gate: load the project's most recent
  // intake answers to detect whether price_anchor / upgrade_trigger were
  // left unset/deferred (blank, canonical placeholder, or legacy unapproved
  // owner-decision wording).
  // When unset, generic "no money path / pricing CTA / checkout / upgrade
  // path" findings are deterministically capped to P2 in the publication
  // path so they never enter a fix batch. Real broken owner-authorized
  // flows (OWNER_CONTRACT: / RUNTIME_FAILURE: markers) still publish.
  let ownerContract: { priceAnchorUnset?: boolean; upgradeTriggerUnset?: boolean } | undefined;
  try {
    const { data: intakeRow } = await admin
      .from("intakes")
      .select("answers")
      .eq("project_id", audit.project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { isMonetizationOwnerInputUnset } = await import("../_shared/import-strategy.ts");
    const ans = (intakeRow?.answers ?? {}) as Record<string, unknown>;
    const priceAnchor = typeof ans.price_anchor === "string" ? ans.price_anchor.trim() : "";
    const upgradeTrigger = typeof ans.upgrade_trigger === "string" ? ans.upgrade_trigger.trim() : "";
    ownerContract = {
      priceAnchorUnset: isMonetizationOwnerInputUnset(priceAnchor),
      upgradeTriggerUnset: isMonetizationOwnerInputUnset(upgradeTrigger),
    };
  } catch {
    // Fail-closed / safety-first on lookup: absence of intake data means we
    // cannot prove the owner authorized monetization, so treat both as unset.
    ownerContract = { priceAnchorUnset: true, upgradeTriggerUnset: true };
  }
  const evaluation = evaluateChairMergeCandidate(parsed, ownerContract);
  const { findings, downgrades, summary: mergedSummaryText } = evaluation;
  // RC-3: the evaluator now fits the report into the merge caps instead of
  // rejecting it, so a residual error here is a fitter/validator drift (or a
  // merge with no findings array at all). The paid seat work is published
  // as trimmed, with the warning recorded on the run, rather than failing
  // the run at its very last step.
  const validationWarning: string | null = evaluation.error ?? null;
  if (validationWarning) {
    console.log(`[audit] finalize run=${run.id} publishing with validation_warning=${validationWarning}`);
  }
  const consensusWarning = validationWarning ? { validation_warning: validationWarning } : {};
  let carryError: string | null = null;

  const isFinal = audit.kind === "final_az";

  // RC-6 incremental audit: snapshot the prior final audit's unresolved
  // findings on files this run did not re-read BEFORE supersession resolves
  // them; they are copied under this audit once its own findings land.
  const {
    incrementalMetaFromConsensus,
    selectCarryForward,
    carryForwardRow,
    carryForwardNote,
    CARRY_FORWARD_STATUSES,
  } = await import("../_shared/audit-incremental.ts");
  const incremental = isFinal ? incrementalMetaFromConsensus(run.consensus) : null;
  let carried: import("../_shared/audit-incremental.ts").PriorFinding[] = [];
  if (incremental) {
    const { data: priorRows, error: priorErr } = await admin
      .from("audit_findings")
      .select("id, seat, severity, file_path, title, description, evidence, confidence, line_start, line_end, fix_batch_id, status")
      .eq("audit_id", incremental.prior_audit_id)
      .in("status", [...CARRY_FORWARD_STATUSES]);
    if (priorErr) {
      await failRun(admin, run, `incremental audit: could not read prior findings: ${priorErr.message ?? priorErr}`);
      return;
    }
    carried = selectCarryForward(priorRows ?? [], incremental);
  }

  // FINAL-AUDIT-SUPERSESSION-R1: for a successful final_az finalization
  // (validation passed; clean OR findings verdict), resolve open/fix_drafted
  // findings from OLDER final_az audits and archive+delete their pending,
  // unsent, unbuilt fix batches. Runs BEFORE we publish the current audit
  // result so a batch_no collision or dangling stale fix batch cannot survive.
  // Fails loud — no partial publish.
  if (isFinal) {
    try {
      const { supersedeOlderFinalAudits } = await import("../_shared/audit-supersession.ts");
      await supersedeOlderFinalAudits(admin, {
        auditId,
        projectId: audit.project_id,
        userId: audit.user_id,
        runId: run.id,
        // A carried finding's fix batch is not obsolete: it is the only fix
        // prompt for a P0/P1 this run did not re-read.
        keepBatchIds: new Set(carried.map((f) => f.fix_batch_id).filter((x): x is string => !!x)),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin
        .from("audits")
        .update({ status: "failed", completed_at: new Date().toISOString(), summary: { error: `supersession_failed: ${msg}` } })
        .eq("id", auditId);
      await failRun(admin, run, `final-audit supersession failed: ${msg}`);
      return;
    }
  }

  // Carried-forward findings are still open findings of this audit: a merge
  // that found nothing in the changed files cannot declare the app clean.
  const verdict = carried.length && evaluation.verdict === "clean" ? "findings" : evaluation.verdict;
  const filesAnalyzed = Number(run.consensus?.files_analyzed ?? 0) || null;

  const countOf = (sev: string) =>
    findings.filter((f) => f.severity === sev).length + carried.filter((f) => f.severity === sev).length;
  const counts = { P0: countOf("P0"), P1: countOf("P1"), P2: countOf("P2"), P3: countOf("P3") };
  // R3 — never let the persisted summary.text assert a severity class the
  // post-downgrade counts don't support. Live regression: audit 2d953efb had
  // counts.P0=0 but summary text said "P0". reconcileAuditSummaryText is
  // deterministic and only trims/replaces — never invents facts.
  const { reconcileAuditSummaryText } = await import("../_shared/audit-findings.ts");
  const rejectedTitles = (downgrades ?? [])
    .filter((d: any) => d?.disposition === "rejected_unsupported" || d?.published === false)
    .map((d: any) => String(d?.title ?? ""))
    .filter((t: string) => t.length > 0);
  const reconciledText = reconcileAuditSummaryText(mergedSummaryText, counts, rejectedTitles) +
    (incremental ? carryForwardNote(carried.length, incremental.base_sha) : "");

  const summary = {
    verdict,
    text: reconciledText,
    counts,
    validation_downgrades: downgrades,
    ...(incremental
      ? { carried_forward: { from_audit_id: incremental.prior_audit_id, base_sha: incremental.base_sha, count: carried.length } }
      : {}),
  };

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
        await insertModelAuthoredBatchOrAlert(admin, run, audit, {
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
      } else {
        // Import: restore prior status so it doesn't stay stuck at 'auditing'.
        const prev = audit.previous_project_status
          ?? (run?.consensus as any)?.previous_project_status
          ?? "imported";
        await admin
          .from("projects")
          .update({ status: prev })
          .eq("id", audit.project_id)
          .eq("status", "auditing");
      }
    }

    await admin
      .from("boardroom_runs")
      .update({ status: "consensus", consensus: { ...(run.consensus ?? {}), verdict: "clean", ...consensusWarning } })
      .eq("id", run.id);
    return;
  }

  // Findings path.
  await admin
    .from("audits")
    .update({ status: "findings", summary, files_analyzed: filesAnalyzed, completed_at: new Date().toISOString() })
    .eq("id", auditId);

  // Lifecycle-R1: a final audit with findings must not leave the project
  // stuck at 'auditing'. Restore prior status; the fix batch (if any)
  // carries the follow-up work through the batches lifecycle.
  if (isFinal && audit.project_id) {
    const prev = audit.previous_project_status
      ?? (run?.consensus as any)?.previous_project_status
      ?? "locked";
    await admin
      .from("projects")
      .update({ status: prev })
      .eq("id", audit.project_id)
      .eq("status", "auditing");
  }

  let fixBatchId: string | null = null;
  const rawFixPrompt = String(parsed?.fix_prompt_md ?? "").trim();
  // Only SUPPORTED (post-downgrade) P0/P1 can trigger a fix batch.
  const supportedSerious = findings.filter((f) => f.severity === "P0" || f.severity === "P1");
  const hasSupportedSerious = supportedSerious.length > 0;

  // FIX-BATCH-SANITIZE: the Chair's raw fix_prompt_md can still cite
  // rejected/unpublished downgrade findings. Filter to items tied to the
  // post-validation supported P0/P1 only, drop rejected/unmatched items,
  // and rebuild numbering + acceptance checks. Same sanitized prompt is
  // used for BOTH per-batch and final-audit fix batches, before
  // owner-authority gating and insertion.
  const { sanitizeFixPrompt } = await import("../_shared/fix-batch-sanitize.ts");
  const rejectedFindingRefs = (downgrades ?? [])
    .filter((d: any) => d?.disposition === "rejected_unsupported" || d?.published === false)
    .map((d: any) => ({ title: String(d?.title ?? ""), file_path: String(d?.file_path ?? "") }));
  const sanitized = rawFixPrompt && hasSupportedSerious
    ? sanitizeFixPrompt(
        rawFixPrompt,
        supportedSerious.map((f) => ({ title: f.title, file_path: f.file_path })),
        rejectedFindingRefs,
      )
    : { prompt: null, reason: "empty_input" as const, keptItemCount: 0, droppedRejected: 0, droppedUnmatched: 0 };
  const fixPrompt = sanitized.prompt ?? "";

  if (rawFixPrompt && hasSupportedSerious && !fixPrompt) {
    await insertAlert(admin, {
      user_id: audit.user_id,
      project_id: audit.project_id,
      kind: "fix_batch_sanitize_empty",
      detail: {
        audit_id: auditId,
        run_id: run.id,
        reason: sanitized.reason,
        dropped_rejected: sanitized.droppedRejected,
        dropped_unmatched: sanitized.droppedUnmatched,
        supported_count: supportedSerious.length,
      },
    });
  }

  if (!isFinal && audit.batch_id && hasSupportedSerious && fixPrompt) {
    const { data: parent } = await admin
      .from("batches")
      .select("batch_no, title")
      .eq("id", audit.batch_id)
      .maybeSingle();
    if (parent) {
      const parentNo = Math.floor(Number(parent.batch_no));
      const fixNo = Number((parentNo + 0.1 * Number(audit.loop_no ?? 1)).toFixed(2));
      const gated = await insertModelAuthoredBatchOrAlert(admin, run, audit, {
        project_id: audit.project_id,
        user_id: audit.user_id,
        batch_no: fixNo,
        title: `Fix — ${parent.title}`,
        channel: "lovable",
        prompt_md: fixPrompt,
        status: "pending",
        is_fix: true,
        parent_batch_id: audit.batch_id,
      });
      fixBatchId = gated.inserted?.id ?? null;
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
    const gated = await insertModelAuthoredBatchOrAlert(admin, run, audit, {
      project_id: audit.project_id,
      user_id: audit.user_id,
      batch_no: nextNo,
      title: "Fix — Final A-Z Audit",
      channel: "lovable",
      prompt_md: fixPrompt,
      status: "pending",
      is_fix: true,
    });
    fixBatchId = gated.inserted?.id ?? null;
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

  // Copy (never move) the prior audit's findings on untouched files. A prior
  // fix batch link is kept only if that batch survived supersession.
  if (carried.length) {
    const batchIds = [...new Set(carried.map((f) => f.fix_batch_id).filter((x): x is string => !!x))];
    const live = new Set<string>();
    if (batchIds.length) {
      const { data: liveRows } = await admin.from("batches").select("id").in("id", batchIds);
      for (const b of liveRows ?? []) live.add(String(b.id));
    }
    const { error: carryErr } = await admin
      .from("audit_findings")
      .insert(carried.map((f) => carryForwardRow(f, auditId, audit.user_id, live)));
    if (carryErr) {
      carryError = `carry-forward insert of ${carried.length} findings failed: ${carryErr.message ?? carryErr}`;
      console.error(`[audit] finalize run=${run.id} ${carryError}`);
    }
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
    .update({
      status: "consensus",
      consensus: {
        ...(run.consensus ?? {}),
        verdict: "findings",
        fix_batch_id: fixBatchId,
        ...consensusWarning,
        ...(carryError ? { carry_forward_error: carryError } : {}),
      },
    })
    .eq("id", run.id);
}


// Advance a run once its steps settle. A throw inside advanceRun used to
// escape processRun / pipelineTick and leave the run 'running' with nothing
// queued — invisible to every rescue path and blocking the one-active-run
// slot for its kind. Now it fails the run with the message (first-terminal-
// wins, so a concurrent failure's error is preserved).
async function afterStepComplete(admin: any, runIn: any) {
  try {
    await advanceRun(admin, runIn);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`[after] advance failed for run ${runIn?.id}: ${msg}`);
    const run = (await getRun(admin, runIn.id)) ?? runIn;
    await failRun(admin, run, `advance failed: ${msg}`);
  }
}

async function advanceRun(admin: any, runIn: any) {
  const run = await getRun(admin, runIn.id);
  if (!run) return;
  const steps = await loadAllSteps(admin, run.id);
  const phase = runStepsPhase(steps);
  // No steps at all = the run is still being seeded (start_run inserts the
  // run row, then its first steps) or was orphaned before they landed.
  // Advancing here queued Round 2 against zero drafts and failed a batches
  // run for a draft that had not been inserted yet.
  if (phase === "no_steps") {
    console.log(`[after] run ${run.id} has no steps yet`);
    return;
  }
  // Queued steps = claimable work -> kick one tick to pick them up.
  if (phase === "queued") {
    fireSelfTick();
    return;
  }
  // Running steps = another invocation is on it. Do NOT self-tick here: that
  // invocation calls afterStepComplete itself when its step finishes, and the
  // per-minute cron rescues orphans. Re-firing on merely-running steps created
  // an infinite tick storm that maxed the instance and kept old warm isolates
  // permanently busy so redeployed code never took effect.
  if (phase === "running") {
    return;
  }

  // OWNER-AUTHORITY-CORRECTION-R6: absorb a completed authority-correction
  // step (if any) into run.consensus.authority_correction and re-drive the
  // finalization function whose phase queued it. The re-entered finalize
  // path will run enforceAuthorityOrCorrect again which overlays the newly
  // corrected artifacts, revalidates, and either finalizes or queues the
  // next attempt (or terminates at AUTHORITY_CORRECTION_MAX).
  const awaited = findAwaitedCorrectionStep(run, steps);
  if (awaited) {
    if (awaited.status !== "completed") {
      // Correction step in-flight or errored — nothing more to do here.
      return;
    }
    const absorbed = await absorbCorrectionStep(admin, run, awaited);
    if (!absorbed.ok) {
      await failRun(admin, run, absorbed.error ?? "authority_correction_absorb_failed");
      return;
    }
    const freshRun = await getRun(admin, run.id);
    if (!freshRun) return;
    const freshSteps = await loadAllSteps(admin, freshRun.id);
    switch (absorbed.phase) {
      case "pre_lock_plan":
        await lockPlanAndQueueBlueprint(
          admin,
          freshRun,
          freshSteps,
          (freshRun.consensus?.authority_correction?.original_mode as any) ?? "consensus",
        );
        return;
      case "pre_finalize_blueprint":
        await finalizeBlueprint(admin, freshRun, freshSteps);
        return;
      case "pre_finalize_change_request":
        await finalizeChangeRequest(admin, freshRun, freshSteps);
        return;
      case "pre_promote_batches": {
        const cached = freshRun.consensus?.authority_correction?.pending_batches;
        if (Array.isArray(cached) && cached.length) {
          await finalizeBatches(admin, freshRun, cached);
        }
        return;
      }
      default:
        return;
    }
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
    // A seat chunk may fail alone (isStepLocalFailure), so the fan-in waits
    // for every seat step to reach a terminal state, then merges as long as
    // coverage clears the floor; the Chair is told which reviews are missing.
    const terminal = (x: any) => x.status === "completed" || x.status === "failed";
    const parallelDone = seatSteps.length > 0 && seatSteps.every(terminal);
    if (parallelDone) {
      const coverage = auditSeatCoverage(seatSteps);
      if (!coverage.ok) {
        await failRun(admin, run, `audit coverage below floor: ${coverage.reason}`);
        return;
      }
      const prior: string[] = Array.isArray(run.consensus?.missing_steps) ? run.consensus.missing_steps : [];
      if (coverage.missing.length || prior.length) {
        run.consensus = { ...(run.consensus ?? {}), missing_steps: coverage.missing };
        await admin.from("boardroom_runs").update({ consensus: run.consensus }).eq("id", run.id);
      }
      await queueAuditChairMerge(admin, run, steps);
      fireSelfTick();
    }
    return;
  }

  if (run.kind === "batches") {
    const draft = steps.find((x: any) => x.step_key === "batches_chair");
    // Absent = still seeding (or orphaned before the row landed) — the
    // stalled-run detector in pipelineTick fails a run whose draft never
    // arrives. Only a real failure ends the run here: the step failed, or its
    // JSON was rejected. failRun (not a bare status write) so the siblings and
    // the project's zero-batch status are reconciled like every other failure.
    if (!draft) return;
    const draftOk = draft.status === "completed" && draft.response_json && !draft.response_json.invalid;
    if (!draftOk) {
      if (draft.status === "failed" || draft.response_json?.invalid) {
        await failRun(admin, run, draft.response_json?.validation_error ?? "batches_chair did not produce a valid response");
      }
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
      // attempt: 1 — the soft length treatment, so a revision accepted on its
      // correction pass (or revalidated on resume) is not refused here.
      const validationError = ok
        ? validateStepJson("batches_revise_chair", revise.response_json, run.kind, { attempt: 1 })
        : (revise.response_json?.validation_error ?? revise.error ?? "batches_revise_chair did not complete");
      if (!ok || validationError || !revisedList.length) {
        await failRun(
          admin,
          run,
          `The Chair's revision failed after reviewers flagged blocking issues: ${validationError ?? "empty batches list"}. Draft and reviewer notes are preserved in run_steps for diagnosis.`,
        );
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
          if (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge || e instanceof MarkdownCompactionImpossible) {
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
      if (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge || e instanceof MarkdownCompactionImpossible) {
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
    // One synthesis loop by default (vote once, then the Chair rules); the
    // admin setting max_synthesis_loops can allow up to three. A smoke run
    // always goes straight to the ruling.
    if (nextLoop < await resolveSynthesisLoopCap(admin, run)) {
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
  let claimFailed = false;
  while (claimed.length < MAX_STEP_CONCURRENCY) {
    let step: any;
    try {
      step = await claimOneStep(admin, runId, MAX_STEP_CONCURRENCY);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // A failed claim RPC leaves every step queued: that IS the requeue
      // state, so leave the run for the next tick (and let this tick's
      // other runs proceed) rather than abort the whole tick. Steps
      // already claimed in this loop still run below; with none claimed
      // the run must NOT be advanced as if it had no work.
      if (!isTransientInfraError(msg)) throw e;
      console.error(`[tick] claim failed for run=${runId}, retrying next tick: ${msg}`);
      claimFailed = true;
      break;
    }
    if (!step) break;
    claimed.push(step);
  }
  if (!claimed.length && claimFailed) return;
  if (!claimed.length) {
    // Capacity held by in-flight (executor or inline) calls: runStepsPhase
    // would report the queued sibling first and advanceRun would self-tick in
    // a loop for the life of the call (§5.2). The settle path / next cron
    // tick claims the rest. With no running rows the behaviour is unchanged.
    const steps = await loadAllSteps(admin, runId);
    if (hasRunningSteps(steps)) {
      console.log(`[tick] run ${runId}: ${steps.filter((s: any) => s.status === "running").length} step(s) in flight, not advancing`);
      return;
    }
    await afterStepComplete(admin, run);
    return;
  }
  await Promise.all(claimed.map((step) => executeStep(admin, run, step)));
  const freshRun = await getRun(admin, runId);
  if (freshRun && freshRun.status === "running") {
    await afterStepComplete(admin, freshRun);
  }
}


// Heartbeat: proves the tick is actually reaching the function. pg_cron
// reporting "succeeded" only means the HTTP request was enqueued.
async function writeTickHeartbeat(admin: any) {
  try {
    const now = new Date().toISOString();
    const { error } = await admin
      .from("app_settings")
      .upsert({ key: "orchestrator_last_tick", value: { at: now }, updated_at: now }, { onConflict: "key" });
    if (error) console.error(`[tick] heartbeat write failed: ${error.message ?? error}`);
  } catch (e) {
    console.error(`[tick] heartbeat write failed: ${(e as Error)?.message ?? e}`);
  }
}

// Stalled-run detector. A run 'running' with nothing queued or in flight for
// STALLED_RUN_MS is given one advance; if that queues nothing and the run is
// still 'running', it is failed as stalled_no_work so it stops blocking the
// one-active-run-per-kind slot and the owner sees a real error instead of a
// spinner (the Revven "stuck for 48h" shape).
async function failStalledRuns(admin: any): Promise<number> {
  const cutoff = new Date(Date.now() - STALLED_RUN_MS).toISOString();
  const { data: stale } = await admin
    .from("boardroom_runs")
    .select("*")
    .eq("status", "running")
    .lt("updated_at", cutoff)
    .limit(20);
  let failed = 0;
  for (const run of stale ?? []) {
    if (hasActiveSteps(await loadAllSteps(admin, run.id))) continue;
    await afterStepComplete(admin, run);
    const fresh = await getRun(admin, run.id);
    if (!fresh || fresh.status !== "running") continue;
    if (hasActiveSteps(await loadAllSteps(admin, run.id))) continue;
    console.log(`[tick] run ${run.id} (${run.kind}) has been running with no work since ${run.updated_at} — failing as stalled_no_work`);
    if ((await failRun(admin, fresh, "stalled_no_work")) === "won") failed++;
  }
  // Abandoned seed (isAbandonedSeed): start_run / regenerate_batches /
  // beginAudit insert the run as 'paused' and flip it to 'queued' only once
  // its first steps exist. An invocation that died in between left a paused,
  // stepless run that no tick path touches and that holds the
  // one-active-per-kind slot — fail it through failRun so an audit's row and
  // project status are reconciled like any other failure.
  const { data: seeds } = await admin
    .from("boardroom_runs")
    .select("*")
    .eq("status", "paused")
    .lt("created_at", cutoff)
    .limit(20);
  for (const run of seeds ?? []) {
    if (!isAbandonedSeed(run, await loadAllSteps(admin, run.id))) continue;
    console.log(`[tick] run ${run.id} (${run.kind}) was seeded as paused at ${run.created_at} and never received a step — failing as seeding_abandoned`);
    if ((await failRun(admin, run, "seeding_abandoned")) === "won") failed++;
  }
  return failed;
}

async function pipelineTick(admin: any) {
  try {
    return await pipelineTickBody(admin);
  } finally {
    await writeTickHeartbeat(admin);
  }
}

async function pipelineTickBody(admin: any) {
  // The collector's budget is measured from here, not from its own start:
  // an inline step may follow it in this same invocation (§5.2).
  const tickStart = Date.now();
  // Orphan sweep: queued/running steps under a run that is already terminal
  // are invisible to the watchdog (it scans 'running' steps) and to the run
  // loop (it scans active runs). Bounded UPDATE, terminal parents only.
  let orphansCancelled = 0;
  try {
    const sweep = await sweepOrphanSteps(admin);
    orphansCancelled = sweep.cancelled;
    console.log(`[tick] orphan sweep: ${sweep.cancelled} step(s) cancelled under ${sweep.terminal_runs} terminal run(s)`);
  } catch (e) {
    console.error(`[tick] orphan sweep failed: ${(e as Error)?.message ?? e}`);
  }

  // Last-resort backup for steps orphaned by a dead invocation: the platform
  // can kill an isolate at any moment (~150s cap) and take its in-isolate
  // timers with it, so a step 'running' for STALE_RUNNING_STEP_MS (160 s —
  // past the ~105 s proxy abort and the isolate cap) belongs to an
  // invocation that no longer exists. The primary timeout failover lives in
  // executeStep — this watchdog only catches the rare case where the
  // invocation died BEFORE executeStep's catch block could requeue.
  //
  // Escalation preserves prior state so we never switch back to the timed-out
  // primary model: existing force_fallback stays sticky, existing
  // _timeout_attempts is preserved, and _attempts caps the rescue count.
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_STEP_MS).toISOString();
  // Executor rows (executor_call_id set) are waiting on a Workflow that may
  // legitimately run for minutes; the collector owns their exits (§3.2).
  const { data: staleSteps } = await admin
    .from("run_steps")
    .select("id, run_id, step_key, request")
    .eq("status", "running")
    .is("executor_call_id", null)
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
        if (isStepLocalFailure(parentRun, st)) { fireSelfTick(); continue; }
        await failRun(admin, parentRun, `Step ${st.step_key} kept timing out — even the fallback model could not answer in time.`);
      }
      continue;
    }
    // Atomic parent-aware requeue via RPC — if the parent flips terminal
    // between the check above and this call, the RPC cancels the step
    // instead of resurrecting it.
    // Payload built by the pure staleRequeueRequest (hygiene.ts): sticky
    // fallback pin, low reasoning, same visible cap.
    await requeueStepIfParentActive(
      admin,
      st.id,
      staleRequeueRequest(st.request, attempts),
      "requeued_stale",
    );
  }

  // Legacy/pre-migration orphans have no started_at at all — every live claim
  // now stamps it, so a 'running' row with started_at IS NULL can only be an
  // orphan. Route each row through the parent-aware RPC so a terminal parent
  // gets 'cancelled_parent_terminal' instead of the row being bulk-flipped
  // back to 'queued' and resurrected under a dead run.
  await requeueLegacyNullStartOrphans(admin, staleCutoff);

  const stalledFailed = await failStalledRuns(admin);

  // Batch 17 collector (§5.2, §5.4): settle / re-dispatch / expire every
  // in-flight executor call. Not gated on env or flag — it runs on the
  // presence of rows, so turning the flag off or deleting the secrets is
  // safe. If the budget ran out with rows unpolled, no inline step may start
  // in this invocation (it has already spent its slack): self-tick and stop.
  let collector: CollectorStats | null = null;
  try {
    collector = await collectExecutorCalls(admin, tickStart);
    if (collector.polled > 0 || collector.exhausted || collector.breaker_tripped) {
      console.log(`[tick] executor collector: ${JSON.stringify(collector)}`);
    }
  } catch (e) {
    console.error(`[tick] executor collector failed: ${(e as Error)?.message ?? e}`);
  }
  if (collector?.exhausted) {
    fireSelfTick();
    return { processed: 0, orphans_cancelled: orphansCancelled, stalled_failed: stalledFailed, collector_exhausted: true, executor: collector };
  }

  const { data: runs } = await admin
    .from("boardroom_runs")
    .select("id")
    .in("status", ["queued", "running"])
    .limit(20);
  for (const r of runs ?? []) {
    await processRun(admin, r.id);
  }
  return { processed: (runs ?? []).length, orphans_cancelled: orphansCancelled, stalled_failed: stalledFailed };
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

  // Batch 17 fast path (§5.3): the Worker's signed result callback. Verified
  // against CALLBACK_PATH — the path WE put in callback_url — never req.url:
  // inside a hosted edge function the gateway strips the /functions/v1
  // prefix, so new URL(req.url).pathname would be "/boardroom-orchestrator"
  // while the Worker signed "/functions/v1/boardroom-orchestrator". 4xx stops
  // the Workflow's retries; a throw (500) lets it retry; the collector is the
  // backstop either way.
  if (req.headers.get("x-executor-sig")) {
    if (!EXECUTOR_SECRET) return j(404, { error: "executor not configured" });
    const raw = await req.text();
    const v = await verifyExecutorRequest(EXECUTOR_SECRET, "POST", CALLBACK_PATH, req.headers, raw, Date.now());
    if (!v.ok) return j(401, { error: v.reason });
    let body: any;
    try { body = JSON.parse(raw); } catch { return j(400, { error: "Invalid JSON" }); }
    if (body?.action !== "executor_result") return j(400, { error: "unknown executor action" });
    const stepId = String(body?.step_id ?? "");
    const callId = String(body?.call_id ?? "");
    const output = body?.output;
    if (!stepId || !callId || !isWellFormedCallOutput(output)) {
      return j(400, { error: "bad executor_result" });
    }
    const settled = await settleExecutorStep(admin, { stepId, callId }, output, "callback");
    return j(200, { ok: true, settled });
  }

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
  if (!userId) return j(401, { error: "Missing or invalid user JWT", version: BUILD_VERSION, executor: EXECUTOR_ENV ? "configured" : "off" });

  let body: any;
  try { body = await req.json(); } catch { return j(400, { error: "Invalid JSON" }); }
  const action: string = body?.action;

  // Batch 17 (§9.6): admin-only executor status for the Settings card and
  // the rollout checks (§13). Never a GET — Deno.serve answers 405.
  if (action === "executor_status") {
    const { data: isAdmin, error: roleErr } = await admin.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (roleErr) return j(500, { error: "Role check failed" });
    if (isAdmin !== true) return j(403, { error: "Executor status is admin-only" });
    const setting = await loadExecutorSettings(admin, true);
    const { count } = await admin
      .from("run_steps")
      .select("id", { count: "exact", head: true })
      .not("executor_call_id", "is", null);
    const { data: mark } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", "executor_last_settle")
      .maybeSingle();
    return j(200, {
      configured: !!EXECUTOR_ENV,
      enabled: setting?.enabled === true,
      transport: setting?.transport ?? "sse",
      in_flight: count ?? 0,
      last_settle: mark?.value ?? null,
      version: BUILD_VERSION,
    });
  }

  if (action === "start_run") {
    const projectId: string = body?.project_id;
    const kind: string = body?.kind;
    const changeRequestId: string | undefined = body?.change_request_id;
    if (!projectId || !kind) return j(400, { error: "Missing project_id or kind" });
    if (!["test", "plan", "features", "design", "change_request", "audit", "batches"].includes(kind)) {
      return j(400, { error: "Invalid kind" });
    }
    // Smoke mode (RC-9): the $1 rehearsal of a run kind — no revision loops,
    // no repo sample, three batches with one reviewer, every seat on the
    // cheap smoke model. Admin-only: it is a pipeline check, not a product.
    const smoke = body?.smoke === true;
    if (smoke) {
      const { data: isAdmin, error: roleErr } = await admin.rpc("has_role", { _user_id: userId, _role: "admin" });
      if (roleErr) return j(500, { error: "Role check failed" });
      if (isAdmin !== true) return j(403, { error: "Smoke runs are admin-only" });
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

    // Imports: re-derive workflow from persisted intake goals and evaluate
    // the pure scope gate. The server is the authority — never trust
    // request-body scope. Non-imports keep their existing gates below.
    if (project.is_import && (kind === "plan" || kind === "design" || kind === "batches")) {
      const { deriveImportWorkflow } = await import("../_shared/import-workflow.ts");
      const { evaluateStartRunGate } = await import("../_shared/import-scope-gates.ts");

      const { data: intake, error: intakeErr } = await admin
        .from("intakes")
        .select("answers")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (intakeErr) {
        return j(500, { error: `Could not load intake for scope gate: ${intakeErr.message}` });
      }
      const answers = (intake?.answers ?? {}) as Record<string, unknown>;
      const workflow = deriveImportWorkflow(answers?.goals);

      // Audit completion: successful A–Z audit exists (clean|findings).
      const { data: auditRows, error: auditErr } = await admin
        .from("audits")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .eq("kind", "final_az")
        .in("status", ["clean", "findings"])
        .limit(1);
      if (auditErr) return j(500, { error: `Could not load audit state: ${auditErr.message}` });
      const auditComplete = (auditRows?.length ?? 0) > 0;

      // Locked plan / locked design (build-safe rows).
      const [planLockedRow, designLockedRow] = await Promise.all([
        admin
          .from("plan_versions")
          .select("id")
          .eq("project_id", projectId)
          .eq("kind", "plan")
          .eq("is_build_safe", true)
          .limit(1)
          .maybeSingle(),
        admin
          .from("plan_versions")
          .select("id")
          .eq("project_id", projectId)
          .eq("kind", "design")
          .eq("is_build_safe", true)
          .limit(1)
          .maybeSingle(),
      ]);
      if (planLockedRow.error) return j(500, { error: `Could not load plan state: ${planLockedRow.error.message}` });
      if (designLockedRow.error) return j(500, { error: `Could not load design state: ${designLockedRow.error.message}` });

      const decision = evaluateStartRunGate(workflow, kind as "plan" | "design" | "batches", {
        auditComplete,
        planLocked: !!planLockedRow.data,
        designLocked: !!designLockedRow.data,
        hasRepo: !!project.github_repo,
      });
      if (!decision.allowed) {
        return j(409, { error: decision.reason, next_step: decision.nextStep });
      }

    } else {
      // Legacy / non-import gates are preserved unchanged.
      if (kind === "plan" && project.is_import) {
        // Never taken (guarded above); kept for symmetry.
      }
      if (kind === "design" || kind === "batches") {
        const locked = await loadLockedPlan(admin, projectId);
        if (!locked) {
          return j(400, {
            error: kind === "design"
              ? "The board locks a build-safe plan before it debates the look."
              : "The board locks a build-safe plan before it sequences the build.",
          });
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
        .select("id, user_id, project_id, status, plan_version_id")
        .eq("id", changeRequestId)
        .maybeSingle();
      if (!cr || cr.user_id !== userId || cr.project_id !== projectId) {
        return j(404, { error: "Change request not found" });
      }
      if (cr.status !== "pending") return j(400, { error: "Change request is not pending" });
      if (!cr.plan_version_id) {
        return j(400, { error: "Change request is not attached to a build-safe plan version." });
      }
      const { data: planRow } = await admin
        .from("plan_versions")
        .select("id, project_id, kind, is_build_safe")
        .eq("id", cr.plan_version_id)
        .maybeSingle();
      if (
        !planRow ||
        planRow.project_id !== projectId ||
        planRow.kind !== "plan" ||
        planRow.is_build_safe !== true
      ) {
        return j(400, { error: "This change request targets a plan version that is not build-safe. File a new change request against the current plan." });
      }
      consensusMeta = { change_request_id: changeRequestId };
    }

    const { data: constRow } = await admin
      .from("app_settings")
      .select("version")
      .eq("key", "constitution")
      .maybeSingle();

    if (smoke) consensusMeta = { ...(consensusMeta ?? {}), smoke: true };
    // Batch 17 (§4): per-run executor override, smoke runs only (already
    // admin-gated above). keepSmoke carries it across consensus rewrites.
    if (smoke && typeof body?.executor === "boolean") consensusMeta.executor = body.executor;
    const budget = runBudgetUsd(kind, smoke);
    const { data: run, error: rerr } = await admin
      .from("boardroom_runs")
      .insert({
        project_id: projectId,
        user_id: userId,
        kind,
        // Seeded while 'paused': the tick ignores it, the one-active-per-kind
        // index still covers it, and it becomes 'queued' only once its first
        // steps exist. The per-minute cron used to find the freshly inserted
        // run with zero steps and fail it a second later (run cfa73001).
        status: "paused",
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
      // Never leave a paused, stepless run holding the active slot.
      await admin
        .from("boardroom_runs")
        .update({ status: "failed", error: (e as Error)?.message ?? String(e) })
        .eq("id", run.id);
      if (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge || e instanceof MarkdownCompactionImpossible) {
        return j(400, { error: e.message });
      }
      throw e;
    }
    const { error: flipErr } = await admin
      .from("boardroom_runs")
      .update({ status: "queued" })
      .eq("id", run.id)
      .eq("status", "paused");
    if (flipErr) return j(500, { error: `Run seeded but could not be queued: ${flipErr.message}` });
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
      // Never trust arbitrary extra_budget_usd. Shared validator caps a
      // single addition at $10 and total run budget at $30. The separate
      // server-enforced daily cap (runtime app_settings) is unchanged.
      // Rejects with structured 400 — do NOT silently clamp.
      const { validateResumeBudget } = await import("../_shared/resume-budget.ts");
      const check = validateResumeBudget(body?.extra_budget_usd, Number(run.budget_usd ?? 0));
      if (!check.ok) return j(400, { error: check.error });

      const patch: any = { status: "queued", error: null };
      if (check.extra > 0) patch.budget_usd = check.newTotal;
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
      .select("*")
      .eq("id", runId)
      .maybeSingle();
    if (!run || run.user_id !== userId) return j(404, { error: "Run not found" });
    const { data: step } = await admin
      .from("run_steps")
      .select("id, step_key, status, error, request, response_text, response_json")
      .eq("id", stepId)
      .eq("run_id", runId)
      .maybeSingle();
    if (!step) return j(404, { error: "Step not found" });
    if (step.status !== "failed") return j(400, { error: "Only failed steps can be retried" });
    if (run.status === "failed") {
      // Reopen the run as 'paused' BEFORE the step is requeued: the tick's
      // orphan sweep cancels queued steps under a terminal parent, so a step
      // requeued while the run is still 'failed' could be swept in between.
      // 'paused' counts as active for the one-active-per-kind index and the
      // sweep, and is ignored by processRun and the stalled-run detector.
      const { data: claimed, error: claimErr } = await admin
        .from("boardroom_runs")
        .update({ status: "paused" })
        .eq("id", runId)
        .eq("status", "failed")
        .select("id");
      if (claimErr) return j(409, { error: `Could not reopen the run: ${claimErr.message}` });
      if (!claimed?.length) return j(409, { error: "Run is no longer failed — refresh and try again." });
    }
    // Stored output that the current rules accept completes the step from
    // the row (no model call); otherwise reset attempt markers / reserve pin
    // / correction turn so the retried step gets its correction pass back
    // instead of failing on first miss.
    const revalidated = await completeStepFromStoredOutput(admin, run, step);
    if (!revalidated) {
      // Guarded on 'failed' (like resume_failed) so a retry racing a late
      // executor settle cannot flip a just-completed row back to queued; the
      // executor columns are NULLed so a stale instance's verdict is never
      // consulted (its money is still ledgered by the stale rule, §5.10).
      await admin
        .from("run_steps")
        .update({
          status: "queued",
          error: null,
          completed_at: null,
          started_at: null,
          request: resetRequestForResume(step.request, step.error),
          executor_call_id: null,
          executor_dispatched_at: null,
          executor_meta: null,
        })
        .eq("id", stepId)
        .eq("status", "failed");
    }
    if (run.status === "failed") {
      // Same reconciliation as resume_failed: failRun marked the audits row
      // failed and rewound a final audit's project, so undo both before the
      // run works again — otherwise the Audit Center shows a failed audit
      // under a run that is still producing its findings.
      await reverseAuditFailure(admin, run);
      await admin.from("boardroom_runs").update({ status: "running", error: null }).eq("id", runId).eq("status", "paused");
    }
    fireSelfTick();
    return j(200, { ok: true, revalidated });
  }

  // RC-2: resume a failed run where it stopped. Every sibling failRun
  // cancelled and the step(s) that actually failed are requeued with their
  // attempt markers reset; completed (paid) steps are kept. Steps are
  // requeued while the run is 'paused' (claimed from 'failed' first, flipped
  // to running last) — direct updates, because requeue_step_if_parent_active
  // refuses a failed parent — so a concurrent tick can neither sweep the
  // requeued steps as orphans of a terminal run nor see a processable run
  // with nothing to claim and mis-finalize it. Idempotent: a second call
  // finds the run active and returns it.
  if (action === "resume_failed") {
    const runId: string = body?.run_id;
    if (!runId) return j(400, { error: "Missing run_id" });
    const { data: run } = await admin
      .from("boardroom_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();
    if (!run || run.user_id !== userId) return j(404, { error: "Run not found" });
    if (["queued", "running", "paused", "paused_budget"].includes(run.status)) {
      return j(200, { ok: true, run_id: run.id, status: run.status, existing: true });
    }
    if (run.status !== "failed") return j(400, { error: "Only failed runs can be resumed" });
    {
      const { data: activeRuns } = await admin
        .from("boardroom_runs")
        .select("id")
        .eq("project_id", run.project_id)
        .eq("kind", run.kind)
        .in("status", ["queued", "running", "paused", "paused_budget"])
        .limit(1);
      if (activeRuns && activeRuns.length > 0) {
        return j(409, { error: `Another ${run.kind} run is already active for this project. Wait for it or cancel it first.` });
      }
    }
    const { validateResumeBudget } = await import("../_shared/resume-budget.ts");
    const check = validateResumeBudget(body?.extra_budget_usd, Number(run.budget_usd ?? 0));
    if (!check.ok) return j(400, { error: check.error });

    const steps = await loadAllSteps(admin, run.id);
    // What to touch is decided by the pure planResumeFailed (hygiene.ts):
    // a merge that failed / was cancelled / (legacy) failed validation is
    // dropped so a fresh merge can be queued; a merge that completed and
    // only the supersession after it failed is kept and NO seat is re-run
    // (its findings could never reach the finished merge) — the tick simply
    // re-enters finalizeAudit.
    const { chair, chairDead, finalizeRetry, requeue } = planResumeFailed(run, steps);
    if (!requeue.length && !chairDead && !finalizeRetry && !steps.some((x: any) => x.status === "queued")) {
      return j(400, { error: "Nothing to resume on this run — start a fresh one." });
    }
    // Reopen the run as 'paused' BEFORE any step is requeued: the tick's
    // orphan sweep cancels queued steps under a terminal parent, and the run
    // stays 'failed' until the flip below. 'paused' is active for the
    // one-active-per-kind index and the sweep, yet processRun and the
    // stalled-run detector ignore it, so a concurrent tick still cannot see
    // an active run with nothing to claim and mis-finalize it.
    {
      const { data: claimed, error: claimErr } = await admin
        .from("boardroom_runs")
        .update({ status: "paused" })
        .eq("id", run.id)
        .eq("status", "failed")
        .select("id");
      if (claimErr) return j(409, { error: `Could not reopen the run: ${claimErr.message}` });
      if (!claimed?.length) return j(409, { error: "Run is no longer failed — refresh and try again." });
    }
    let requeued = 0;
    let revalidated = 0;
    for (const st of requeue) {
      // A step whose stored answer the current rules accept is completed from
      // the row; the normal advance picks it up once the run is running.
      if (await completeStepFromStoredOutput(admin, run, st)) {
        revalidated++;
        continue;
      }
      const patch: any = {
        status: "queued",
        error: null,
        completed_at: null,
        started_at: null,
        // Batch 17: a resumed step never carries a stale executor call (§5.10).
        executor_call_id: null,
        executor_dispatched_at: null,
        executor_meta: null,
      };
      if (st.error !== "cancelled_parent_terminal") {
        patch.request = resetRequestForResume(st.request, st.error);
      }
      await admin.from("run_steps").update(patch).eq("id", st.id).eq("status", "failed");
      requeued++;
    }
    if (chairDead) {
      await admin.from("run_steps").delete().eq("id", chair.id);
      // With seat retries in flight the fan-in (afterStepComplete) queues
      // the merge once they are terminal; otherwise queue it right away.
      if (requeued === 0) {
        // A seat completed from its stored output above is 'completed' in
        // the table but still 'failed' in the list loaded before the loop;
        // reload so its findings reach the merge.
        const fresh = revalidated > 0 ? await loadAllSteps(admin, run.id) : steps;
        await queueAuditChairMerge(admin, run, fresh.filter((x: any) => x.id !== chair.id));
      }
    }
    await reverseAuditFailure(admin, run);
    const patch: any = { status: "running", error: null };
    if (check.extra > 0) patch.budget_usd = check.newTotal;
    await admin.from("boardroom_runs").update(patch).eq("id", run.id).eq("status", "paused");
    fireSelfTick();
    return j(200, { ok: true, run_id: run.id, requeued, revalidated, merge_requeued: chairDead });
  }

  // Owner cancel: terminalize an active run through failRun so every
  // queued/running step is cancelled and the audits/projects rows are
  // reconciled exactly as on any other failure. Also frees beginAudit's
  // one-active-run-per-kind short-circuit.
  if (action === "cancel") {
    const runId: string = body?.run_id;
    if (!runId) return j(400, { error: "Missing run_id" });
    const { data: run } = await admin
      .from("boardroom_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();
    if (!run || run.user_id !== userId) return j(404, { error: "Run not found" });
    if (!["queued", "running", "paused", "paused_budget"].includes(run.status)) {
      return j(400, { error: "Only an active run can be cancelled" });
    }
    const outcome = await failRun(admin, run, "cancelled_by_owner");
    return j(200, { ok: true, outcome });
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
        // Seeded while 'paused', queued once the steps exist (see start_run).
        status: "paused",
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
      const msg = (e instanceof RepoContractUnavailable || e instanceof BatchContextTooLarge || e instanceof MarkdownCompactionImpossible)
        ? e.message
        : `Failed to seed regen run (restored old batches): ${(e as Error).message}`;
      return j(400, { error: msg });
    }
    const { error: flipErr } = await admin
      .from("boardroom_runs")
      .update({ status: "queued" })
      .eq("id", run.id)
      .eq("status", "paused");
    if (flipErr) {
      await admin
        .from("boardroom_runs")
        .update({ status: "failed", error: `Run seeded but could not be queued: ${flipErr.message}` })
        .eq("id", run.id);
      await restore();
      return j(500, { error: `Run seeded but could not be queued (restored old batches): ${flipErr.message}` });
    }
    fireSelfTick();
    return j(200, { run_id: run.id, archived_count: list.length });
  }

  return j(400, { error: "Unknown action" });
}

