// Deterministic H1 tests for audit-finding normalize/dedupe/downgrade/validate.
// Run: cd supabase/functions && deno test _shared/audit-findings.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMergeInput,
  CAPS,
  dedupeFindings,
  downgradeUnsupported,
  normalizeFindings,
  validateMerged,
  validateSeatReport,
  type CleanFinding,
} from "./audit-findings.ts";

function make(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "RLS bypass on posts",
    description: "Anon can select every row of public.posts because policy is USING (true).",
    evidence: "supabase/migrations/2026_posts.sql line 42: CREATE POLICY \"read\" ON posts FOR SELECT USING (true)",
    confidence: "high",
    line_start: 42,
    line_end: 42,
    ...over,
  };
}

Deno.test("normalizeFindings drops invalid entries and truncates strings", () => {
  const out = normalizeFindings([
    null,
    { severity: "P9", title: "bad sev" },
    { severity: "P1", title: "" },
    { severity: "P2", title: "ok", description: "x".repeat(2000), evidence: "y".repeat(2000) },
  ]);
  assertEquals(out.length, 1);
  assert(out[0].description.length <= CAPS.descriptionMax);
  assert(out[0].evidence.length <= CAPS.evidenceMax);
});

Deno.test("3 maximal seat reports compact below 80k and merge validator accepts <=30/18k", () => {
  // Three seats, each at cap of 12 near-max findings.
  const seats = ["inspector", "contrarian", "strategist"].map((seat) => ({
    step_key: `audit_${seat}`,
    seat,
    findings: Array.from({ length: 12 }, (_, i) =>
      make({
        seat,
        severity: (i % 4 === 0 ? "P0" : i % 3 === 0 ? "P1" : i % 2 === 0 ? "P2" : "P3") as any,
        title: `${seat} finding ${i} ` + "t".repeat(120),
        description: "d".repeat(CAPS.descriptionMax),
        evidence: "e".repeat(CAPS.evidenceMax),
        file_path: `src/${seat}/${i}.tsx`,
      })
    ),
  }));
  const { block } = buildMergeInput(seats);
  assert(block.length <= CAPS.mergePayloadMax, `payload ${block.length} exceeded ${CAPS.mergePayloadMax}`);
  // Merge takes any 30 of these and stays under 18k when descriptions/evidence trimmed to cap.
  const merged = dedupeFindings(seats.flatMap((s) => s.findings)).slice(0, CAPS.mergeFindingsMax).map((f) => ({
    ...f,
    description: f.description.slice(0, 200),
    evidence: f.evidence.slice(0, 120),
  }));
  assertEquals(validateMerged(merged), null);
});

Deno.test("dedupeFindings collapses duplicates and keeps strongest", () => {
  const a = make({ severity: "P2", confidence: "low", evidence: "weak" });
  const b = make({ severity: "P1", confidence: "high", evidence: "strong evidence here that is concrete" });
  const merged = dedupeFindings([a, b]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].severity, "P1");
  assertStringIncludes(merged[0].evidence, "strong evidence");
});

Deno.test("downgradeUnsupported downgrades P0/P1 without evidence, no fix batch signal", () => {
  const findings = [
    make({ severity: "P0", evidence: "" }),           // missing evidence
    make({ severity: "P1", file_path: "" }),          // missing path
    make({ severity: "P1", confidence: "low" }),      // low conf
    make({ severity: "P1" }),                          // supported
  ];
  const { findings: out, downgrades } = downgradeUnsupported(findings);
  assertEquals(downgrades.length, 3);
  assertEquals(out.filter((f) => f.severity === "P2").length, 3);
  assertEquals(out.filter((f) => f.severity === "P1").length, 1);
});

Deno.test("supported serious finding survives downgrade (grounds a fix batch)", () => {
  const supported = make({ severity: "P0" });
  const { findings, downgrades } = downgradeUnsupported([supported]);
  assertEquals(downgrades.length, 0);
  assertEquals(findings[0].severity, "P0");
});

Deno.test("publishable Supabase key is not treated as secret leak", () => {
  // We don't detect secrets here — but ensure downgrade rules never *promote*
  // a mere filename mention into a serious finding.
  const f = normalizeFindings([{
    severity: "P0",
    file_path: "src/integrations/supabase/client.ts",
    title: "Anon key visible",
    description: "The Supabase publishable key is imported into the client bundle.",
    evidence: "file exists",
    confidence: "low",
  }])[0];
  const { downgrades } = downgradeUnsupported([f]);
  assertEquals(downgrades.length, 1);
  assertStringIncludes(downgrades[0].reason, "evidence");
});

Deno.test("validateSeatReport / validateMerged enforce caps and line invariants", () => {
  const good = [make()];
  assertEquals(validateSeatReport(good), null);
  assertEquals(validateMerged(good), null);

  const badLines = [make({ line_start: 10, line_end: 5 })];
  assertStringIncludes(String(validateMerged(badLines)), "line_end");

  const tooMany = Array.from({ length: CAPS.mergeFindingsMax + 1 }, () => make());
  assertStringIncludes(String(validateMerged(tooMany)), "max");
});

Deno.test("normalizeFindings converts null/blank lines to null rather than 0", () => {
  const out = normalizeFindings([
    { severity: "P2", title: "t", description: "d", evidence: "e", confidence: "medium", line_start: "", line_end: 0 },
  ]);
  assertEquals(out[0].line_start, null);
  assertEquals(out[0].line_end, null);
});
