// Deterministic routing assertions for correctionForStep + review validator.
// Run: cd supabase/functions && deno test boardroom-orchestrator/correction.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { correctionForStep, objectionsAndStealsBlock, promptJson, validateStepJson } from "./protocol.ts";
import { evaluateChairMergeCandidate } from "../_shared/audit-findings.ts";

Deno.test("correctionForStep — batch generation routes to batches copy (contract-consistent range, no exactly-six mandate)", () => {
  for (const k of ["batches_chair", "batches_revise_chair"]) {
    // Default (unknown isImport) mentions both ranges so no run is told a wider range than its contract.
    const c = correctionForStep(k);
    assertStringIncludes(c, "3-6 for imports");
    assertStringIncludes(c, "6-8 for greenfield");
    assertStringIncludes(c, "smallest count");
    // Correction copy asks for a materially SMALLER payload than the 24,000-char
    // validator ceiling so the retry cannot re-truncate in the same shape.
    assertStringIncludes(c, "<=16,000 characters");
    assertStringIncludes(c, "900-1,800 characters");
    assert(!/\b3-8 batches\b/.test(c), `must not tell the model a 3-8 range (got: ${c})`);
    assert(!/exactly\s+6\s+batches/i.test(c), `must not force exactly six (got: ${c})`);

    // Import branch: exactly 3-6, no greenfield widening.
    const ci = correctionForStep(k, { isImport: true });
    assertStringIncludes(ci, "3-6 batches");
    assert(!/\b6-8\b/.test(ci), `import correction must not mention 6-8 (got: ${ci})`);

    // Greenfield branch: 6-8 (prefer 6), no 3-6 widening.
    const cg = correctionForStep(k, { isImport: false });
    assertStringIncludes(cg, "6-8 batches");
    assert(!/\b3-6\b/.test(cg), `greenfield correction must not mention 3-6 (got: ${cg})`);
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
  // Batch 4: the copy is generated from CAPS.mergeCorrection* (evidence cap
  // 200), so it can no longer disagree with the validator's own numbers.
  assertStringIncludes(c, "evidence <=200");
  assert(!/evidence <=140/.test(c), "merge correction must not restate the stale 140-char evidence cap");
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
// no audit_chair_merge branch. finalizeAudit then failed the whole run.
// Batch 4 (RC-3): a cap overrun on paid, parseable output is now TRIMMED by
// fitToMergeCaps inside the shared evaluator instead of bouncing the step
// into a correction pass (and, on a second miss, killing the run). The
// step-boundary validator therefore accepts this shape; the evidence the
// audit publishes is clipped to the 280-char merge cap with its severity
// intact (the QUOTE/WHY downgrade ran before the clip).
Deno.test("validateStepJson — audit_chair_merge accepts evidence over cap (trimmed, not rejected)", () => {
  const badEvidence = {
    verdict: "findings",
    summary: "Live-shape audit merge",
    findings: [{
      severity: "P0",
      file_path: "src/foo.ts",
      title: "Concrete P0",
      description: "Something concrete is broken.",
      // Over the 280-char mergeEvidenceMax, exactly the live failure shape.
      evidence: "QUOTE: " + "x".repeat(300) + " | WHY: it proves the issue",
      confidence: "high",
      line_start: 10,
      line_end: 20,
    }],
  };
  assertEquals(validateStepJson("audit_chair_merge", badEvidence), null);
  const evaluation = evaluateChairMergeCandidate(badEvidence);
  assertEquals(evaluation.error, null);
  assertEquals(evaluation.findings.length, 1);
  // Severity is settled BEFORE the clip: the existing truthfulness rule
  // rescores a P0 with no IMPACT: marker to P1, and the clipped evidence
  // does not demote it further (it still carries QUOTE/WHY).
  assertEquals(evaluation.findings[0].severity, "P1");
  assert(evaluation.findings[0].evidence.length <= 280, "evidence must be clipped to the merge cap");
  // The merge correction copy is still the merge contract, not seat/map copy.
  const c = correctionForStep("audit_chair_merge");
  assertStringIncludes(c, "audit merge");
  assertStringIncludes(c, "QUOTE:");
});

Deno.test("validateStepJson — audit_chair_merge still hard-fails when findings is not an array", () => {
  const err = validateStepJson("audit_chair_merge", { verdict: "findings", summary: "no list" });
  assert(err && /findings/.test(err), `expected findings-array error, got: ${err}`);
  const err2 = validateStepJson("audit_chair_merge", { verdict: "findings", summary: "x", findings: "none" });
  assert(err2 && /findings/.test(err2), `expected findings-array error, got: ${err2}`);
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

Deno.test("validateStepJson — audit_chair_merge fits an over-9,000 serialized payload instead of failing it", () => {
  // 12 findings at merge per-field caps (title 120, description 320,
  // evidence 200) pushes serialized findings JSON past 9,000 chars while
  // every individual finding still passes the per-field validator. Batch 4:
  // the evaluator drops from the tail until the set fits, so the step is
  // accepted and the published set is under the cap.
  const findings = Array.from({ length: 12 }, (_, i) => ({
    severity: "P2",
    file_path: `src/some/deep/path/file_number_${i}.ts`,
    title: "T".repeat(120),
    description: "d".repeat(320),
    evidence: "e".repeat(200),
    confidence: "medium",
    line_start: 1,
    line_end: 2,
  }));
  const oversize = { verdict: "findings", summary: "big", findings };
  assertEquals(validateStepJson("audit_chair_merge", oversize), null);
  const evaluation = evaluateChairMergeCandidate(oversize);
  assertEquals(evaluation.error, null);
  assert(evaluation.findings.length > 0 && evaluation.findings.length < 12, `expected a trimmed set, got ${evaluation.findings.length}`);
  assert(JSON.stringify(evaluation.findings).length <= 9_000, "published findings must fit the serialized cap");
});



// RC-1 follow-up: every completed step now carries a diagnostic `_meta`
// (finish_reason, tokens_out, reasoning_tokens, wire_max_tokens, fallback)
// in response_json. It must never be re-sent to the next model.
Deno.test("promptJson — strips _meta before a step's JSON is re-sent as prompt material", () => {
  const stored = { objections: [{ target_seat: "chair", severity: "major", text: "x" }], steals: [], _meta: { finish_reason: "stop", tokens_out: 900, reasoning_tokens: 600, wire_max_tokens: 6000 } };
  const out = promptJson(stored);
  assertEquals(out, { objections: stored.objections, steals: [] });
  assert(!("_meta" in out));
  // The stored object is not mutated — the row keeps its diagnostics.
  assert("_meta" in stored);
  // Non-objects, arrays and null pass through untouched.
  assertEquals(promptJson(null), null);
  assertEquals(promptJson([1, 2]), [1, 2]);
  assertEquals(promptJson({ missing: true }), { missing: true });
});

Deno.test("objectionsAndStealsBlock — the Round 3 prompt never contains the step's _meta budget numbers", () => {
  const steps = [
    { step_key: "r2_exam_strategist", status: "completed", response_json: { objections: [{ target_seat: "chair", severity: "minor", text: "o" }], steals: [], _meta: { finish_reason: "stop", tokens_out: 1234, reasoning_tokens: 800, wire_max_tokens: 6000 } } },
    { step_key: "r2_exam_inspector", status: "completed", response_json: { objections: [], steals: [], _meta: { fallback: { fallback_model_used: "m", primary_model: "p", reason: "refusal" } } } },
  ];
  const block = objectionsAndStealsBlock(steps);
  assertStringIncludes(block, "OBJECTIONS AND STEALS");
  assertStringIncludes(block, '"target_seat": "chair"');
  assert(!block.includes("_meta"), `prompt leaked _meta: ${block}`);
  assert(!block.includes("wire_max_tokens"));
  assert(!block.includes("fallback_model_used"));
});
