// deno-lint-ignore-file no-explicit-any
// OWNER-AUTHORITY-CORRECTION-R6 — bounded fail-closed correction wrapper.
//
// A candidate artifact (plan/design content_md, PRD, features, change-request
// amendments, batch prompt_md, fix batch prompt_md) that fails the
// deterministic owner-authority gate is NOT silently discarded. Instead the
// wrapper queues a dedicated Chair authority-correction step containing the
// exact violations + allowed owner sources, re-runs the gate on the corrected
// candidate, and permits at most AUTHORITY_CORRECTION_MAX attempts per
// candidate. Only after that budget is exhausted (or the corrected candidate
// still fabricates an OWNER-AUTHORIZED marker without a verbatim source) does
// the run terminally fail with proposal_requires_owner_approval.
//
// This is orthogonal to the plan/design 3-loop consensus protocol: correction
// does not reset dissent or manufacture consensus. Existing loop_no,
// dissent_ledger, and prior consensus scores are preserved verbatim on the
// run — the correction state lives under consensus.authority_correction.
import {
  findUnauthorizedHighImpact,
  loadOwnerAuthority,
  OWNER_AUTHORITY_RULES,
  preLockAuthorityError,
  type OwnerAuthority,
} from "./owner-authority.ts";

export { loadOwnerAuthority };
export type { OwnerAuthority };

export const AUTHORITY_CORRECTION_MAX = 2;

// The correction step must sort AFTER every prior step in the run so
// attempt 2 lands after attempt 1 and neither collides with earlier
// protocol rounds (plan/design consensus, dissent capture, etc). Pure
// helper: given the max existing round on the run and the correction
// attempt number about to be queued, return the round to use.
// - When the DB max is a real number, next = max + 1 always wins.
// - When the DB max is null (query unavailable / no rows / test double),
//   the fallback floor scales with the attempt so attempt 1 lands at >=7
//   and attempt 2 lands at >=8. This preserves monotonicity across
//   attempts even when the max query fails.
export function nextCorrectionRound(
  currentMaxRound: number | null,
  nextAttempt = 1,
  baseFloor = 7,
): number {
  const attempt = Number.isFinite(nextAttempt) && nextAttempt >= 1 ? Math.floor(nextAttempt) : 1;
  const minSafe = baseFloor + (attempt - 1);
  if (typeof currentMaxRound === "number" && Number.isFinite(currentMaxRound)) {
    const next = currentMaxRound + 1;
    return next < minSafe ? minSafe : next;
  }
  return minSafe;
}

export type AuthorityPhase =
  | "pre_lock_plan"
  | "pre_finalize_blueprint"
  | "pre_finalize_change_request"
  | "pre_promote_batches"
  | "pre_insert_fix_batch";

export type Artifact = { key: string; label: string; text: string };

export type AuthorityCorrectionState = {
  phase: AuthorityPhase;
  attempt: number; // 0..MAX; N when attempt N has been queued
  awaiting_step_key: string | null;
  processed_step_id: string | null;
  artifact_keys: string[];
  corrected: Record<string, string>;
  violations_history: Array<{ attempt: number; violations: string }>;
};

// ---- Pure helpers -----------------------------------------------------------

export function overlayArtifacts(
  artifacts: Artifact[],
  state: AuthorityCorrectionState | null | undefined,
  phase: AuthorityPhase,
): Artifact[] {
  if (!state || state.phase !== phase || !state.corrected) return artifacts;
  return artifacts.map((a) =>
    typeof state.corrected[a.key] === "string"
      ? { ...a, text: state.corrected[a.key] }
      : a
  );
}

export function violationsSummary(
  artifacts: Artifact[],
  authority: OwnerAuthority,
): string {
  const parts: string[] = [];
  for (const a of artifacts) {
    const t = String(a?.text ?? "");
    if (!t.trim()) continue;
    const issues = findUnauthorizedHighImpact(t, authority);
    if (!issues.length) continue;
    parts.push(`* ${a.label} (key="${a.key}"):`);
    for (const i of issues.slice(0, 8)) {
      parts.push(`  - [${i.category}] "${i.snippet}"`);
    }
    if (issues.length > 8) parts.push(`  (+${issues.length - 8} more)`);
  }
  return parts.join("\n");
}

// Thin passthrough — callers use this instead of importing preLockAuthorityError
// directly so a static scanner can enforce the "no raw preLock call in
// orchestrator finalize paths" rule (OWNER-AUTHORITY-CORRECTION-R6 §4 static
// test).
export function computeAuthorityViolationError(
  artifacts: Artifact[],
  authority: OwnerAuthority,
): string | null {
  return preLockAuthorityError(
    artifacts.map((a) => ({ label: a.label, text: a.text })),
    authority,
  );
}

// ---- Chair correction prompt -----------------------------------------------

export const CORRECTION_SYSTEM = `${OWNER_AUTHORITY_RULES}

AUTHORITY CORRECTION (fail-closed). A deterministic post-validator blocked the previous candidate because it contained high-impact directives the owner never authorized (pricing / monetary amounts, external providers, destructive SQL, disabling existing systems, broadening auth or bypassing RLS, custom domains, or public sign-ups).

Rewrite the flagged artifacts so that:
- Every unauthorized directive is REMOVED, or REPLACED with an explicit "[OWNER DECISION REQUIRED: <one-line question the owner must answer>]" placeholder — a pricing, provider, integration, auth-scope, domain, or retire/disable choice the owner still has to make. The Board may recommend that the owner decide/test something; it MAY NOT commit them.
- Nothing is stamped with an [OWNER-AUTHORIZED: ...] marker unless the exact quote appears verbatim (case/whitespace-insensitive) in an allowed owner source (intake, founder_notes, or an approved change_request). FABRICATING A MARKER IS AN AUTOMATIC REJECTION — the deterministic validator will fail your correction and the run will terminate.
- Every uncontested paragraph in the artifact is preserved verbatim. Do NOT re-open resolved debate points, re-run the plan, or manufacture consensus. Loop / dissent ledger are already finalized upstream and must not be edited here.

Return ONLY valid JSON:
{
  "corrected": { "<artifact_key>": "<full replacement text for that artifact>" },
  "notes": "One paragraph naming what you removed, and what you turned into an [OWNER DECISION REQUIRED] placeholder."
}

Every artifact key listed under "ARTIFACTS TO CORRECT" MUST appear in "corrected" as a full, non-empty replacement string. Do not omit keys, do not return empty strings, do not add extra keys. Do not shorten unrelated content.`;

export function buildCorrectionUserMessage(opts: {
  authority: OwnerAuthority;
  artifacts: Artifact[];
  violations: string;
  attempt: number;
  phase: AuthorityPhase;
}): string {
  const artifactsBlock = opts.artifacts
    .map((a) =>
      `--- key="${a.key}" | ${a.label} ---\n${String(a.text ?? "")}`
    )
    .join("\n\n");
  return `${opts.authority.block}

PHASE: ${opts.phase}
CORRECTION ATTEMPT: ${opts.attempt} of ${AUTHORITY_CORRECTION_MAX}

DETERMINISTIC VIOLATIONS (each MUST be removed or replaced with an [OWNER DECISION REQUIRED] placeholder — you cannot cite these snippets as authorized because no owner source contains a matching verbatim quote):
${opts.violations}

ARTIFACTS TO CORRECT (return every key under "corrected" with a full, non-empty replacement string — even if you only edit part of the artifact, return the ENTIRE corrected artifact):

${artifactsBlock}

Produce the JSON now.`;
}

export function validateCorrectionResponse(
  parsed: any,
  requiredKeys: string[],
): string | null {
  if (!parsed || typeof parsed !== "object") {
    return "Correction response is not a JSON object.";
  }
  const corrected = parsed.corrected;
  if (!corrected || typeof corrected !== "object") {
    return "Missing corrected object.";
  }
  for (const k of requiredKeys) {
    const v = (corrected as any)[k];
    if (typeof v !== "string" || !v.trim()) {
      return `corrected["${k}"] must be a non-empty string full replacement.`;
    }
  }
  return null;
}

// ---- Orchestrator wrapper --------------------------------------------------

export type EnforceContext = {
  admin: any;
  run: any;
  phase: AuthorityPhase;
  authority: OwnerAuthority;
  artifacts: Artifact[];
  onTerminalFail: (error: string, phase: AuthorityPhase) => Promise<void>;
  // Extra metadata persisted alongside authority_correction state so
  // afterStepComplete can re-invoke the finalize function with the same
  // parameters after a correction completes.
  restartMeta?: Record<string, unknown>;
};

export type EnforceResult =
  | { status: "clean"; artifacts: Artifact[] }
  | { status: "pending" }
  | { status: "failed_terminal"; error: string };

export async function enforceAuthorityOrCorrect(
  ctx: EnforceContext,
): Promise<EnforceResult> {
  const stateAny: AuthorityCorrectionState | null =
    ctx.run?.consensus?.authority_correction ?? null;
  const state = stateAny && stateAny.phase === ctx.phase ? stateAny : null;
  const overlayed = overlayArtifacts(ctx.artifacts, state, ctx.phase);
  const err = computeAuthorityViolationError(overlayed, ctx.authority);
  if (!err) return { status: "clean", artifacts: overlayed };

  const priorAttempts = state?.attempt ?? 0;
  const nextAttempt = priorAttempts + 1;
  const violations = violationsSummary(overlayed, ctx.authority);

  if (nextAttempt > AUTHORITY_CORRECTION_MAX) {
    // Record the final unsafe correction in consensus so observers can
    // diagnose which attempts failed and why.
    const finalState: AuthorityCorrectionState = {
      phase: ctx.phase,
      attempt: priorAttempts,
      awaiting_step_key: null,
      processed_step_id: state?.processed_step_id ?? null,
      artifact_keys: overlayed.map((a) => a.key),
      corrected: state?.corrected ?? {},
      violations_history: [
        ...(state?.violations_history ?? []),
        { attempt: nextAttempt, violations: `terminal: ${violations}` },
      ],
    };
    const nextConsensus = {
      ...(ctx.run.consensus ?? {}),
      authority_correction: finalState,
    };
    try {
      await ctx.admin
        .from("boardroom_runs")
        .update({
          consensus: nextConsensus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ctx.run.id);
    } catch { /* best-effort */ }
    ctx.run.consensus = nextConsensus;
    await ctx.onTerminalFail(err, ctx.phase);
    return { status: "failed_terminal", error: err };
  }

  const stepKey = `authority_correction_chair_attempt${nextAttempt}`;
  const user = buildCorrectionUserMessage({
    authority: ctx.authority,
    artifacts: overlayed,
    violations,
    attempt: nextAttempt,
    phase: ctx.phase,
  });

  // Query the current max round on the run so correction attempt N always
  // sorts after attempt N-1 (and after any newly-added protocol rounds).
  // Fall back to the protocol-safe minimum on any query failure — test
  // doubles / transient errors must not silently collapse attempts to the
  // same round.
  let currentMax: number | null = null;
  try {
    const res: any = await ctx.admin
      .from("run_steps")
      .select("round")
      .eq("run_id", ctx.run.id)
      .order("round", { ascending: false })
      .limit(1)
      .maybeSingle();
    const r = res?.data?.round;
    currentMax = typeof r === "number" ? r : null;
  } catch { /* fall through to minSafe */ }
  const roundNo = nextCorrectionRound(currentMax);

  await ctx.admin.from("run_steps").insert({
    run_id: ctx.run.id,
    user_id: ctx.run.user_id,
    step_key: stepKey,
    round: roundNo,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      reasoning_effort: "low",
      max_tokens: 8000,
      messages: [
        { role: "system", content: CORRECTION_SYSTEM },
        { role: "user", content: user },
      ],
    },
  });

  const nextState: AuthorityCorrectionState = {
    phase: ctx.phase,
    attempt: nextAttempt,
    awaiting_step_key: stepKey,
    processed_step_id: state?.processed_step_id ?? null,
    artifact_keys: overlayed.map((a) => a.key),
    corrected: state?.corrected ?? {},
    violations_history: [
      ...(state?.violations_history ?? []),
      { attempt: nextAttempt, violations },
    ],
  };
  const nextConsensus = {
    ...(ctx.run.consensus ?? {}),
    ...(ctx.restartMeta ?? {}),
    authority_correction: { ...nextState, ...(ctx.restartMeta ?? {}) },
  };
  await ctx.admin
    .from("boardroom_runs")
    .update({
      consensus: nextConsensus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ctx.run.id);
  ctx.run.consensus = nextConsensus;
  return { status: "pending" };
}

// Called from afterStepComplete when the awaited correction step has
// finished. Merges the corrected artifacts into consensus.authority_correction
// so the next enforce call overlays them. Idempotent — safe to call twice for
// the same step id.
export async function absorbCorrectionStep(
  admin: any,
  run: any,
  step: any,
): Promise<{ phase: AuthorityPhase | null; ok: boolean; error: string | null }> {
  const state: AuthorityCorrectionState | null =
    run?.consensus?.authority_correction ?? null;
  if (!state) return { phase: null, ok: false, error: "missing_state" };
  if (state.processed_step_id === step.id) {
    return { phase: state.phase, ok: true, error: null };
  }
  const parsed = step?.response_json ?? null;
  const vErr = validateCorrectionResponse(parsed, state.artifact_keys);
  if (vErr) {
    const nextState: AuthorityCorrectionState = {
      ...state,
      awaiting_step_key: null,
      processed_step_id: step.id,
      violations_history: [
        ...(state.violations_history ?? []),
        { attempt: state.attempt, violations: `correction_response_invalid: ${vErr}` },
      ],
    };
    const nextConsensus = {
      ...(run.consensus ?? {}),
      authority_correction: nextState,
    };
    await admin
      .from("boardroom_runs")
      .update({
        consensus: nextConsensus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    run.consensus = nextConsensus;
    return { phase: state.phase, ok: false, error: vErr };
  }
  const correctedIn = parsed.corrected as Record<string, string>;
  const nextCorrected: Record<string, string> = { ...(state.corrected ?? {}) };
  for (const k of state.artifact_keys) nextCorrected[k] = correctedIn[k];
  const nextState: AuthorityCorrectionState = {
    ...state,
    awaiting_step_key: null,
    processed_step_id: step.id,
    corrected: nextCorrected,
  };
  const nextConsensus = {
    ...(run.consensus ?? {}),
    authority_correction: nextState,
  };
  await admin
    .from("boardroom_runs")
    .update({
      consensus: nextConsensus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);
  run.consensus = nextConsensus;
  return { phase: state.phase, ok: true, error: null };
}

// Locate the correction step this run is waiting on (any status). Returns
// null when no correction is awaited.
export function findAwaitedCorrectionStep(run: any, steps: any[]): any | null {
  const state: AuthorityCorrectionState | null =
    run?.consensus?.authority_correction ?? null;
  if (!state?.awaiting_step_key) return null;
  return steps.find((s: any) => s.step_key === state.awaiting_step_key) ?? null;
}
