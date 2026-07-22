// Deterministic routing assertions for correctionForStep + review validator.
// Run: cd supabase/functions && deno test boardroom-orchestrator/correction.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { correctionForStep, validateStepJson } from "./protocol.ts";

Deno.test("correctionForStep — batch generation routes to batches copy", () => {
  for (const k of ["batches_chair", "batches_revise_chair"]) {
    const c = correctionForStep(k);
    assertStringIncludes(c, "exactly 6 batches");
    assertStringIncludes(c, "<=24,000 characters");
  }
});

Deno.test("correctionForStep — batch review routes to review copy (never batch schema)", () => {
  for (const k of ["batches_review_inspector", "batches_review_contrarian"]) {
    const c = correctionForStep(k);
    assertStringIncludes(c, "{verdict, issues}");
    assertStringIncludes(c, "max 8 issues");
    assertStringIncludes(c, "<=4,500 characters");
    assert(!c.includes("6 batches"), `reviewer must not receive batch-schema copy (got: ${c})`);
  }
});

Deno.test("correctionForStep — audit seat report routes to tightened audit-map copy (AUDIT-JSON-FRAGMENT-R2)", () => {
  for (const k of ["audit_chair", "audit_inspector", "audit_strategist_c2", "audit_contrarian_c11"]) {
    const c = correctionForStep(k);
    // Explicitly tightened after run e2c5faf3: MAX 3 findings, <=3,000 chars.
    assertStringIncludes(c, "audit-map JSON");
    assertStringIncludes(c, "MAX 3 highest-severity findings");
    assertStringIncludes(c, "<=3,000 characters");
    // Must NOT reintroduce the shape that caused the original truncation.
    assert(!/max\s*12\s*findings/i.test(c), `audit correction must not ask for 12 findings (got: ${c})`);
    assert(!/8[, ]?000-?character/i.test(c), `audit correction must not ask for 8,000-char schema`);
    assert(!c.includes("6 batches"), `audit must not receive batch-schema copy`);
    assert(!c.includes("{verdict, issues}"), `audit must not receive review-schema copy`);
  }
});

Deno.test("correctionForStep — audit merge routes to merge copy", () => {
  const c = correctionForStep("audit_chair_merge");
  assertStringIncludes(c, "audit merge");
  assertStringIncludes(c, "max 30 deduplicated findings");
  assertStringIncludes(c, "<=18,000 characters");
});

Deno.test("correctionForStep — unknown steps route to generic copy", () => {
  for (const k of ["r2_exam_strategist", "r4_vote_chair_loop1", "cr_verdict_chair", "", "totally_new_step"]) {
    const c = correctionForStep(k);
    assertStringIncludes(c, "Return only the required JSON schema");
    assert(!c.includes("6 batches"), `generic must not leak batch-schema copy`);
    assert(!c.includes("{verdict, issues}"), `generic must not leak review-schema copy`);
    assert(!c.includes("audit report"), `generic must not leak audit-schema copy`);
  }
});

Deno.test("validateStepJson — batches_review_ enforces 0-8, severities, batch_no, text length, payload", () => {
  const ok = { verdict: "revise", issues: [{ batch_no: 1, severity: "blocking", text: "Batch 1 references src/nope.tsx which is not in the repo — use src/routes/index.tsx." }] };
  assertEquals(validateStepJson("batches_review_inspector", ok), null);

  const okEmpty = { verdict: "approve", issues: [] };
  assertEquals(validateStepJson("batches_review_inspector", okEmpty), null);

  const badVerdict = validateStepJson("batches_review_inspector", { verdict: "maybe", issues: [] });
  assertStringIncludes(String(badVerdict), "verdict");

  const tooMany = { verdict: "revise", issues: Array.from({ length: 9 }, () => ({ batch_no: 1, severity: "minor", text: "x".repeat(30) })) };
  assertStringIncludes(String(validateStepJson("batches_review_inspector", tooMany)), "max 8");

  const badSev = { verdict: "revise", issues: [{ batch_no: 1, severity: "critical", text: "x".repeat(30) }] };
  assertStringIncludes(String(validateStepJson("batches_review_inspector", badSev)), "severity");

  const badBatchNo = { verdict: "revise", issues: [{ batch_no: 0, severity: "minor", text: "x".repeat(30) }] };
  assertStringIncludes(String(validateStepJson("batches_review_inspector", badBatchNo)), "batch_no");

  const nullBatchNoOk = { verdict: "revise", issues: [{ batch_no: null, severity: "minor", text: "x".repeat(30) }] };
  assertEquals(validateStepJson("batches_review_inspector", nullBatchNoOk), null);

  const tooShort = { verdict: "revise", issues: [{ batch_no: 1, severity: "minor", text: "short" }] };
  assertStringIncludes(String(validateStepJson("batches_review_inspector", tooShort)), "10-280");

  const tooLong = { verdict: "revise", issues: [{ batch_no: 1, severity: "minor", text: "x".repeat(281) }] };
  assertStringIncludes(String(validateStepJson("batches_review_inspector", tooLong)), "10-280");

  const oversize = { verdict: "revise", issues: Array.from({ length: 8 }, () => ({ batch_no: 1, severity: "minor", text: "y".repeat(600) })) };
  assertStringIncludes(String(validateStepJson("batches_review_inspector", oversize)), "4,500");
});
