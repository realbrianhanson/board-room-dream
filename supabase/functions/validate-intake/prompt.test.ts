// Regression tests for validate-intake: prompt must reference the new
// monetization triple (paid_offer/price_anchor/upgrade_trigger), and
// parseVerdict must cap monetization_path <= 5 when any of the three is
// missing from the intake answers (legacy intakes).
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildUserPrompt, parseVerdict } from "./index.ts";

Deno.test("validate-intake prompt names the 4a/4b/4c triple + hard cap rule", () => {
  const p = buildUserPrompt({
    idea: "x", buyer: "y", pain: "z", money: "subscription", inspiration: "a",
  });
  assertStringIncludes(p, "Paid offer (what they pay for): (not supplied)");
  assertStringIncludes(p, "Price anchor (best guess): (not supplied)");
  assertStringIncludes(p, "Upgrade trigger (buy/renew/upgrade): (not supplied)");
  assertStringIncludes(p, "MONETIZATION SCORING RULE");
  assertStringIncludes(p, "cap monetization_path at 5");
});

Deno.test("validate-intake prompt inlines supplied monetization triple values", () => {
  const p = buildUserPrompt({
    idea: "x", buyer: "y", pain: "z", money: "subscription",
    paid_offer: "monthly workspace", price_anchor: "$19/mo", upgrade_trigger: "second client",
    inspiration: "notion",
  });
  assertStringIncludes(p, "Paid offer (what they pay for): monthly workspace");
  assertStringIncludes(p, "Price anchor (best guess): $19/mo");
  assertStringIncludes(p, "Upgrade trigger (buy/renew/upgrade): second client");
});

function chairJson(monetization: number): string {
  return JSON.stringify({
    scores: {
      painful_problem:   { score: 9, evidence: "e" },
      reachable_buyer:   { score: 9, evidence: "e" },
      monetization_path: { score: monetization, evidence: "e" },
      buildable_scope:   { score: 9, evidence: "e" },
      differentiation:   { score: 9, evidence: "e" },
    },
    pivot: "",
  });
}

Deno.test("parseVerdict caps monetization_path at 5 when triple is missing (legacy intake)", () => {
  const legacyAnswers = { idea: "x", money: "subscription" };
  const v = parseVerdict(chairJson(9), legacyAnswers);
  assert(v);
  assertEquals(v!.scores.monetization_path.score, 5);
  // Total = 9+9+5+9+9 = 41
  assertEquals(v!.total, 41);
});

Deno.test("parseVerdict leaves monetization_path unchanged when triple is fully supplied", () => {
  const full = {
    idea: "x", money: "subscription",
    paid_offer: "a", price_anchor: "b", upgrade_trigger: "c",
  };
  const v = parseVerdict(chairJson(9), full);
  assert(v);
  assertEquals(v!.scores.monetization_path.score, 9);
});

Deno.test("parseVerdict without answers (backwards-compatible) does not cap", () => {
  const v = parseVerdict(chairJson(9));
  assert(v);
  assertEquals(v!.scores.monetization_path.score, 9);
});
