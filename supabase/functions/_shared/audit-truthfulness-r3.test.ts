// R3 — deterministic regression fixtures for CORE-TRUTHFULNESS-R3 audit
// classifiers. Adds SERVER_AUTH and OWNER_CONTRACT marker rules on top of the
// existing IMPACT / CURRENT / SCHEMA_LEDGER / CALLER rules, and pins the
// live audit 2d953efb false-P1 fixtures at exactly P2 without the required
// corroboration marker, and at P1 with it.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  downgradeUnsupported,
  hasOwnerContractMarker,
  hasServerAuthMarker,
  isFrontendPath,
  looksLikeClientSurfaceSecurityClaim,
  looksLikeProductStrategyClaim,
  looksLikeUniversalHelperClaim,
  reconcileAuditSummaryText,
  type CleanFinding,
} from "./audit-findings.ts";

function f(over: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P1",
    file_path: "src/routes/index.tsx",
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

Deno.test("marker helpers detect SERVER_AUTH / OWNER_CONTRACT", () => {
  assert(hasServerAuthMarker("SERVER_AUTH: CREATE POLICY ..."));
  assert(!hasServerAuthMarker("no marker here"));
  assert(hasOwnerContractMarker("OWNER_CONTRACT: locked PRD requires ..."));
  assert(!hasOwnerContractMarker("nope"));
});

Deno.test("classifiers detect client-surface security + product-strategy claims", () => {
  assert(isFrontendPath("src/routes/x.tsx"));
  assert(!isFrontendPath("supabase/functions/foo.ts"));
  assert(looksLikeClientSurfaceSecurityClaim(
    "Admin debug page has direct select",
    "The debug route runs a direct SELECT without checking admin",
    "src/routes/_authenticated/debug.runs.tsx",
  ));
  assert(!looksLikeClientSurfaceSecurityClaim(
    "Admin debug page has direct select",
    "direct select bypasses auth",
    "supabase/functions/x/index.ts",
  ));
  assert(looksLikeProductStrategyClaim(
    "Landing hero missing paid offer",
    "The hero copy has no monetization value proposition",
  ));
  assert(!looksLikeProductStrategyClaim(
    "Null dereference in loader",
    "The loader returns undefined and the component crashes",
  ));
});

// ---------------- Regression: false claims from audit 2d953efb ----------------

Deno.test("regression: human channel batches typecheck footer — no CALLER → P2", () => {
  const claim = f({
    severity: "P1",
    file_path: "supabase/functions/batch-compiler/index.ts",
    title: "Human channel batches incorrectly require typecheck footer",
    description: "footer check is outside isCodeChannel, applying to human batches",
    evidence: "QUOTE: if (!hasTypecheckFooter(text)) throw | WHY: no channel guard. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("universal-helper claim survives P1 with a real CALLER marker", () => {
  assert(looksLikeUniversalHelperClaim(
    "Human channel batches incorrectly require typecheck footer",
    "footer check is outside isCodeChannel",
  ));
  const claim = f({
    severity: "P1",
    file_path: "supabase/functions/batch-compiler/index.ts",
    title: "Human channel batches incorrectly require typecheck footer",
    description: "footer check is outside isCodeChannel, applying to human batches",
    evidence:
      "QUOTE: if (!hasTypecheckFooter(text)) throw | WHY: no channel guard. IMPACT: build_failure CALLER: batch-compiler/index.ts:412 invokes skeletonError for a channel=='human' batch.",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P1");
});

Deno.test("regression: admin debug direct SELECT without SERVER_AUTH → P2", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Admin debug page performs direct SELECT bypass",
    description: "The debug route reads run_steps directly bypassing admin authorization",
    evidence:
      "QUOTE: supabase.from('run_steps').select('*') | WHY: no admin gate in the client. IMPACT: auth_bypass",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("admin debug direct SELECT WITH SERVER_AUTH quote → stays P1", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Admin debug page performs direct SELECT bypass",
    description: "The debug route reads run_steps directly bypassing admin authorization",
    evidence:
      "QUOTE: supabase.from('run_steps').select('*') | WHY: no admin gate. IMPACT: auth_bypass SERVER_AUTH: CREATE POLICY run_steps_read ON public.run_steps FOR SELECT TO authenticated USING (true) — no admin scoping.",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P1");
});

Deno.test("regression: landing paid offer copy without OWNER_CONTRACT → P2", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Landing hero missing paid offer positioning",
    description: "The landing copy does not surface the paid offer or pricing anchor",
    evidence: "QUOTE: <h1>App Blueprint</h1> | WHY: no monetization CTA. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("R6: landing paid offer with OWNER_CONTRACT alone → stays P1 (constitution parity)", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Landing hero missing paid offer positioning",
    description: "The landing copy does not surface the paid offer or pricing anchor",
    evidence:
      "QUOTE: <h1>App Blueprint</h1> | WHY: no monetization CTA. IMPACT: build_failure OWNER_CONTRACT: locked PRD § Product strategy requires paid_offer surfaced on the landing hero.",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P1");
});


Deno.test("R4: product-strategy claim with RUNTIME_FAILURE marker → stays P1", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Landing hero paid offer CTA crashes",
    description: "The paid offer CTA on landing hero throws before the activation moment records",
    evidence:
      "QUOTE: onClick={() => track('paid')} | WHY: track is undefined. RUNTIME_FAILURE: ReferenceError: track is not defined at index.tsx:42",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P1");
});

Deno.test("regression: onboarding cohort-first copy without OWNER_CONTRACT → P2", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/onboarding.tsx",
    title: "Onboarding activation copy is cohort-first not buyer-first",
    description: "Onboarding leads with cohort code instead of the buyer activation flow",
    evidence: "QUOTE: <h2>Cohort code</h2> | WHY: buyer activation is deprioritized. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([claim]);
  assertEquals(findings[0].severity, "P2");
});

// ---------------- reconcileAuditSummaryText ----------------

Deno.test("reconcile — counts.P0=0 but text says 'P0' → deterministic counts sentence", () => {
  const text = "Chair merged 4 findings; 1 P0 needs immediate action.";
  const out = reconcileAuditSummaryText(text, { P0: 0, P1: 1, P2: 2, P3: 1 });
  assertEquals(out, "Validated counts: P0=0, P1=1, P2=2, P3=1.");
});

Deno.test("reconcile — counts.P0>0 also produces deterministic sentence (no model prose kept)", () => {
  const text = "1 P0 blocking build.";
  const out = reconcileAuditSummaryText(text, { P0: 1, P1: 0, P2: 0, P3: 0 });
  assertEquals(out, "Validated counts: P0=1, P1=0, P2=0, P3=0.");
  assert(!/blocking build/.test(out));
});


// ---------------- R7: broadened client-surface detector ----------------

Deno.test("R7: detector fires on browser READ of sensitive server field", () => {
  assert(looksLikeClientSurfaceSecurityClaim(
    "Debug page selects run_steps.response_text into browser",
    "The route reads response_text directly from the client without server gate",
    "src/routes/_authenticated/debug.runs.tsx",
  ));
});

Deno.test("R7: detector fires on client WRITE of privileged spend cap", () => {
  assert(looksLikeClientSurfaceSecurityClaim(
    "Cohort spend cap written from browser client",
    "Client-side update to cohorts.spend_cap without server-definer RPC",
    "src/routes/_authenticated/cohort.tsx",
  ));
});

Deno.test("R7: detector fires on UI-only enforcement claim", () => {
  assert(looksLikeClientSurfaceSecurityClaim(
    "Dismiss finding: severity only enforced in UI",
    "The dismissal button is a UI-only check, no RLS or trigger blocks P0 dismissal",
    "src/components/audit-findings-panel.tsx",
  ));
});

Deno.test("R7: detector still ignores generic UX findings", () => {
  assert(!looksLikeClientSurfaceSecurityClaim(
    "Button contrast fails WCAG",
    "The primary button text is 3.1:1 contrast on brass background",
    "src/components/ui/button.tsx",
  ));
});

Deno.test("R7: broadened claims are REJECTED without SERVER_AUTH at any severity", () => {
  const claim = f({
    severity: "P2",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Debug page reads response_text",
    description: "Browser reads response_text directly",
    evidence: "QUOTE: supabase.from('run_steps').select('response_text') | WHY: bypasses gate",
  });
  const { downgrades, rejectedIndices } = downgradeUnsupported([claim]);
  assert(rejectedIndices.has(0), "must be rejected");
  assert(downgrades.some((d) => d.disposition === "rejected_unsupported"));
});

Deno.test("R7: broadened claim WITH SERVER_AUTH is preserved", () => {
  const claim = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/debug.runs.tsx",
    title: "Debug page reads response_text",
    description: "Browser reads response_text directly",
    evidence:
      "QUOTE: supabase.from('run_steps').select('response_text') | WHY: no policy blocks it. " +
      "IMPACT: secret_exposure SERVER_AUTH: CREATE POLICY \"read own runs\" ON run_steps FOR SELECT USING (user_id = auth.uid())",
  });
  const { findings, rejectedIndices } = downgradeUnsupported([claim]);
  assertEquals(rejectedIndices.size, 0);
  assertEquals(findings[0].severity, "P1");
});
