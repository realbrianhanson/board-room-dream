// Batch 4 (RC-3) — fitToMergeCaps trims a paid Chair merge into the merge
// caps instead of rejecting it. validateMerged itself stays strict (its
// pinned tests are untouched); the evaluator now runs the fitter first so
// the strict validator only ever sees a fitting set.
// Run: cd supabase/functions && deno test _shared/audit-merge-fit.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPS,
  type CleanFinding,
  evaluateChairMergeCandidate,
  fitToMergeCaps,
  validateMerged,
} from "./audit-findings.ts";

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

Deno.test("fitToMergeCaps — clips title/description/evidence/summary to the merge caps", () => {
  const { findings, summary } = fitToMergeCaps(
    [f({ title: "T".repeat(500), description: "D".repeat(1000), evidence: "E".repeat(700) })],
    "S".repeat(2000),
  );
  assertEquals(findings.length, 1);
  assert(findings[0].title.length <= CAPS.mergeTitleMax);
  assert(findings[0].description.length <= CAPS.mergeDescriptionMax);
  assert(findings[0].evidence.length <= CAPS.mergeEvidenceMax);
  assert(summary.length <= CAPS.mergeSummaryMax);
  assertEquals(validateMerged(findings, summary), null);
});

Deno.test("fitToMergeCaps — within-cap input is returned unchanged", () => {
  const input = [f({ title: "keep" }), f({ title: "me", severity: "P0" })];
  const { findings, summary } = fitToMergeCaps(input, "short");
  assertEquals(summary, "short");
  // Sorted by severity but nothing clipped.
  assertEquals(findings.map((x) => x.title), ["me", "keep"]);
  assertEquals(findings[1], input[0]);
});

Deno.test("fitToMergeCaps — over-count keeps the highest severities, stable within a severity, capped at mergeFindingsMax", () => {
  const input: CleanFinding[] = [
    ...Array.from({ length: 6 }, (_, i) => f({ severity: "P3", title: `p3_${i}` })),
    ...Array.from({ length: 6 }, (_, i) => f({ severity: "P2", title: `p2_${i}` })),
    ...Array.from({ length: 2 }, (_, i) => f({ severity: "P0", title: `p0_${i}` })),
    ...Array.from({ length: 3 }, (_, i) => f({ severity: "P1", title: `p1_${i}` })),
  ];
  const { findings } = fitToMergeCaps(input, "");
  assertEquals(findings.length, CAPS.mergeFindingsMax);
  assertEquals(findings.slice(0, 2).map((x) => x.title), ["p0_0", "p0_1"]);
  assertEquals(findings.slice(2, 5).map((x) => x.title), ["p1_0", "p1_1", "p1_2"]);
  assertEquals(findings.slice(5, 11).map((x) => x.title), ["p2_0", "p2_1", "p2_2", "p2_3", "p2_4", "p2_5"]);
  assertEquals(findings[11].title, "p3_0");
  assertEquals(validateMerged(findings), null);
});

Deno.test("fitToMergeCaps — drops from the tail until the serialized payload fits", () => {
  const bulky = Array.from({ length: 12 }, (_, i) => f({
    severity: i < 2 ? "P0" : "P2",
    title: `t${i}` + "t".repeat(115),
    description: "d".repeat(320),
    evidence: "e".repeat(280),
  }));
  assert(JSON.stringify(bulky).length > CAPS.mergeSerializedMax);
  const { findings } = fitToMergeCaps(bulky, "");
  assert(findings.length > 0 && findings.length < 12);
  assert(JSON.stringify(findings).length <= CAPS.mergeSerializedMax);
  // The serious ones survive; the tail (lowest severity, latest) is what went.
  assertEquals(findings[0].severity, "P0");
  assertEquals(findings[1].severity, "P0");
  assertEquals(validateMerged(findings), null);
});

Deno.test("fitToMergeCaps — empty input stays empty", () => {
  assertEquals(fitToMergeCaps([], ""), { findings: [], summary: "" });
});

Deno.test("evaluateChairMergeCandidate — over-cap merge is trimmed and accepted, severity preserved", () => {
  const parsed = {
    verdict: "findings",
    summary: "S".repeat(700),
    findings: [{
      severity: "P0",
      file_path: "src/foo.ts",
      title: "Concrete P0",
      description: "Something concrete is broken.",
      evidence: "QUOTE: " + "x".repeat(300) + " | WHY: it proves the issue",
      confidence: "high",
      line_start: 10,
      line_end: 20,
    }],
  };
  const r = evaluateChairMergeCandidate(parsed);
  assertEquals(r.error, null);
  assertEquals(r.verdict, "findings");
  assertEquals(r.findings.length, 1);
  // Downgrade runs BEFORE the fit: the existing IMPACT-marker rule rescores
  // this P0 to P1 on the full evidence; the clip afterwards does not demote
  // it further (QUOTE/WHY survive in the first 280 chars).
  assertEquals(r.findings[0].severity, "P1");
  assertEquals(r.downgrades.length, 1);
  assertEquals(r.downgrades[0].to, "P1");
  assert(r.findings[0].evidence.length <= CAPS.mergeEvidenceMax);
  assert(r.summary.length <= CAPS.mergeSummaryMax);
});

Deno.test("evaluateChairMergeCandidate — 13+ findings are capped, not rejected", () => {
  const findings = Array.from({ length: 15 }, (_, i) => ({
    severity: "P2",
    file_path: `src/f${i}.ts`,
    title: `Finding ${i}`,
    description: "d",
    evidence: "e",
    confidence: "medium",
    line_start: 1,
    line_end: 2,
  }));
  const r = evaluateChairMergeCandidate({ verdict: "findings", summary: "ok", findings });
  assertEquals(r.error, null);
  assertEquals(r.findings.length, CAPS.mergeFindingsMax);
});

Deno.test("evaluateChairMergeCandidate — clean verdict with findings: [] still passes", () => {
  const r = evaluateChairMergeCandidate({ verdict: "clean", summary: "nothing found", findings: [] });
  assertEquals(r.error, null);
  assertEquals(r.verdict, "clean");
  assertEquals(r.findings, []);
});

Deno.test("evaluateChairMergeCandidate — the only hard error left is a non-array findings", () => {
  const missing = evaluateChairMergeCandidate({ verdict: "findings", summary: "no list" });
  assertStringIncludes(String(missing.error), "findings must be an array");
  const wrongType = evaluateChairMergeCandidate({ verdict: "findings", summary: "x", findings: { a: 1 } });
  assertStringIncludes(String(wrongType.error), "findings must be an array");
  const notObject = evaluateChairMergeCandidate("nope");
  assertStringIncludes(String(notObject.error), "findings must be an array");
});
