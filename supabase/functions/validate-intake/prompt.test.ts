// Regression tests for validate-intake: prompt must reference each of the
// new required capture fields, and parseVerdict must apply deterministic
// caps whenever any of those fields is missing. Also verifies the 36/60
// pass threshold and legacy (five-dimension) intake response handling.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildUserPrompt, parseVerdict, PASS_THRESHOLD, MAX_SCORE } from "./prompt.ts";

Deno.test("PASS_THRESHOLD is 36 and MAX_SCORE is 60 (six dimensions)", () => {
  assertEquals(PASS_THRESHOLD, 36);
  assertEquals(MAX_SCORE, 60);
});

Deno.test("prompt names the 4a/4b/4c triple + 2a acquisition + 1a positioning + 5a/5b activation/wow", () => {
  const p = buildUserPrompt({
    idea: "x", buyer: "y", pain: "z", money: "subscription", inspiration: "a",
  });
  assertStringIncludes(p, "Paid offer (what they pay for): (not supplied)");
  assertStringIncludes(p, "Price anchor (best guess): (not supplied)");
  assertStringIncludes(p, "Upgrade trigger (buy/renew/upgrade): (not supplied)");
  assertStringIncludes(p, "Acquisition channel (first 10 buyers in 30 days): (not supplied)");
  assertStringIncludes(p, "Positioning (unlike X, why this): (not supplied)");
  assertStringIncludes(p, "Activation moment (useful result in first 90 seconds): (not supplied)");
  assertStringIncludes(p, "Wow moment (they'd immediately show someone): (not supplied)");
  assertStringIncludes(p, "cap monetization_path at 5");
  assertStringIncludes(p, "cap reachable_buyer at 5");
  assertStringIncludes(p, "cap differentiation at 5");
  assertStringIncludes(p, "cap activation_value at 5");
});

Deno.test("prompt inlines supplied values", () => {
  const p = buildUserPrompt({
    idea: "x", buyer: "y", pain: "z", money: "subscription", inspiration: "a",
    paid_offer: "workspace", price_anchor: "$19/mo", upgrade_trigger: "second client",
    acquisition_channel: "LinkedIn DMs", positioning: "Unlike Notion, focused on X",
    activation_moment: "first insight in 90s", wow_moment: "a screenshot",
  });
  assertStringIncludes(p, "Paid offer (what they pay for): workspace");
  assertStringIncludes(p, "Acquisition channel (first 10 buyers in 30 days): LinkedIn DMs");
  assertStringIncludes(p, "Positioning (unlike X, why this): Unlike Notion, focused on X");
  assertStringIncludes(p, "Activation moment (useful result in first 90 seconds): first insight in 90s");
  assertStringIncludes(p, "Wow moment (they'd immediately show someone): a screenshot");
});

function chairJson(overrides: Partial<Record<string, number>> = {}): string {
  const base = {
    painful_problem: 9, reachable_buyer: 9, monetization_path: 9,
    buildable_scope: 9, differentiation: 9, activation_value: 9,
  };
  const merged = { ...base, ...overrides };
  return JSON.stringify({
    scores: Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, { score: v, evidence: "e" }]),
    ),
    pivot: "",
  });
}

Deno.test("cap: monetization_path <= 5 when triple missing", () => {
  const v = parseVerdict(chairJson(), { idea: "x", money: "subscription",
    acquisition_channel: "x", positioning: "x", activation_moment: "x", wow_moment: "x" });
  assert(v);
  assertEquals(v!.scores.monetization_path.score, 5);
});

Deno.test("cap: reachable_buyer <= 5 when acquisition_channel missing", () => {
  const v = parseVerdict(chairJson(), {
    paid_offer: "a", price_anchor: "b", upgrade_trigger: "c",
    positioning: "x", activation_moment: "x", wow_moment: "x",
  });
  assert(v);
  assertEquals(v!.scores.reachable_buyer.score, 5);
});

Deno.test("cap: differentiation <= 5 when positioning missing", () => {
  const v = parseVerdict(chairJson(), {
    paid_offer: "a", price_anchor: "b", upgrade_trigger: "c",
    acquisition_channel: "x", activation_moment: "x", wow_moment: "x",
  });
  assert(v);
  assertEquals(v!.scores.differentiation.score, 5);
});

Deno.test("cap: activation_value <= 5 when either activation_moment or wow_moment missing", () => {
  const half = parseVerdict(chairJson(), {
    paid_offer: "a", price_anchor: "b", upgrade_trigger: "c",
    acquisition_channel: "x", positioning: "x", activation_moment: "x", // wow missing
  });
  assert(half);
  assertEquals(half!.scores.activation_value.score, 5);

  const other = parseVerdict(chairJson(), {
    paid_offer: "a", price_anchor: "b", upgrade_trigger: "c",
    acquisition_channel: "x", positioning: "x", wow_moment: "x", // activation missing
  });
  assert(other);
  assertEquals(other!.scores.activation_value.score, 5);
});

Deno.test("36/60 threshold: 36 passes, 35 kills (no single low)", () => {
  // 6+6+6+6+6+6 = 36 -> pass
  const pass = parseVerdict(chairJson({
    painful_problem: 6, reachable_buyer: 6, monetization_path: 6,
    buildable_scope: 6, differentiation: 6, activation_value: 6,
  }));
  assert(pass);
  assertEquals(pass!.total, 36);
  assertEquals(pass!.verdict, "pass");

  // 6+6+6+6+6+5 = 35 -> kill
  const kill = parseVerdict(chairJson({
    painful_problem: 6, reachable_buyer: 6, monetization_path: 6,
    buildable_scope: 6, differentiation: 6, activation_value: 5,
  }));
  assert(kill);
  assertEquals(kill!.total, 35);
  assertEquals(kill!.verdict, "kill");
});

Deno.test("any score <= 3 still kills regardless of total", () => {
  const v = parseVerdict(chairJson({ buildable_scope: 3 }));
  assert(v);
  assertEquals(v!.verdict, "kill");
});

Deno.test("parseVerdict returns null when a legacy chair response omits the new dimension", () => {
  // Missing activation_value entirely — parseVerdict rejects so the caller
  // falls back to error handling. Legacy stored results in the DB are read
  // separately (never re-parsed) so this does not crash the UI.
  const legacy = JSON.stringify({
    scores: {
      painful_problem: { score: 9, evidence: "e" },
      reachable_buyer: { score: 9, evidence: "e" },
      monetization_path: { score: 9, evidence: "e" },
      buildable_scope: { score: 9, evidence: "e" },
      differentiation: { score: 9, evidence: "e" },
    },
    pivot: "",
  });
  assertEquals(parseVerdict(legacy), null);
});
