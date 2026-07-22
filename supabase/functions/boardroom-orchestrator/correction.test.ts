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
    assert(!/Total JSON\s*<=?\s*8[, ]?000/i.test(c), `audit correction must not request an 8,000-char limit`);
    assert(!/MAX\s*12\s/i.test(c), `audit correction must not request 12 findings`);
    assert(!c.includes("6 batches"), `audit must not receive batch-schema copy`);
    assert(!c.includes("{verdict, issues}"), `audit must not receive review-schema copy`);
  }
});

Deno.test("correctionForStep — audit merge routes to bounded R3 merge copy with exact QUOTE/WHY marker (never 30/18,000)", () => {
  const c = correctionForStep("audit_chair_merge");
  assertStringIncludes(c, "audit merge");
  assertStringIncludes(c, "HARD MAX 8");
  assertStringIncludes(c, "<=6,000 characters");
  assertStringIncludes(c, "summary <=360");
  assertStringIncludes(c, "description <=240");
  assertStringIncludes(c, "evidence <=140");
  // AUDIT-FINALIZATION-R2: correction must require the exact evidence marker
  // format so the shared downgrader does not P2-demote every retried finding.
  assertStringIncludes(c, "QUOTE:");
  assertStringIncludes(c, "WHY:");
  assert(!/\b30\s+deduplicated\s+findings\b/i.test(c), "must not restate 30-findings shape");
  assert(!/<=?\s*18[, ]?000\s*characters/i.test(c), "must not restate 18,000-char shape");
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

// AUDIT-FINALIZATION-R2: live run a9e89958 emitted parseable Chair JSON with
// evidence >200 chars but was marked completed because validateStepJson had
// no audit_chair_merge branch. finalizeAudit then failed the whole run. The
// shared merge evaluator must reject cap violations at the step boundary so
// the existing single correction pass runs.
Deno.test("validateStepJson — audit_chair_merge rejects evidence over cap and routes to merge correction", () => {
  const badEvidence = {
    verdict: "findings",
    summary: "Live-shape audit merge",
    findings: [{
      severity: "P0",
      file_path: "src/foo.ts",
      title: "Concrete P0",
      description: "Something concrete is broken.",
      // Over the 200-char mergeEvidenceMax, exactly the live failure shape.
      evidence: "QUOTE: " + "x".repeat(220) + " | WHY: it proves the issue",
      confidence: "high",
      line_start: 10,
      line_end: 20,
    }],
  };
  const err = validateStepJson("audit_chair_merge", badEvidence);
  assert(err && /evidence/.test(err) && /200/.test(err), `expected evidence-over-200 error, got: ${err}`);
  // And the routed correction must be the merge contract, not seat/map copy.
  const c = correctionForStep("audit_chair_merge");
  assertStringIncludes(c, "audit merge");
  assertStringIncludes(c, "QUOTE:");
});

Deno.test("validateStepJson — audit_chair_merge accepts a within-cap correction response", () => {
  const good = {
    verdict: "findings",
    summary: "Within-cap merge",
    findings: [{
      severity: "P0",
      file_path: "src/foo.ts",
      title: "Concrete P0",
      description: "Something concrete is broken.",
      evidence: "QUOTE: leaked_secret = 'sk_live_xxx' | WHY: hardcoded secret in repo",
      confidence: "high",
      line_start: 10,
      line_end: 20,
    }],
  };
  assertEquals(validateStepJson("audit_chair_merge", good), null);
});

Deno.test("validateStepJson — audit_chair_merge catches over-9,000 serialized payload before finalization", () => {
  // 12 findings each ~800 chars pushes serialized size well past 9,000.
  const findings = Array.from({ length: 12 }, (_, i) => ({
    severity: "P2",
    file_path: `src/f${i}.ts`,
    title: `Finding ${i}`,
    description: "y".repeat(310),
    evidence: "z".repeat(190),
    confidence: "medium",
    line_start: 1,
    line_end: 2,
  }));
  const oversize = { verdict: "findings", summary: "big", findings };
  const err = validateStepJson("audit_chair_merge", oversize);
  assert(err && /9[, ]?000/.test(err), `expected serialized-size violation, got: ${err}`);
});

