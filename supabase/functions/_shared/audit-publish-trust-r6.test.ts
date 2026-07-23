// AUDIT-PUBLISH-TRUST-R6 — regression fixtures pinned to audit cef4de90.
// A) Factual-proof gates now apply to ANY incoming severity (P0/P1/P2/P3);
//    an unsupported factual claim arriving as P2 is REJECTED, not published.
// B) The persisted audit summary cannot use severity words (critical / P0 /
//    P1 / high-severity) unless a published finding backs them, and cannot
//    name a rejected finding.
// C) Backend security/authority/parser/orchestration code is NOT classified
//    as product-strategy just because its evidence contains buyer / payment
//    / pricing words.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  downgradeUnsupported,
  evaluateChairMergeCandidate,
  isBackendInfraPath,
  looksLikeProductStrategyClaim,
  reconcileAuditSummaryText,
  type CleanFinding,
} from "./audit-findings.ts";

function f(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P2",
    file_path: "src/routes/foo.tsx",
    title: "t",
    description: "d",
    evidence: "QUOTE: code | WHY: reason it is broken.",
    confidence: "high",
    line_start: 1,
    line_end: 2,
    ...over,
  };
}

// ---------- 1. Severity-agnostic evidence rejection ----------

Deno.test("R6 P2 client-surface admin-gate claim lacking SERVER_AUTH is REJECTED", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Admin gate is client-only via profiles.role",
    description: "The admin debug page performs an unauthorized privilege bypass via UI role check.",
    evidence: "QUOTE: if (profile.role !== 'admin') return null | WHY: UI-only gate.",
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0, "unsupported P2 client-surface security claim must not be published");
  const rejected = downgrades.filter((d) => d.disposition === "rejected_unsupported");
  assert(rejected.some((d) => /SERVER_AUTH/.test(d.reason)));
  assert(rejected.every((d) => d.published === false));
});

Deno.test("R6 P2 cohort.tsx role-check claim lacking SERVER_AUTH is REJECTED", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/cohort.tsx",
    title: "Role checked directly on profiles table instead of user_roles",
    description: "Client-side auth bypass check reads profiles.role for admin panel access.",
    evidence: "QUOTE: supabase.from('profiles').select('role') | WHY: role check on client.",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
});

Deno.test("R6 P2 runway_.$projectId.tsx direct-query claim lacking SERVER_AUTH is REJECTED", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/runway_.$projectId.tsx",
    title: "Batch status and project fields updated directly from browser",
    description: "Client performs a direct SELECT/UPDATE bypassing server authorization.",
    evidence: "QUOTE: supabase.from('batches').update(...) | WHY: direct query from browser.",
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
  assert(downgrades.some((d) => d.disposition === "rejected_unsupported"));
});

Deno.test("R6 P2 migration claim without CURRENT is REJECTED", () => {
  const finding = f({
    severity: "P2",
    file_path: "supabase/migrations/20250101_init.sql",
    title: "projects table missing status column (old migration)",
    description: "Historical migration lacks the status column.",
    evidence: "QUOTE: CREATE TABLE projects(id uuid) | WHY: no status column.",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
});

Deno.test("R6 legitimate P2 product recommendation is still PUBLISHED", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/index.tsx",
    title: "Landing hero copy misses buyer positioning",
    description: "The landing hero copy doesn't surface the paid offer for the primary buyer.",
    evidence: 'QUOTE: <h1>App Blueprint</h1> | WHY: no monetization CTA.',
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1, "product P2 recommendations still publish");
  assertEquals(published[0].severity, "P2");
  assertEquals(downgrades.filter((d) => d.disposition === "rejected_unsupported").length, 0);
});

// ---------- 2. Correct product classifier (path exclusion) ----------

Deno.test("R6 isBackendInfraPath recognises supabase functions/migrations/tests", () => {
  assert(isBackendInfraPath("supabase/functions/_shared/owner-authority.ts"));
  assert(isBackendInfraPath("supabase/functions/batch-compiler/index.ts"));
  assert(isBackendInfraPath("supabase/migrations/20260101_x.sql"));
  assert(isBackendInfraPath("supabase/tests/foo.sql"));
  assert(!isBackendInfraPath("src/routes/index.tsx"));
  assert(!isBackendInfraPath(null));
});

Deno.test("R6 owner-authority.ts DROP/pay detection is NOT product-strategy", () => {
  const title = "Masked DROP TABLE / payment directive slips owner-authority gate";
  const description = "High-impact payment/pricing directive is not rejected by owner-authority check.";
  assert(!looksLikeProductStrategyClaim(title, description, "supabase/functions/_shared/owner-authority.ts"));
  // The exact same title WITHOUT path context — legacy behaviour still triggers.
  assert(looksLikeProductStrategyClaim(title, description));
});

Deno.test("R6 owner-authority P1 with concrete QUOTE/WHY + IMPACT remains P1 and PUBLISHED", () => {
  const finding = f({
    severity: "P1",
    file_path: "supabase/functions/_shared/owner-authority.ts",
    title: "Masked DROP TABLE / payment directive slips owner-authority gate",
    description: "The high-impact detector fails to flag a masked DROP TABLE payment directive.",
    evidence:
      "QUOTE: if (/drop table/i.test(text)) return { authorized: true } | WHY: authorized:true on match instead of false. IMPACT: data_loss",
    confidence: "high",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1);
  assertEquals(published[0].severity, "P1");
});

// ---------- 3. Summary derived from published truth ----------

Deno.test("R6 reconcile — 'critical flaw' with P0=0 is replaced entirely", () => {
  const text = "One critical flaw in owner-authority: DROP TABLE bypass.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 2, P2: 3, P3: 0 });
  assertEquals(out, "Validated counts: P0=0, P1=2, P2=3, P3=0.");
});

Deno.test("R6 reconcile — rejected title never leaks into summary text", () => {
  const text = "The masked DROP TABLE / payment directive is critical.";
  const out = reconcileAuditSummaryText(
    text,
    { P0: 0, P1: 0, P2: 1, P3: 0 },
    ["Masked DROP TABLE / payment directive slips owner-authority gate"],
  );
  assertEquals(out, "Validated counts: P0=0, P1=0, P2=1, P3=0.");
});

Deno.test("R6 reconcile — 'high-severity' with P0=P1=0 is replaced", () => {
  const text = "Multiple high-severity issues noted.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 0, P2: 2, P3: 0 });
  assertEquals(out, "Validated counts: P0=0, P1=0, P2=2, P3=0.");
});

Deno.test("R6 reconcile — 'serious' with P0=P1=0 is replaced", () => {
  const text = "Two serious problems found.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 0, P2: 2, P3: 0 });
  assertEquals(out, "Validated counts: P0=0, P1=0, P2=2, P3=0.");
});

Deno.test("R6 reconcile — matching model prose is ALSO replaced (deterministic policy)", () => {
  const text = "Two P1 findings should be resolved.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 2, P2: 0, P3: 0 });
  assertEquals(out, "Validated counts: P0=0, P1=2, P2=0, P3=0.");
  assert(!/Two P1 findings/.test(out));
});


Deno.test("R6 evaluateChairMergeCandidate — verdict is clean iff published.length===0", () => {
  const rejectedP2 = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Admin gate is client-only",
    description: "unauthorized admin bypass on debug page",
    evidence: "QUOTE: if (role !== 'admin') return null | WHY: UI check.",
  });
  const evalResult = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "One critical admin bypass on the debug page.",
    findings: [rejectedP2],
  });
  assertEquals(evalResult.findings.length, 0);
  assertEquals(evalResult.verdict, "clean");
});

// ---------- Regression: R4 rescored (not rejected) product recommendation still counts ----------

Deno.test("R6 downgradeUnsupported: P2 product-strategy claim is NOT rejected by path exclusion when file is frontend", () => {
  const finding = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/onboarding.tsx",
    title: "Onboarding activation copy is buyer-first",
    description: "Onboarding CTA leads with generic wording instead of buyer positioning.",
    evidence: 'QUOTE: <h2>Welcome</h2> | WHY: generic copy.',
  });
  const { findings, downgrades, rejectedIndices } = downgradeUnsupported([finding]);
  assertEquals(rejectedIndices.has(0), false);
  assertEquals(findings[0].severity, "P2");
  assertEquals(downgrades.filter((d) => d.disposition === "rejected_unsupported").length, 0);
});

// ---------- 4. Constitution parity — OWNER_CONTRACT preserves product-strategy P1 ----------

Deno.test("R6 constitution — product-strategy P1 with OWNER_CONTRACT marker is preserved", () => {
  const finding = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/onboarding.tsx",
    title: "Activation deprioritizes buyer flow",
    description: "Onboarding leads with cohort code instead of the promised buyer activation flow.",
    evidence:
      "QUOTE: <h2>Cohort code</h2> | WHY: buyer activation is hidden below fold. OWNER_CONTRACT: 'Founder must reach first flagged risk in 90 seconds' (intake wow_moment).",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1);
  assertEquals(published[0].severity, "P1");
});

Deno.test("R6 constitution — product-strategy P1 without OWNER_CONTRACT nor RUNTIME_FAILURE caps to P2", () => {
  const finding = f({
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Pricing page uses weak positioning",
    description: "Landing lacks a decisive positioning line for the buyer segment.",
    evidence: "QUOTE: <h1>App</h1> | WHY: no differentiator statement.",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  // With no marker + speculative-free evidence, it's rescored to P2 and published.
  assertEquals(published.length, 1);
  assertEquals(published[0].severity, "P2");
});

Deno.test("R6 constitution — product-strategy P1 with RUNTIME_FAILURE marker is preserved", () => {
  const finding = f({
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Buyer activation flow throws",
    description: "Landing CTA to onboarding raises at runtime.",
    evidence:
      "QUOTE: throw new Error('missing route') | WHY: CTA route missing. RUNTIME_FAILURE: TypeError at /onboarding start.",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 1);
  assertEquals(published[0].severity, "P1");
});

// ---------- 5. Summary count-mismatch reconciliation ----------

Deno.test("R7 reconcile — 'Three P1 issues' with counts.P1=1 is replaced with deterministic sentence", () => {
  const text = "Three P1 issues need attention before ship.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 1, P2: 10, P3: 0 });
  assert(out.startsWith("Validated counts:"));
  assert(!/three\s+P1/i.test(out), `output must drop contradictory count claim: ${out}`);
  assert(out.includes("P1=1"));
});

Deno.test("R7 reconcile — matching '2 P1' with counts.P1=2 is preserved", () => {
  const text = "2 P1 findings are open.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 2, P2: 0, P3: 0 });
  assert(out.includes("P1=2"));
  assert(out.includes("2 P1 findings"));
});
