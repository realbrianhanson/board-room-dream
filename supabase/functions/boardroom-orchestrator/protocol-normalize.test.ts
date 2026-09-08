// Batch 4 (RC-3) — normalize-then-validate for step JSON, the degraded
// values stored for a dead vote / reviewer, the threshold-aware prior-vote
// block, and the CAPS-driven merge correction copy.
// Run: cd supabase/functions && deno test boardroom-orchestrator/protocol-normalize.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkConsensus,
  correctionForStep,
  degradedStepJson,
  normalizeStepJson,
  priorRoundFailureBlock,
  seatIdFromLabel,
  validateStepJson,
} from "./protocol.ts";
import { CAPS } from "../_shared/audit-findings.ts";

const planScores = (n: number | string) => ({
  painful_problem: n, reachable_buyer: n, monetization_path: n, buildable_scope: n, differentiation: n, wow_factor: n,
});

Deno.test("normalizeStepJson — r4_vote: fractional / out-of-range / numeric-string scores are rounded and clamped", () => {
  const parsed = {
    scores: { ...planScores(8), painful_problem: 7.5, reachable_buyer: 11, monetization_path: 0, buildable_scope: "9" },
    blocking_objections: [],
    objection_resolutions: [],
  };
  const { value, error } = normalizeStepJson("r4_vote_inspector_loop0", parsed, "plan");
  assertEquals(error, null);
  assertEquals(value.scores.painful_problem, 8);
  assertEquals(value.scores.reachable_buyer, 10);
  assertEquals(value.scores.monetization_path, 1);
  assertEquals(value.scores.buildable_scope, 9);
  // Input not mutated.
  assertEquals(parsed.scores.painful_problem, 7.5);
  // The raw value would have failed the strict validator.
  assert(validateStepJson("r4_vote_inspector_loop0", parsed, "plan"));
});

Deno.test("normalizeStepJson — r4_vote: 'resolved' without an evidence_quote becomes 'standing'", () => {
  const parsed = {
    scores: planScores(8),
    blocking_objections: [],
    objection_resolutions: [
      { objection: "unclear buyer", status: "resolved", evidence_quote: "" },
      { objection: "no price", status: "resolved", evidence_quote: "verbatim text" },
      { objection: "weak wow", status: "standing" },
    ],
  };
  const { value, error } = normalizeStepJson("r4_vote_contrarian_loop1", parsed, "plan");
  assertEquals(error, null);
  assertEquals(value.objection_resolutions.map((r: any) => r.status), ["standing", "resolved", "standing"]);
});

Deno.test("normalizeStepJson — r4_vote: a missing required key or non-numeric score still hard-fails", () => {
  assertStringIncludes(String(normalizeStepJson("r4_vote_inspector_loop0", { blocking_objections: [], objection_resolutions: [] }, "plan").error), "scores");
  assertStringIncludes(String(normalizeStepJson("r4_vote_inspector_loop0", { scores: planScores(8), objection_resolutions: [] }, "plan").error), "blocking_objections");
  const nan = normalizeStepJson("r4_vote_inspector_loop0", { scores: { ...planScores(8), wow_factor: "high" }, blocking_objections: [], objection_resolutions: [] }, "plan");
  assertStringIncludes(String(nan.error), "wow_factor");
});

Deno.test("normalizeStepJson — r2_exam: seat labels map to seat ids", () => {
  assertEquals(seatIdFromLabel("The Chair"), "chair");
  assertEquals(seatIdFromLabel("Inspector"), "inspector");
  assertEquals(seatIdFromLabel(" the strategist "), "strategist");
  assertEquals(seatIdFromLabel("Nobody"), "Nobody");
  assertEquals(seatIdFromLabel(null), null);
  const parsed = {
    objections: [
      { target_seat: "The Chair", severity: "major", text: "a" },
      { target_seat: "Strategist", severity: "minor", text: "b" },
      { target_seat: "the contrarian", severity: "minor", text: "c" },
    ],
    steals: [{ from_seat: "The Contrarian", idea: "adopt the objection ledger because it grounds the vote" }],
  };
  const { value, error } = normalizeStepJson("r2_exam_inspector", parsed, "plan");
  assertEquals(error, null);
  assertEquals(value.objections.map((o: any) => o.target_seat), ["chair", "strategist", "contrarian"]);
  assertEquals(value.steals[0].from_seat, "contrarian");
  assert(validateStepJson("r2_exam_inspector", parsed, "plan"), "raw labels must fail the strict validator");
});

Deno.test("normalizeStepJson — batches_review: issues capped at 8, text clipped to 280, short issues dropped, payload fitted", () => {
  const long = "L".repeat(400);
  const parsed = {
    verdict: "revise",
    issues: [
      { batch_no: 1, severity: "blocking", text: "Batch 1 references src/nope.tsx which is not in the repo." },
      { batch_no: 2, severity: "minor", text: "short" },
      null,
      ...Array.from({ length: 9 }, (_, i) => ({ batch_no: i + 1, severity: "minor", text: `Issue number ${i} ` + long })),
    ],
  };
  const { value, error } = normalizeStepJson("batches_review_inspector", parsed, "batches");
  assertEquals(error, null);
  assert(value.issues.length <= 8);
  assertEquals(value.issues[0].severity, "blocking");
  for (const iss of value.issues) assert(iss.text.trim().length >= 10 && iss.text.length <= 280);
  assert(JSON.stringify(value).length <= 4500);
  assert(validateStepJson("batches_review_inspector", parsed), "raw review must fail the strict validator");
  // Same rules for the change-request reviewer.
  assertEquals(normalizeStepJson("cr_review_inspector", parsed, "change_request").error, null);
});

Deno.test("normalizeStepJson — batches_review: invalid verdict / severity still hard-fail", () => {
  assertStringIncludes(String(normalizeStepJson("batches_review_inspector", { verdict: "maybe", issues: [] }).error), "verdict");
  assertStringIncludes(String(normalizeStepJson("batches_review_inspector", { verdict: "revise", issues: [{ batch_no: 1, severity: "critical", text: "x".repeat(30) }] }).error), "severity");
});

Deno.test("normalizeStepJson — batches_chair: batch_no is renumbered 1..N; size contract still enforced", () => {
  const filler = "x".repeat(320);
  const b = (n: number) => ({
    batch_no: n,
    title: `Batch ${n}`,
    channel: "human",
    prompt_md: `Batch — human step.\n\n1. Step one is a plain-language action the student takes in an external console. ${filler}`,
  });
  const parsed = { batches: [b(1), b(1), b(3), b(9), b(5), b(6)] };
  const { value, error } = normalizeStepJson("batches_chair", parsed, "batches");
  assertEquals(error, null);
  assertEquals(value.batches.map((x: any) => x.batch_no), [1, 2, 3, 4, 5, 6]);
  assertEquals(parsed.batches[1].batch_no, 1, "input not mutated");
  // Count and prompt-size contracts are not something a normalizer may fix.
  assertStringIncludes(String(normalizeStepJson("batches_chair", { batches: [b(1), b(2)] }).error), "3-8");
  assertStringIncludes(String(normalizeStepJson("batches_chair", {}).error), "batches");
});

Deno.test("normalizeStepJson — non-object input and unknown steps pass straight through", () => {
  assertStringIncludes(String(normalizeStepJson("r4_vote_x", null).error), "not a JSON object");
  const arr = normalizeStepJson("totally_new_step", [1, 2]);
  assertEquals(arr.value, [1, 2]);
  const obj = { anything: true };
  const r = normalizeStepJson("totally_new_step", obj);
  assertEquals(r.error, null);
  assertEquals(r.value, obj);
});

Deno.test("degradedStepJson — dead vote fails that loop's consensus; dead reviewer is an empty approve; chair steps stay fatal", () => {
  const vote = degradedStepJson("r4_vote_inspector_loop2", "invalid");
  assertEquals(vote, { scores: null, blocking_objections: ["vote_unparseable"], _meta: { degraded: "invalid" } });
  const votes = [
    { seat: "inspector", response_json: vote },
    { seat: "contrarian", response_json: { scores: planScores(9), blocking_objections: [] } },
    { seat: "strategist", response_json: { scores: planScores(9), blocking_objections: [] } },
  ];
  assertEquals(checkConsensus(votes, "plan", 8).pass, false);
  const block = priorRoundFailureBlock(
    votes.map((v) => ({ ...v, step_key: `r4_vote_${v.seat}_loop0`, status: "completed" })),
    0,
  );
  assertStringIncludes(block, "- [inspector] vote_unparseable");

  assertEquals(degradedStepJson("batches_review_contrarian", "cut"), { verdict: "approve", issues: [], _meta: { degraded: "cut" } });
  for (const k of ["batches_chair", "batches_revise_chair", "audit_chair_merge", "audit_inspector_c1", "r2_exam_chair", "cr_exam_inspector", "cr_verdict_chair", "r_final_ruling_chair", ""]) {
    assertEquals(degradedStepJson(k, "x"), null, `${k} must stay run-fatal`);
  }
});

Deno.test("priorRoundFailureBlock — uses the resolved consensus threshold, default 8", () => {
  const steps = [
    { step_key: "r4_vote_inspector_loop0", seat: "inspector", status: "completed", response_json: { scores: { ...planScores(9), wow_factor: 7 }, blocking_objections: [] } },
  ];
  const def = priorRoundFailureBlock(steps, 0);
  assertStringIncludes(def, "RUBRIC SCORES BELOW 8:");
  assertStringIncludes(def, "- [inspector] wow_factor: 7");
  const seven = priorRoundFailureBlock(steps, 0, 7);
  assertStringIncludes(seven, "RUBRIC SCORES BELOW 7:");
  assert(!seven.includes("wow_factor: 7"), "a 7 is not below a threshold of 7");
});

Deno.test("correctionForStep — audit_chair_merge copy is generated from CAPS.mergeCorrection*", () => {
  const c = correctionForStep("audit_chair_merge");
  assertStringIncludes(c, `HARD MAX ${CAPS.mergeCorrectionFindingsMax} `);
  assertStringIncludes(c, `total JSON <=${CAPS.mergeCorrectionSerializedMax.toLocaleString("en-US")} characters`);
  assertStringIncludes(c, `summary <=${CAPS.mergeCorrectionSummaryMax} characters`);
  assertStringIncludes(c, `description <=${CAPS.mergeCorrectionDescriptionMax} characters`);
  assertStringIncludes(c, `evidence <=${CAPS.mergeCorrectionEvidenceMax} characters`);
});
