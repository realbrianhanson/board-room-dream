// AUDIT-PUBLISH-TRUST-R4 — regression fixtures pinned to audit 75171129.
// Unsupported factual P0/P1 claims must be OMITTED from published findings
// (not just rescored to P2 misinformation). Ledger stays visible for
// observability; counts / verdict / fix_prompt see only published findings.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  downgradeUnsupported,
  evaluateChairMergeCandidate,
  looksLikeTruncationClaim,
  hasFullSourceMarker,
  type CleanFinding,
} from "./audit-findings.ts";

function f(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P1",
    file_path: "src/routes/foo.tsx",
    title: "t",
    description: "d",
    evidence:
      'QUOTE: some code | WHY: reason it is broken. IMPACT: build_failure',
    confidence: "high",
    line_start: 1,
    line_end: 2,
    ...over,
  };
}

Deno.test("cohort.tsx browser role gate without SERVER_AUTH is REJECTED (not published as P2)", () => {
  const finding = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/cohort.tsx",
    title: "Admin bypass on cohort page",
    description: "Client-side role check permits unauthorized access to admin panel.",
    // no SERVER_AUTH marker
    evidence: "QUOTE: if (role !== 'admin') return null | WHY: this is only a UI check. IMPACT: auth_bypass",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0, "unsupported client-surface security claim must not be published");
});

Deno.test("debug.runs.tsx UI-only admin gate without SERVER_AUTH is REJECTED", () => {
  const finding = f({
    severity: "P0",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Unauthorized admin route",
    description: "The debug runs page performs an admin-only privilege escalation via client check.",
    evidence: "QUOTE: role === 'admin' ? <Panel /> : null | WHY: purely UI gate. IMPACT: auth_bypass",
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
  const rejected = downgrades.filter((d) => d.disposition === "rejected_unsupported");
  assert(rejected.length >= 1);
  assert(rejected.some((d) => /SERVER_AUTH/i.test(d.reason)));
});

Deno.test("old migration claim without CURRENT is REJECTED, not published as P2", () => {
  const finding = f({
    severity: "P1",
    file_path: "supabase/migrations/20250101_init.sql",
    title: "intakes table missing owner column",
    description: "The intakes table lacks an owner_id column so RLS cannot scope by user.",
    // no CURRENT marker — this is a historical migration citation
    evidence: "QUOTE: CREATE TABLE public.intakes(id uuid primary key) | WHY: no owner_id defined.",
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
  assert(downgrades.some((d) => d.disposition === "rejected_unsupported" && /CURRENT/.test(d.reason)));
});

Deno.test("universal typecheck-helper claim without CALLER is REJECTED", () => {
  const finding = f({
    severity: "P1",
    file_path: "supabase/functions/batch-compiler/typecheck.ts",
    title: "Human channel batches incorrectly require typecheck footer",
    description: "The footer check is outside isCodeChannel, so human batches also hit it.",
    // no CALLER marker
    evidence: "QUOTE: assertTypecheckFooter(prompt) | WHY: called before channel branch.",
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
  assert(downgrades.some((d) => d.disposition === "rejected_unsupported" && /CALLER/.test(d.reason)));
});

Deno.test("product acquisition finding with OWNER_CONTRACT preserves P1 (constitution parity)", () => {
  const finding = f({
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Landing acquisition copy misses primary buyer persona",
    description: "The onboarding activation copy doesn't reach the buyer named in the intake.",
    evidence: 'QUOTE: "Get started" | WHY: generic. OWNER_CONTRACT: intake buyer = "solo Lovable founders shipping MVPs"',
    confidence: "high",
  });
  const { findings: published } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  // R6 constitution parity: EITHER OWNER_CONTRACT: OR RUNTIME_FAILURE:
  // preserves product-strategy severity. Only when BOTH are absent does
  // the finding cap to P2.
  assertEquals(published.length, 1);
  assertEquals(published[0].severity, "P1");
});


Deno.test("product flow with concrete RUNTIME_FAILURE remains P1 and PUBLISHED", () => {
  const finding = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/onboarding.tsx",
    title: "Onboarding activation flow crashes on submit",
    description: "The primary onboarding CTA throws before the activation moment is recorded.",
    evidence:
      'QUOTE: navigate({ to: "/dashboard" }) | WHY: called before session hydrates. RUNTIME_FAILURE: TypeError: Cannot read properties of null (reading id) at onboarding.tsx:42',
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

Deno.test("supported OAuth-origin P1 remains P1 and PUBLISHED", () => {
  const finding = f({
    severity: "P1",
    file_path: "supabase/functions/github-oauth/index.ts",
    title: "OAuth start trusts unbound origin",
    description: "Body.origin is used without allow-list checking, enabling redirect_uri spoofing.",
    evidence:
      "QUOTE: const origin = body.origin; return redirect(origin + '/callback') | WHY: attacker-controlled origin bound into callback URL. IMPACT: auth_bypass",
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

Deno.test("supported CR owner-scope P1 remains P1 and PUBLISHED", () => {
  const finding = f({
    severity: "P1",
    file_path: "supabase/functions/boardroom-orchestrator/queues.ts",
    title: "change_requests lookup missing tenant filter",
    description: "createInitialSteps reads change_requests by id only, allowing cross-tenant leakage.",
    evidence:
      "QUOTE: admin.from('change_requests').select().eq('id', crId) | WHY: no project_id or user_id filter. IMPACT: auth_bypass",
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

Deno.test("counts and verdict reflect only the published post-filter array", () => {
  const rejectedClientSec = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/cohort.tsx",
    title: "Admin bypass — UI only",
    description: "Client-side role check bypass on admin panel.",
    evidence: "QUOTE: role !== 'admin' | WHY: UI check only. IMPACT: auth_bypass",
  });
  const rejectedMigration = f({
    severity: "P1",
    file_path: "supabase/migrations/20250101_init.sql",
    title: "projects table missing status",
    description: "Historical migration lacks status column.",
    evidence: "QUOTE: CREATE TABLE projects(id uuid) | WHY: no status.",
  });
  const supported = f({
    severity: "P0",
    file_path: "supabase/functions/github-oauth/index.ts",
    title: "OAuth origin not bound",
    description: "Callback redirect_uri is derived from attacker-controlled origin.",
    evidence:
      "QUOTE: return redirect(body.origin + '/cb') | WHY: no allow-list. IMPACT: auth_bypass",
  });
  const evalResult = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "Two serious P1 issues and one P0 detected.",
    findings: [rejectedClientSec, rejectedMigration, supported],
  });
  assertEquals(evalResult.findings.length, 1);
  assertEquals(evalResult.findings[0].severity, "P0");
  assertEquals(evalResult.verdict, "findings");
  // Ledger records both rejections plus zero rescores for this fixture.
  const rejected = evalResult.downgrades.filter((d) => d.disposition === "rejected_unsupported");
  assertEquals(rejected.length, 2);
  assert(evalResult.downgrades.every((d) => typeof d.published === "boolean"));
  assert(rejected.every((d) => d.published === false));
});

Deno.test("truncation/incomplete-source claim without FULL_SOURCE is REJECTED", () => {
  assert(looksLikeTruncationClaim("File truncated mid-token", "The function body ends unterminated."));
  assert(!hasFullSourceMarker("QUOTE: foo"));
  assert(hasFullSourceMarker("FULL_SOURCE: complete text here"));
  const finding = f({
    severity: "P1",
    file_path: "src/lib/thing.ts",
    title: "Module truncated / malformed",
    description: "The exported function is cut off mid-statement, breaking the build.",
    evidence: "QUOTE: export function foo( | WHY: no closing paren. IMPACT: build_failure",
  });
  const { findings: published, downgrades } = evaluateChairMergeCandidate({
    verdict: "findings",
    summary: "",
    findings: [finding],
  });
  assertEquals(published.length, 0);
  assert(downgrades.some((d) => d.disposition === "rejected_unsupported" && /FULL_SOURCE/.test(d.reason)));
});

Deno.test("downgradeUnsupported still returns rejectedIndices for observability", () => {
  const findings = [
    f({
      severity: "P1",
      file_path: "src/routes/x.tsx",
      title: "admin bypass",
      description: "unauthorized access via UI check",
      evidence: "QUOTE: role !== 'admin' | WHY: ui. IMPACT: auth_bypass",
    }),
    f({ severity: "P2" }), // untouched
  ];
  const { downgrades, rejectedIndices } = downgradeUnsupported(findings);
  assertEquals(rejectedIndices.has(0), true);
  assertEquals(rejectedIndices.has(1), false);
  assert(downgrades.length >= 1);
  assertEquals(downgrades[0].disposition, "rejected_unsupported");
  assertEquals(downgrades[0].published, false);
});
