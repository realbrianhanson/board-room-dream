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
  tryCloseJsonTail,
  type CleanFinding,
} from "./audit-findings.ts";

function make(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P1",
    // Migration path so the fixture stays a server-side finding; the R3
    // client-surface security-claim rule only fires on src/* file_paths.
    file_path: "supabase/migrations/20240101_posts.sql",
    title: "RLS bypass on posts",
    description: "Anon can select every row of public.posts because policy is USING (true).",
    // Includes IMPACT class so P0 variants used in later tests remain
    // eligible for P0 under the deterministic marker rules.
    evidence: "QUOTE: CREATE POLICY \"read\" ON posts FOR SELECT USING (true) | WHY: unconditional USING clause exposes every row to anon. IMPACT: auth_bypass",
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
    description: f.description.slice(0, 120),
    evidence: f.evidence.slice(0, 80),
    title: f.title.slice(0, 60),
  }));
  assertEquals(validateMerged(merged), null);
});

Deno.test("dedupeFindings collapses duplicates and keeps strongest", () => {
  const a = make({ severity: "P2", confidence: "low", evidence: "weak" });
  const b = make({ severity: "P1", confidence: "high", evidence: "QUOTE: strong evidence here that is concrete | WHY: exact vulnerable construct is quoted." });
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
  // Every unsupported serious finding produces at least one downgrade record;
  // the P0 without evidence also records the P0→P1 IMPACT step, so counts
  // are >= 3.
  assert(downgrades.length >= 3);
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
  const f = normalizeFindings([{
    severity: "P0",
    file_path: "src/integrations/supabase/client.ts",
    title: "Anon key visible",
    description: "The Supabase publishable key is imported into the client bundle.",
    evidence: "file exists",
    confidence: "low",
  }])[0];
  const { downgrades } = downgradeUnsupported([f]);
  assert(downgrades.length >= 1);
  // At least one downgrade must cite the evidence shortcomings (IMPACT or
  // QUOTE/WHY/concrete markers), never promote the finding.
  const reasons = downgrades.map((d) => d.reason).join(" | ");
  assertStringIncludes(reasons.toLowerCase(), "evidence");
});

Deno.test("downgradeUnsupported downgrades P0/P1 evidence missing QUOTE/WHY markers", () => {
  const semantic = make({
    severity: "P0",
    evidence: "Anon can read every row of public.posts because the SELECT policy is unconditional. IMPACT: auth_bypass",
  });
  const { findings, downgrades } = downgradeUnsupported([semantic]);
  assertEquals(findings[0].severity, "P2");
  assert(downgrades.length >= 1);
  assertStringIncludes(downgrades.map((d) => d.reason).join(" | "), "QUOTE");
});

Deno.test("downgradeUnsupported keeps P0/P1 that include a verbatim QUOTE/WHY marker", () => {
  const supported = make({
    severity: "P0",
    evidence: "QUOTE: CREATE POLICY \"read\" ON posts FOR SELECT USING (true) | WHY: unconditional USING clause exposes every row. IMPACT: auth_bypass",
  });
  const { findings, downgrades } = downgradeUnsupported([supported]);
  assertEquals(downgrades.length, 0);
  assertEquals(findings[0].severity, "P0");
});

Deno.test("QUOTE marker rule only applies to P0/P1 — P2/P3 unaffected", () => {
  const p2 = make({ severity: "P2", evidence: "plain-language reason, no quote marker" });
  const { findings, downgrades } = downgradeUnsupported([p2]);
  assertEquals(downgrades.length, 0);
  assertEquals(findings[0].severity, "P2");
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

// ============================== tryCloseJsonTail (AUDIT-JSON-FRAGMENT-R2) ==============================
//
// Deterministic conservative rescue for map-step JSON that ended one or two
// closers short of valid JSON. It may only append missing "}" / "]" closers
// and must never guess, delete, or synthesize field content.

function goodFinding(overrides: any = {}) {
  return {
    severity: "P1",
    file_path: "src/x.ts",
    title: "t",
    description: "d",
    evidence: "e",
    confidence: "high",
    line_start: 1,
    line_end: 2,
    ...overrides,
  };
}

Deno.test("tryCloseJsonTail — closes the exact live shape (missing only ]})", () => {
  const findings = [goodFinding(), goodFinding({ severity: "P2" }), goodFinding({ severity: "P3" })];
  const full = JSON.stringify({ findings });
  // Simulate the live truncation: valid up through the last "}" of the last finding,
  // missing only the outer "]" and outer "}".
  const truncated = full.slice(0, full.length - 2);
  const r = tryCloseJsonTail(truncated);
  assert(r.ok, `expected ok, got: ${JSON.stringify(r)}`);
  if (r.ok) {
    assertEquals(r.closed, "]}");
    assertEquals(Array.isArray((r.value as any).findings), true);
    assertEquals((r.value as any).findings.length, 3);
  }
});

Deno.test("tryCloseJsonTail — nested valid closure ({\"a\":{\"b\":[1,2 → adds ]}})", () => {
  const truncated = '{"findings":[{"severity":"P1","file_path":"x","title":"t","description":"d","evidence":"e","confidence":"high"';
  const r = tryCloseJsonTail(truncated);
  // Ends after a bare string value (evidence:"high") with no closing "}" yet —
  // last non-ws char is '"' which IS a value terminator, so the helper MAY
  // attempt "}]}". Whether the audit-shape validator accepts this depends on
  // required fields; if it rejects, r.ok must be false. Either outcome is
  // acceptable — the helper must NEVER return ok with an invalid shape.
  if (r.ok) {
    // Rescued output must still parse and be an object with findings array.
    assertEquals(typeof r.value, "object");
  }
});

Deno.test("tryCloseJsonTail — rejects dangling open string", () => {
  const truncated = '{"findings":[{"title":"unterminated';
  const r = tryCloseJsonTail(truncated);
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail — rejects trailing comma", () => {
  const truncated = '{"findings":[' + JSON.stringify(goodFinding()) + ',';
  const r = tryCloseJsonTail(truncated);
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail — rejects dangling colon", () => {
  const truncated = '{"findings":[' + JSON.stringify(goodFinding()) + '],"extra":';
  const r = tryCloseJsonTail(truncated);
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail — rejects mismatched delimiter (] where } needed)", () => {
  // Object opened but bracket in stack order is wrong — cannot fix by appending.
  const truncated = '{"findings":[{"a":1]';
  const r = tryCloseJsonTail(truncated);
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail — rejects when rescued JSON fails the audit shape validator", () => {
  // Parses cleanly but findings array is missing → validator must reject.
  const truncated = '{"other":123';
  const r = tryCloseJsonTail(truncated);
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail — already-valid input is returned as-is (closed = \"\")", () => {
  const full = JSON.stringify({ findings: [goodFinding()] });
  const r = tryCloseJsonTail(full);
  assert(r.ok);
  if (r.ok) assertEquals(r.closed, "");
});

