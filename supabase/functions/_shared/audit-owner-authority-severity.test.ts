// OWNER-AUTHORITY-SEVERITY: the final audit must never publish a generic
// "no money path / pricing CTA / checkout / upgrade path" finding as P0/P1
// when the owner contract marks price_anchor OR upgrade_trigger as unset.
// The exact regression: "Landing page has no concrete money path" while
// "Price anchor: Not set by owner" is in the owner contract. A real broken
// EXISTING owner-authorized payment flow (OWNER_CONTRACT: / RUNTIME_FAILURE:
// markers) must still be allowed at its original severity.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  downgradeUnsupported,
  evaluateChairMergeCandidate,
  looksLikeUnauthorizedMonetizationClaim,
  type AuditOwnerContract,
  type CleanFinding,
} from "./audit-findings.ts";

function baseFinding(overrides: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "chair",
    severity: "P1",
    file_path: "src/routes/index.tsx",
    title: "Landing page has no concrete money path",
    description:
      "The landing page has no pricing CTA, checkout, or upgrade trigger; " +
      "there is no visible way for a visitor to become a paying customer.",
    evidence: "QUOTE: <a href=\"/auth\">Sign in</a> | WHY: no pricing or checkout CTA exists on the landing route.",
    confidence: "high",
    line_start: 42,
    line_end: 44,
    ...overrides,
  };
}

Deno.test("regex — matches the exact regression string 'concrete money path'", () => {
  assert(looksLikeUnauthorizedMonetizationClaim(
    "Landing page has no concrete money path",
    "No pricing CTA and no checkout on the landing page.",
  ));
});

Deno.test("regex — matches variants: pricing CTA, checkout, paywall, upgrade path", () => {
  for (const [t, d] of [
    ["No pricing CTA", "The hero has no pricing call-to-action."],
    ["Missing checkout flow", "There is no checkout implemented."],
    ["Paywall absent", "No paywall gates the app."],
    ["No upgrade path from free to paid", "Free tier has no upgrade trigger."],
    ["Monetization scope not implemented", "There is no monetization path."],
    ["Landing page missing a paid offer", "No paid offer displayed."],
  ] as const) {
    assert(looksLikeUnauthorizedMonetizationClaim(t, d), `${t}`);
  }
});

Deno.test("regex — skipped for backend infra paths (never classified here)", () => {
  assert(!looksLikeUnauthorizedMonetizationClaim(
    "No money path", "n/a", "supabase/functions/key-vault/index.ts",
  ));
});

Deno.test("severity gate — REGRESSION caps 'no concrete money path' from P1 to P2 when owner has not authorized price", () => {
  const ownerContract: AuditOwnerContract = { priceAnchorUnset: true, upgradeTriggerUnset: false };
  const { findings, downgrades, rejectedIndices } = downgradeUnsupported(
    [baseFinding({ severity: "P1" })],
    ownerContract,
  );
  assertEquals(findings[0].severity, "P2");
  assertEquals(rejectedIndices.size, 0); // Capped, not rejected — still published as P2.
  assert(downgrades.some((d) => /blocked-by-owner-decision/.test(d.reason)));
});

Deno.test("severity gate — caps P0 too when either monetization decision is unset", () => {
  for (const oc of [
    { priceAnchorUnset: true, upgradeTriggerUnset: false },
    { priceAnchorUnset: false, upgradeTriggerUnset: true },
    { priceAnchorUnset: true, upgradeTriggerUnset: true },
  ] as AuditOwnerContract[]) {
    const { findings } = downgradeUnsupported([baseFinding({ severity: "P0" })], oc);
    assertEquals(findings[0].severity, "P2");
  }
});

Deno.test("severity gate — DOES NOT cap when owner has authorized both price and upgrade AND finding carries OWNER_CONTRACT proof", () => {
  const ownerContract: AuditOwnerContract = { priceAnchorUnset: false, upgradeTriggerUnset: false };
  // Real broken owner-authorized flow — evidence carries the OWNER_CONTRACT
  // marker so Rule 4c also stands down; this is exactly the "real broken
  // EXISTING owner-authorized payment flow" case the gate must preserve.
  const evidence =
    "IMPACT: build_failure | OWNER_CONTRACT: intake.paid_offer='$29/mo subscription' | " +
    "QUOTE: <button onClick={checkout}>Buy</button> | WHY: onClick handler references undefined checkout fn.";
  const { findings } = downgradeUnsupported(
    [baseFinding({ severity: "P1", evidence })],
    ownerContract,
  );
  assertEquals(findings[0].severity, "P1");
});

Deno.test("severity gate — DOES NOT cap when OWNER_CONTRACT marker is present (broken existing authorized flow)", () => {
  const ownerContract: AuditOwnerContract = { priceAnchorUnset: true, upgradeTriggerUnset: true };
  const evidence =
    "OWNER_CONTRACT: intake.paid_offer='$29/mo subscription' | " +
    "QUOTE: <button onClick={checkout}>Buy</button> | WHY: onClick handler references undefined checkout fn.";
  const { findings } = downgradeUnsupported(
    [baseFinding({ severity: "P1", evidence })],
    ownerContract,
  );
  assertEquals(findings[0].severity, "P1"); // real broken owner-authorized flow preserved
});

Deno.test("severity gate — DOES NOT cap when RUNTIME_FAILURE marker is present", () => {
  const ownerContract: AuditOwnerContract = { priceAnchorUnset: true, upgradeTriggerUnset: true };
  const evidence =
    "RUNTIME_FAILURE: /api/checkout returned 500 in prod logs | " +
    "QUOTE: throw new Error('unreachable') | WHY: checkout endpoint crashes on every call.";
  const { findings } = downgradeUnsupported(
    [baseFinding({ severity: "P0", evidence })],
    ownerContract,
  );
  assertEquals(findings[0].severity, "P0");
});

Deno.test("severity gate — NO ownerContract argument leaves existing behaviour intact", () => {
  // Backwards-compat: when caller passes no owner context, the money-path
  // finding follows the existing Rule 4c product-strategy gate (which also
  // caps it to P2 because there is no OWNER_CONTRACT/RUNTIME_FAILURE).
  const { findings } = downgradeUnsupported([baseFinding({ severity: "P1" })]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("severity gate — fix-batch signal cannot contain the capped monetization finding", () => {
  const ownerContract: AuditOwnerContract = { priceAnchorUnset: true, upgradeTriggerUnset: true };
  const evalResult = evaluateChairMergeCandidate({
    summary: "One issue found.",
    verdict: "findings",
    findings: [baseFinding({ severity: "P1" })],
  }, ownerContract);
  // Capped finding remains published (as P2) so it stays visible to the
  // owner, but zero P0/P1 means no fix batch will be generated.
  const seriousCount = evalResult.findings.filter((f) => f.severity === "P0" || f.severity === "P1").length;
  assertEquals(seriousCount, 0);
  assertEquals(evalResult.findings.length, 1);
  assertEquals(evalResult.findings[0].severity, "P2");
});

Deno.test("severity gate — a real repo-proven issue on unrelated path is untouched", () => {
  const ownerContract: AuditOwnerContract = { priceAnchorUnset: true, upgradeTriggerUnset: true };
  const unrelated = baseFinding({
    severity: "P0",
    title: "auth-middleware trusts unsigned JWT",
    description: "The middleware accepts any bearer token without signature check.",
    evidence: "IMPACT: auth_bypass | QUOTE: if (token) return { userId: token } | WHY: no verify() call.",
    file_path: "supabase/functions/_shared/auth-middleware.ts",
  });
  const { findings } = downgradeUnsupported([unrelated], ownerContract);
  assertEquals(findings[0].severity, "P0");
});
