// deno-lint-ignore-file no-explicit-any
// The board's protocol: seats, rubrics, step validation, consensus rules,
// and the pure helpers that read candidate documents out of step history.
// No step queuing here; the only I/O is the consensus-threshold lookup.

import { CAPS, evaluateChairMergeCandidate } from "../_shared/audit-findings.ts";

export const SEATS = ["chair", "strategist", "contrarian", "inspector"] as const;

export type Seat = typeof SEATS[number];



export const SEAT_LABEL: Record<Seat, string> = {
  chair: "The Chair",
  strategist: "The Strategist",
  contrarian: "The Contrarian",
  inspector: "The Inspector",
};


export const PLAN_RUBRIC = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
  "wow_factor",
] as const;

export const DESIGN_RUBRIC = [
  "distinctiveness",
  "premium_feel",
  "usability",
  "buildable_in_lovable",
  "coherence",
  "signature_element",
] as const;

export function rubricForKind(kind: string): readonly string[] {
  return kind === "design" ? DESIGN_RUBRIC : PLAN_RUBRIC;
}


export function intakeBlock(intake: any) {
  const a = intake?.answers ?? {};
  if (a?.imported) {
    const goals = Array.isArray(a.goals) ? a.goals.join(", ") : "";
    return `IMPORT INTAKE (owner already built this app)
Description: ${a.description ?? ""}
Goals for the board: ${goals || "(none stated)"}`;
  }
  return `INTAKE ANSWERS
Idea: ${a.idea ?? ""}
Buyer: ${a.buyer ?? ""}
Pain: ${a.pain ?? ""}
Monetization: ${a.money ?? ""}
Inspiration: ${a.inspiration ?? ""}

VALIDATION SCORES
${JSON.stringify(intake?.validation_scores ?? null, null, 2)}`;
}



// `maxCharsPerDraft` bounds each draft (design Round-3 input diet, RC-4): the
// cut is on a code-point boundary and carries an explicit note so the Chair
// knows the draft continues past what it sees. Unset = full drafts (Round 2
// exams need them whole).
export function draftsBlock(steps: any[], forSeat?: Seat, maxCharsPerDraft?: number) {
  return SEATS
    .filter((s) => (forSeat ? s !== forSeat : true))
    .map((s) => {
      const step = steps.find((x) => x.step_key === `r1_draft_${s}` && x.status === "completed");
      let text = String(step?.response_text ?? "(no draft)");
      if (maxCharsPerDraft && maxCharsPerDraft > 0 && text.length > maxCharsPerDraft) {
        let cut = maxCharsPerDraft;
        const code = text.charCodeAt(cut - 1);
        if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
        text = `${text.slice(0, cut)}\n\n[draft truncated at ${maxCharsPerDraft} chars of ${text.length}]`;
      }
      return `--- ${SEAT_LABEL[s]} (${s}) DRAFT ---\n${text}`;
    })
    .join("\n\n");
}


// A step's stored response_json as it may be re-sent to the NEXT model.
// The orchestrator persists a diagnostic `_meta` (finish_reason, token
// counts, wire cap, fallback) on every step row; that is for the UI and for
// humans reading the row, never prompt material — stringifying it into a
// later prompt leaks internal budgets and invites the model to echo the key
// back. Pure; non-objects and arrays pass through untouched.
export function promptJson(json: any): any {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const { _meta: _omit, ...rest } = json;
  return rest;
}


export function objectionsAndStealsBlock(steps: any[]) {
  const parts: string[] = [];
  for (const s of SEATS) {
    const step = steps.find((x) => x.step_key === `r2_exam_${s}` && x.status === "completed");
    if (!step?.response_json) continue;
    const j = promptJson(step.response_json);
    parts.push(`--- ${SEAT_LABEL[s]} (${s}) — OBJECTIONS AND STEALS ---
${JSON.stringify(j, null, 2)}`);
  }
  return parts.join("\n\n");
}


// `threshold` is the resolved consensus gate (resolveConsensusThreshold) so
// the Chair is shown the same bar the vote was judged against.
export function priorRoundFailureBlock(steps: any[], previousLoop: number, threshold: number = 8) {
  const votes = SEATS
    .map((s) => steps.find((x) => x.step_key === `r4_vote_${s}_loop${previousLoop}` && x.status === "completed"))
    .filter(Boolean);
  const blocking: string[] = [];
  const lowScores: string[] = [];
  for (const v of votes as any[]) {
    const jj = v.response_json ?? {};
    (jj.blocking_objections ?? []).forEach((b: string) => blocking.push(`- [${v.seat}] ${b}`));
    for (const k of [...PLAN_RUBRIC, ...DESIGN_RUBRIC]) {
      const n = Number(jj?.scores?.[k]);
      if (Number.isFinite(n) && n < threshold) lowScores.push(`- [${v.seat}] ${k}: ${n}`);
    }
  }
  return `PRIOR VOTE FAILED (loop ${previousLoop})

BLOCKING OBJECTIONS STILL STANDING:
${blocking.length ? blocking.join("\n") : "(none)"}

RUBRIC SCORES BELOW ${threshold}:
${lowScores.length ? lowScores.join("\n") : "(none)"}

Revise ONLY the contested parts. Preserve agreed parts verbatim.`;
}


// The candidate document for a loop — two-phase draft first, legacy JSON
// synthesis (pre-upgrade runs) as fallback.
export function candidateForLoop(steps: any[], loop: number): string {
  const draft = steps.find((x: any) => x.step_key === `r3_draft_chair_loop${loop}` && x.status === "completed");
  if (String(draft?.response_text ?? "").trim()) return String(draft.response_text);
  const legacy = steps.find((x: any) => x.step_key === `r3_synthesis_chair_loop${loop}` && x.status === "completed");
  return String(legacy?.response_json?.candidate_md ?? legacy?.response_text ?? "");
}


export function lastCandidateLoop(steps: any[]): number {
  return Math.max(-1, ...steps
    .filter((x: any) => (x.step_key.startsWith("r3_draft_chair_loop") || x.step_key.startsWith("r3_synthesis_chair_loop")) && x.status === "completed")
    .map((x: any) => Number(/_loop(\d+)$/.exec(x.step_key)?.[1] ?? -1)));
}


// ============================== Validation ==============================

function clipText(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

// "The Chair" / "Chair" / "chair" -> "chair". Anything else passes through
// untouched so the validator still rejects an unknown seat.
export function seatIdFromLabel(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const key = v.trim().toLowerCase().replace(/^the\s+/, "");
  return (SEATS as readonly string[]).includes(key) ? key : v;
}

// Normalize-then-validate. Models round-trip the schema with small,
// mechanical deviations (a 7.5 score, "The Inspector" for a seat id, a
// "resolved" objection with no quote, nine review issues, a 300-char issue
// text, batch_no 1,2,2,4) that used to cost a full correction pass and, on
// the second miss, the run. Each of those is coerced here deterministically
// — never invented — and the coerced value is what validateStepJson sees and
// what the caller must persist. Hard failures (a missing required top-level
// key, a non-numeric score, a prompt_md outside its size contract) still
// come back as `error`. Pure; the input object is not mutated.
export function normalizeStepJson(
  stepKey: string,
  parsed: any,
  kind: string = "plan",
): { value: any; error: string | null } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: parsed, error: validateStepJson(stepKey, parsed, kind) };
  }
  const value: any = JSON.parse(JSON.stringify(parsed));

  if (stepKey.startsWith("r2_exam_")) {
    if (Array.isArray(value.objections)) {
      for (const o of value.objections) {
        if (o && typeof o === "object") o.target_seat = seatIdFromLabel(o.target_seat);
      }
    }
    if (Array.isArray(value.steals)) {
      for (const s of value.steals) {
        if (s && typeof s === "object") s.from_seat = seatIdFromLabel(s.from_seat);
      }
    }
  }

  if (stepKey.startsWith("r4_vote_")) {
    if (value.scores && typeof value.scores === "object") {
      for (const k of rubricForKind(kind)) {
        const n = Number(value.scores[k]);
        if (Number.isFinite(n)) value.scores[k] = Math.max(1, Math.min(10, Math.round(n)));
      }
    }
    if (Array.isArray(value.objection_resolutions)) {
      for (const r of value.objection_resolutions) {
        if (r && typeof r === "object" && r.status === "resolved" && !String(r.evidence_quote ?? "").trim()) {
          // No quote = it still stands (the prompt's own rule).
          r.status = "standing";
        }
      }
    }
  }

  if (stepKey.startsWith("batches_review_") || stepKey === "cr_review_inspector") {
    if (Array.isArray(value.issues)) {
      const issues = value.issues
        .filter((iss: any) => iss && typeof iss === "object" && typeof iss.text === "string" && iss.text.trim().length >= 10)
        .slice(0, 8)
        .map((iss: any) => ({ ...iss, text: clipText(iss.text, 280) }));
      value.issues = issues;
      // The total-size cap is a wire budget, not a judgment: drop trailing
      // issues (blocking ones are listed first by the prompt) until it fits.
      while (value.issues.length && JSON.stringify(value).length > 4500) value.issues.pop();
    }
  }

  if (stepKey === "batches_chair" || stepKey === "batches_revise_chair") {
    if (Array.isArray(value.batches)) {
      value.batches.forEach((b: any, i: number) => {
        if (b && typeof b === "object") b.batch_no = i + 1;
      });
    }
  }

  return { value, error: validateStepJson(stepKey, value, kind) };
}

// What to persist when a NON-chair judgment step is still invalid after its
// one correction pass. A single dead vote must fail that loop's consensus
// (checkConsensus treats scores:null as a fail and the Chair sees the
// marker as a standing objection), and a dead reviewer must count as an
// empty review — neither is worth cancelling every paid sibling. Returns
// null for every other step: chair steps stay run-fatal.
export function degradedStepJson(stepKey: string, error: string): Record<string, unknown> | null {
  const key = String(stepKey ?? "");
  if (key.startsWith("r4_vote_")) {
    return { scores: null, blocking_objections: ["vote_unparseable"], _meta: { degraded: error } };
  }
  if (key.startsWith("batches_review_")) {
    return { verdict: "approve", issues: [], _meta: { degraded: error } };
  }
  return null;
}

export function validateStepJson(stepKey: string, parsed: any, kind: string = "plan"): string | null {
  if (!parsed || typeof parsed !== "object") return "Response is not a JSON object.";
  if (stepKey.startsWith("r2_exam_")) {
    const seat = stepKey.replace("r2_exam_", "");
    const objections = parsed.objections;
    const steals = parsed.steals;
    if (!Array.isArray(objections)) return "Missing objections array.";
    if (!Array.isArray(steals)) return "Missing steals array.";
    if (objections.length < 3) return "Need at least 3 objections total.";
    if (steals.length < 1) return "Need at least 1 steal.";
    for (const s of steals) {
      if (!s || !SEATS.includes(s.from_seat) || typeof s.idea !== "string" || s.idea.trim().length < 10) {
        return "Each steal needs a from_seat and a concrete idea — what you are adopting and why.";
      }
    }
    const others = SEATS.filter((s) => s !== seat);
    for (const other of others) {
      if (!objections.some((o: any) => o?.target_seat === other)) {
        return `Need at least one objection targeting ${other}.`;
      }
    }
    return null;
  }
  if (stepKey.startsWith("r3_synthesis_chair_loop")) {
    // Legacy single-phase synthesis (pre-two-phase runs).
    if (typeof parsed.candidate_md !== "string" || !parsed.candidate_md.trim()) {
      return "Missing candidate_md string.";
    }
    if (!Array.isArray(parsed.decision_log)) return "Missing decision_log array.";
    return null;
  }
  if (stepKey.startsWith("r3_extract_chair_loop")) {
    if (!Array.isArray(parsed.decision_log)) return "Missing decision_log array.";
    if (!Array.isArray(parsed.steals_adopted)) return "Missing steals_adopted array.";
    return null;
  }
  if (stepKey.startsWith("r4_vote_")) {
    const scores = parsed.scores;
    if (!scores || typeof scores !== "object") return "Missing scores object.";
    for (const k of rubricForKind(kind)) {
      const n = scores[k];
      if (!Number.isInteger(n) || n < 1 || n > 10) return `Score ${k} must be an integer 1-10.`;
    }
    if (!Array.isArray(parsed.blocking_objections)) return "Missing blocking_objections array.";
    if (!Array.isArray(parsed.objection_resolutions)) return "Missing objection_resolutions array.";
    for (const r of parsed.objection_resolutions) {
      if (r?.status === "resolved" && !String(r?.evidence_quote ?? "").trim()) {
        return "Every resolved objection needs a verbatim evidence_quote from the candidate.";
      }
    }
    return null;
  }
  if (stepKey.startsWith("batches_review_") || stepKey === "cr_review_inspector") {
    if (!["approve", "revise"].includes(parsed.verdict)) return "Missing/invalid verdict.";
    if (!Array.isArray(parsed.issues)) return "Missing issues array.";
    const issues = parsed.issues;
    if (issues.length > 8) return `issues has ${issues.length} entries — max 8. Merge duplicates and keep only the highest-severity items.`;
    const payloadLen = JSON.stringify(parsed).length;
    if (payloadLen > 4500) return `Total serialized review JSON is ${payloadLen} characters — exceeds 4,500. Trim wording without dropping blocking issues.`;
    for (let i = 0; i < issues.length; i++) {
      const iss = issues[i];
      if (!iss || typeof iss !== "object") return `issues[${i}] must be an object.`;
      if (!["blocking", "major", "minor"].includes(iss.severity)) return `issues[${i}].severity must be blocking|major|minor.`;
      if (iss.batch_no !== null && !(Number.isInteger(iss.batch_no) && iss.batch_no >= 1)) {
        return `issues[${i}].batch_no must be a positive integer or null.`;
      }
      if (typeof iss.text !== "string") return `issues[${i}].text must be a string.`;
      const t = iss.text.trim();
      if (t.length < 10 || t.length > 280) return `issues[${i}].text is ${t.length} chars — must be 10-280.`;
    }
    return null;
  }

  if (stepKey === "r_final_ruling_chair") {
    if (typeof parsed.final_md !== "string" || !parsed.final_md.trim()) return "Missing final_md.";
    if (!Array.isArray(parsed.dissent_ledger)) return "Missing dissent_ledger array.";
    return null;
  }
  if (stepKey === "r5_blueprint_extract_chair") {
    if (!Array.isArray(parsed.features)) return "Missing features array.";
    for (const f of parsed.features) {
      if (!f || typeof f.name !== "string" || typeof f.description !== "string") return "Each feature needs name and description.";
      if (f.priority !== "mvp" && f.priority !== "later") return "Each feature.priority must be 'mvp' or 'later'.";
    }
    return null;
  }
  if (stepKey.startsWith("cr_exam_")) {
    if (!["approve", "approve_with_amendments", "reject"].includes(parsed.stance)) return "Missing/invalid stance.";
    if (typeof parsed.reasoning !== "string" || !parsed.reasoning.trim()) return "Missing reasoning.";
    if (!Array.isArray(parsed.amendments)) return "Missing amendments array.";
    return null;
  }
  if (stepKey === "cr_verdict_chair" || stepKey === "cr_revise_chair") {
    if (!["approved", "rejected"].includes(parsed.verdict)) return "Missing/invalid verdict.";
    if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) return "Missing rationale.";
    if (parsed.verdict === "approved") {
      if (typeof parsed.amended_plan_md !== "string" || !parsed.amended_plan_md.trim()) return "Approved verdict requires amended_plan_md.";
      if (typeof parsed.amended_prd_md !== "string" || !parsed.amended_prd_md.trim()) return "Approved verdict requires amended_prd_md.";
      if (!Array.isArray(parsed.amended_features)) return "Approved verdict requires amended_features array.";
    }
    return null;
  }
  if (stepKey === "batches_chair" || stepKey === "batches_revise_chair") {
    if (!parsed || !Array.isArray(parsed.batches)) return "Missing batches array.";
    const b = parsed.batches;
    if (b.length < 3 || b.length > 8) return "batches must contain 3-8 items. Merge overlapping concerns rather than adding another batch; do not pad small improvement plans.";
    // Payload size ceiling — total serialized batches must fit under 24,000 chars.
    const payloadLen = JSON.stringify(b).length;
    if (payloadLen > 24000) return `Total serialized batches payload is ${payloadLen} characters — exceeds 24,000. Trim repeated context and prose without cutting scope.`;
    for (let i = 0; i < b.length; i++) {
      const item = b[i];
      if (!item || typeof item !== "object") return "Each batch must be an object.";
      const n = Number(item.batch_no);
      if (!Number.isInteger(n) || n !== i + 1) return `batch_no must be exact sequential 1..N — got ${item?.batch_no} at index ${i}.`;
      if (typeof item.title !== "string" || !item.title.trim()) return "Each batch needs a title.";
      if (!["lovable", "supabase", "human"].includes(item.channel)) return "Each batch.channel must be lovable, supabase, or human.";
      if (typeof item.prompt_md !== "string" || !item.prompt_md.trim()) return "Each batch needs a non-empty prompt_md.";
      const promptLen = item.prompt_md.length;
      const isCode = item.channel === "lovable" || item.channel === "supabase";
      if (isCode) {
        if (promptLen < 900 || promptLen > 2600) return `Batch ${n} prompt_md is ${promptLen} chars — code batches must be 900-2,600 characters.`;
        if (!/Acceptance checks:/.test(item.prompt_md)) return `Batch ${n} (code) must include an "Acceptance checks:" line.`;
        // Count numbered items (1. 2. …) beneath the Acceptance checks: line, until blank line / "Keep everything else…" — must be 2–4.
        const idx = item.prompt_md.search(/Acceptance checks:\s*$/m);
        if (idx >= 0) {
          const after = item.prompt_md.slice(idx).split(/\r?\n/).slice(1);
          let count = 0;
          for (const l of after) {
            const t = l.trim();
            if (!t) { if (count) break; else continue; }
            if (/^Keep everything else identical\./i.test(t)) break;
            if (/^\d+\./.test(t)) count += 1;
            else break;
          }
          if (count < 2 || count > 4) return `Batch ${n} (${item.channel}) must have 2–4 Acceptance checks (found ${count}).`;
        }
        if (!/Keep everything else identical\./.test(item.prompt_md)) return `Batch ${n} (code) must end with "Keep everything else identical."`;
        if (!/Typecheck when done\./.test(item.prompt_md)) return `Batch ${n} (code) must end with "Typecheck when done."`;
      } else {
        // human channel
        if (promptLen < 300 || promptLen > 2400) return `Batch ${n} prompt_md is ${promptLen} chars — human batches must be 300-2,400 characters.`;
        if (/Typecheck when done\./.test(item.prompt_md)) return `Batch ${n} (human) must not include "Typecheck when done."`;
        if (/Acceptance checks:/.test(item.prompt_md)) return `Batch ${n} (human) must not include "Acceptance checks:" — write plain-language numbered steps only.`;
      }
    }
    return null;
  }
  if (stepKey === "audit_chair_merge") {
    // AUDIT-FINALIZATION-R2: run the full normalize → dedupe → downgrade →
    // validateMerged pipeline BEFORE marking the step completed. A merge-cap
    // violation (finding count, title/description/evidence length, summary,
    // serialized payload) surfaces here so the existing single correction
    // pass runs; finalizeAudit is now defense in depth against the same
    // caps rather than the first line of defense.
    const evaluation = evaluateChairMergeCandidate(parsed);
    return evaluation.error;
  }
  return null;
}



// ============================== Structured correction routing ==============================

// Pure — pick the correction copy that matches the step's schema. Never send
// batch-schema instructions to a reviewer / vote / audit / other step.
export function correctionForStep(stepKey: string, opts?: { isImport?: boolean }): string {
  const key = String(stepKey ?? "");
  if (key === "batches_chair" || key === "batches_revise_chair") {
    // BATCH-REVISE-LOW-REASONING-R1: mirror the ORIGINAL system contract's
    // range so the correction never widens scope (live run 7bb72f5a said
    // "3-8" here while the greenfield / import contract said 6-8 or 3-6).
    // Import projects: 3-6 (smallest count that fully covers the locked
    // improvement plan). Greenfield builds: 6-8 (prefer 6). When the caller
    // does not know is_import, state both explicitly so no run is told a
    // range wider than its actual contract.
    let range: string;
    if (opts?.isImport === true) {
      range = "3-6 batches — pick the smallest count that fully covers the locked improvement plan without padding. For imports, NEVER pad to 6 to match a greenfield default.";
    } else if (opts?.isImport === false) {
      range = "6-8 batches (prefer 6) — the same range as the original contract. Merge overlapping concerns rather than adding another batch; only exceed 6 when a 7th or 8th is strictly required to keep any single batch below its size limit.";
    } else {
      range = "the same count range as the original system contract above (3-6 for imports, 6-8 for greenfield — prefer 6). Do NOT invent extra batches; pick the smallest count that fully covers the locked scope without padding.";
    }
    return `Your JSON was truncated. Return ${range} Each prompt_md 900-1,800 characters; total JSON <=16,000 characters. Preserve required coverage but remove repeated context and prose. Do not silently pad to 6 to satisfy an old default.`;
  }
  if (key === "batches_review_inspector" || key === "batches_review_contrarian") {
    return "Your review JSON was truncated. Return ONLY {verdict, issues}; max 8 issues; each issue.text 10-280 characters; total JSON <=4,500 characters. Preserve every blocking issue, merge duplicates, no prose.";
  }
  if (key === "audit_chair_merge") {
    // AUDIT-MERGE-BOUNDED-R3 + AUDIT-FINALIZATION-R2: never restate the
    // 30/18,000 shape that caused the original truncation, and require the
    // exact QUOTE/WHY evidence marker. Serious findings without a verbatim
    // quote get downgraded by the shared validator; correction should not
    // solicit paraphrases. Every number is read from CAPS.mergeCorrection*
    // so the copy cannot drift from the caps the code applies.
    const fmt = (n: number) => n.toLocaleString("en-US");
    return `Your prior audit merge JSON was invalid or truncated. Emit ONLY compact one-line valid JSON with keys verdict, summary, findings (and fix_prompt_md if any supported P0/P1 remains). HARD MAX ${CAPS.mergeCorrectionFindingsMax} highest-severity findings; total JSON <=${fmt(CAPS.mergeCorrectionSerializedMax)} characters; summary <=${CAPS.mergeCorrectionSummaryMax} characters; each finding description <=${CAPS.mergeCorrectionDescriptionMax} characters; each finding evidence <=${CAPS.mergeCorrectionEvidenceMax} characters. For every P0/P1 the evidence MUST use the exact marker form 'QUOTE: <short exact excerpt from the cited file> | WHY: <short reason it proves the issue>' — a paraphrase without a verbatim quote will be downgraded to P2. Drop the lowest-severity duplicates first; keep every supported P0/P1. If evidence for a finding is uncertain, OMIT the finding rather than expand or guess. Do NOT emit 30 findings or an 18,000-character schema — that limit caused the original truncation.`;
  }

  if (/^audit_(chair|strategist|contrarian|inspector|reserve)(_c\d+)?$/.test(key)) {
    // Materially smaller correction than the base map schema. Never asks
    // for the 12/8000 shape that caused the original truncation.
    return "Your prior audit-map JSON was invalid or truncated. Emit ONLY compact one-line valid JSON of the form {\"findings\":[...]}. MAX 3 highest-severity findings; each finding must be a complete object with severity, file_path, title (<=120 chars), description (<=240 chars), evidence (<=160 chars — a concrete short quote or exact construct), confidence, line_start, line_end. Every finding object must be COMPLETE — do NOT leave a trailing partial object. Total JSON <=3,000 characters. Do NOT return 12 findings or 8,000-character schema — that limit caused the original truncation. Reconstruct only complete findings from your prior reasoning; if in doubt, drop the finding rather than emit a partial one. Fragment boundaries in the source (\"fragment N of M\") are packaging, NOT truncated files.";
  }
  return "Return only the required JSON schema from the system prompt; keep every required field; compress prose and arrays to fit.";
}




// ============================== Consensus / locking ==============================

// Consensus gate: per-cohort override → workspace default → 8. The prompts
// keep calibrating "8 = reputation-staking" regardless; the threshold only
// moves the pass gate.
export async function resolveConsensusThreshold(admin: any, userId: string): Promise<number> {
  try {
    const { data: profile } = await admin.from("profiles").select("cohort_id").eq("id", userId).maybeSingle();
    if (profile?.cohort_id) {
      const { data: cohort } = await admin
        .from("cohorts")
        .select("consensus_threshold")
        .eq("id", profile.cohort_id)
        .maybeSingle();
      const n = Number(cohort?.consensus_threshold);
      if (Number.isFinite(n) && n >= 1 && n <= 10) return n;
    }
    const { data: setting } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", "consensus_threshold")
      .maybeSingle();
    const s = Number((setting?.value as any)?.score);
    if (Number.isFinite(s) && s >= 1 && s <= 10) return s;
  } catch { /* default */ }
  return 8;
}


export function checkConsensus(voteSteps: any[], kind: string = "plan", threshold: number = 8): { pass: boolean; scores: any } {
  const scoreSets: Record<string, any> = {};
  let pass = true;
  // Three independent voters (chair abstains on its own synthesis). Legacy
  // four-vote runs still pass this floor.
  if (voteSteps.length < 3) return { pass: false, scores: {} };
  const rubric = rubricForKind(kind);
  for (const v of voteSteps) {
    const j = v.response_json ?? {};
    scoreSets[v.seat] = { scores: j.scores ?? null, blocking_objections: j.blocking_objections ?? [] };
    if (!j.scores) { pass = false; continue; }
    for (const k of rubric) {
      const n = Number(j.scores[k]);
      if (!Number.isFinite(n) || n < threshold) pass = false;
    }
    if (Array.isArray(j.blocking_objections) && j.blocking_objections.length > 0) pass = false;
  }
  return { pass, scores: scoreSets };
}
