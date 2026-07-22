// AUDIT-MERGE-BOUNDED-R3 deterministic tests for tightened Chair merge caps,
// validator behaviour, per-field limits, summary, tail-closure strictness on
// merge shape, and the live-truncation fixture rejection.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPS,
  type CleanFinding,
  tryCloseJsonTail,
  validateMerged,
} from "./audit-findings.ts";
import { buildValidationRetryRequest, isAuditNoEchoStep } from "./batch-context.ts";

function f(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "chair",
    severity: "P1",
    file_path: "src/x.ts",
    title: "t",
    description: "d",
    evidence: "concrete evidence citing exact construct here",
    confidence: "high",
    line_start: 1,
    line_end: 2,
    ...over,
  };
}

Deno.test("R3 CAPS — merge tightened to 12 findings / 9,000 chars with per-field limits", () => {
  assertEquals(CAPS.mergeFindingsMax, 12);
  assertEquals(CAPS.mergeSerializedMax, 9_000);
  assertEquals(CAPS.mergeSummaryMax, 600);
  assertEquals(CAPS.mergeTitleMax, 120);
  assertEquals(CAPS.mergeDescriptionMax, 320);
  assertEquals(CAPS.mergeEvidenceMax, 200);
  // Correction caps must never restore the failing 30/18000 shape.
  assertEquals(CAPS.mergeCorrectionFindingsMax, 8);
  assertEquals(CAPS.mergeCorrectionSerializedMax, 6_000);
  assertEquals(CAPS.mergeCorrectionSummaryMax, 360);
  assertEquals(CAPS.mergeCorrectionDescriptionMax, 240);
  assertEquals(CAPS.mergeCorrectionEvidenceMax, 140);
});

Deno.test("validateMerged — 12 clean findings + short summary passes", () => {
  const findings = Array.from({ length: 12 }, (_, i) => f({ title: `t${i}` }));
  assertEquals(validateMerged(findings, "short summary"), null);
});

Deno.test("validateMerged — 13 findings fails with 'max' message", () => {
  const findings = Array.from({ length: 13 }, () => f());
  const err = validateMerged(findings);
  assertStringIncludes(String(err), "max 12");
});

Deno.test("validateMerged — one-over per-field caps fails cleanly", () => {
  assertStringIncludes(String(validateMerged([f({ title: "x".repeat(121) })])), "title over 120");
  assertStringIncludes(String(validateMerged([f({ description: "x".repeat(321) })])), "description over 320");
  assertStringIncludes(String(validateMerged([f({ evidence: "x".repeat(201) })])), "evidence over 200");
});

Deno.test("validateMerged — summary over 600 fails", () => {
  const err = validateMerged([f()], "s".repeat(601));
  assertStringIncludes(String(err), "summary is 601 chars");
});

Deno.test("validateMerged — serialized payload over 9,000 fails", () => {
  // Twelve maxed-out findings (title 120, desc 320, evidence 200) serialize
  // to well over 9,000 chars.
  const bulky = Array.from({ length: 12 }, () => f({
    title: "t".repeat(120),
    description: "d".repeat(320),
    evidence: "e".repeat(200),
  }));
  const err = validateMerged(bulky);
  assertStringIncludes(String(err), "exceeds 9000");
});

Deno.test("tryCloseJsonTail merge shape — rejects live truncation fixture ending mid-string", () => {
  // Live ddf72827: chair emitted verdict/summary/findings and then truncated
  // mid-field inside a finding's file_path. The tail is inside an open
  // string, so the balanced-scan check MUST reject — never auto-close.
  const truncated =
    '{"verdict":"findings","summary":"ok","findings":[{"severity":"P0","file_path":"src/routes/_authenticated/plan.$projectId.tsx","title":"RLS bypass","description":"..","evidence":"..","confidence":"high","line_start":1,"line_end":2},{"severity":"P1","file_path":"src/rou';
  const r = tryCloseJsonTail(truncated, { shape: "merge" });
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail merge shape — accepts already-valid merge JSON as-is", () => {
  const doc = { verdict: "findings", summary: "ok", findings: [f()] };
  const r = tryCloseJsonTail(JSON.stringify(doc), { shape: "merge" });
  assert(r.ok, `expected ok, got: ${JSON.stringify(r)}`);
  if (r.ok) assertEquals(r.closed, "");
});

Deno.test("tryCloseJsonTail merge shape — rejects rescue whose findings exceed merge caps", () => {
  // Balanced but the rescued shape has 13 findings — merge validator rejects.
  const findings = Array.from({ length: 13 }, () => f());
  const doc = { verdict: "findings", summary: "ok", findings };
  const r = tryCloseJsonTail(JSON.stringify(doc), { shape: "merge" });
  assertEquals(r.ok, false);
});

Deno.test("isAuditNoEchoStep — chair merge is in the no-echo set", () => {
  assertEquals(isAuditNoEchoStep("audit_chair_merge"), true);
  assertEquals(isAuditNoEchoStep("audit_inspector_c3"), true);
  assertEquals(isAuditNoEchoStep("audit_chair"), true);
  assertEquals(isAuditNoEchoStep("batches_chair"), false);
});

Deno.test("buildValidationRetryRequest — audit_chair_merge DROPS assistant echo on retry", () => {
  const base = { json_output: true, max_tokens: 6500, reasoning_effort: "low" };
  const res = buildValidationRetryRequest({
    stepKey: "audit_chair_merge",
    baseRequest: base,
    baseMessages: [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
    assistantContent: "TRUNCATED_" + "x".repeat(10_000),
    validationError: "truncated mid-string",
    truncated: true,
    correction: "compact JSON, MAX 8 findings",
  });
  assertEquals(res.mode, "without_echo");
  const msgs = (res.request as any).messages as Array<{ role: string; content: string }>;
  // No assistant echo message.
  assertEquals(msgs.filter((m) => m.role === "assistant").length, 0);
  // The huge truncated body must not appear verbatim in any message content.
  for (const m of msgs) assert(!m.content.includes("TRUNCATED_xxxxxx"), "echo leaked");
});
