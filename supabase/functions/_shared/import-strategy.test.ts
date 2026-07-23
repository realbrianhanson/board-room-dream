import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isFieldValid,
  isMonetizationOwnerInputUnset,
  isOptionalMonetizationField,
  OPTIONAL_MONETIZATION_FIELDS,
  RECOMMEND_PLACEHOLDER,
  REQUIRED_STRATEGY_FIELDS,
  STRATEGY_FIELDS,
  validateImportStrategy,
} from "./import-strategy.ts";

const full = {
  buyer: "Independent advisers",
  acquisition_channel: "LinkedIn DMs",
  paid_offer: "Weekly briefing",
  price_anchor: "$29/mo",
  upgrade_trigger: "Monthly regulator update",
  activation_moment: "See flagged risk in 90s",
  wow_moment: "One-page risk summary",
  positioning: "Unlike PDFs, flags client risk",
};

const sixRequiredOnly = { ...full, price_anchor: "", upgrade_trigger: "" };

Deno.test("parity — 8 canonical strategy fields (6 required + 2 optional)", () => {
  assertEquals(STRATEGY_FIELDS.length, 8);
  assertEquals(REQUIRED_STRATEGY_FIELDS.length, 6);
  assertEquals(OPTIONAL_MONETIZATION_FIELDS, ["price_anchor", "upgrade_trigger"] as const);
  for (const f of OPTIONAL_MONETIZATION_FIELDS) assert(isOptionalMonetizationField(f));
  for (const f of REQUIRED_STRATEGY_FIELDS) assert(!isOptionalMonetizationField(f));
});

Deno.test("parity — six required valid + both monetization blank => zero issues", () => {
  assertEquals(validateImportStrategy(sixRequiredOnly).length, 0);
});

Deno.test("parity — blank required field => 'missing'", () => {
  const issues = validateImportStrategy({ ...sixRequiredOnly, buyer: "" });
  assertEquals(issues[0].field, "buyer");
  assertEquals(issues[0].reason, "missing");
});

Deno.test("parity — recommend placeholder only valid on recommendable fields", () => {
  assert(isFieldValid("price_anchor", RECOMMEND_PLACEHOLDER));
  assert(isFieldValid("upgrade_trigger", RECOMMEND_PLACEHOLDER));
  assert(!isFieldValid("buyer", RECOMMEND_PLACEHOLDER));
});

Deno.test("parity — monetization unset helper recognizes canonical and legacy owner-decision phrases", () => {
  const legacyPrice = "Not set by owner — the Board must recommend a price and clearly label the recommendation as an assumption.";
  const legacyUpgrade = "Not set by owner — the Board must recommend a clear project- or usage-based upgrade trigger and label it as an assumption.";
  for (const v of [
    "",
    RECOMMEND_PLACEHOLDER,
    legacyPrice,
    legacyUpgrade,
    "Not supplied by owner",
    "[OWNER DECISION REQUIRED] choose later",
    "proposal_requires_owner_approval",
    "Board should recommend",
  ]) {
    assert(isMonetizationOwnerInputUnset(v), v);
    assert(isFieldValid("price_anchor", v), v);
    assert(isFieldValid("upgrade_trigger", v), v);
  }
  assert(!isMonetizationOwnerInputUnset("$29/month"));
  assert(!isMonetizationOwnerInputUnset("Upgrade after second project"));
});

Deno.test("parity — blank accepted only on optional fields", () => {
  assert(isFieldValid("price_anchor", ""));
  assert(isFieldValid("upgrade_trigger", ""));
  assert(!isFieldValid("buyer", ""));
  assert(!isFieldValid("positioning", ""));
});

Deno.test("parity — filler still rejected on optional fields (blank OK; junk not OK)", () => {
  const issues = validateImportStrategy({ ...sixRequiredOnly, price_anchor: "xxxx" });
  const map = Object.fromEntries(issues.map((i) => [i.field, i.reason]));
  assertEquals(map.price_anchor, "filler");
});

Deno.test("parity — single-character filler rejected on non-price fields", () => {
  assert(!isFieldValid("buyer", "x"));
  assert(!isFieldValid("buyer", "xxxx"));
  assert(isFieldValid("buyer", "Independent advisers"));
});

Deno.test("parity — price_anchor accepts short but meaningful values", () => {
  assert(isFieldValid("price_anchor", "$0"));
  assert(isFieldValid("price_anchor", "£9"));
  assert(isFieldValid("price_anchor", "free"));
  assert(!isFieldValid("price_anchor", "$"));
  assert(!isFieldValid("price_anchor", "--"));
});

Deno.test("parity — rejects repeated-single-character and common placeholder filler", () => {
  for (const v of ["xxxx", "1111", "----"]) {
    assert(!isFieldValid("buyer", v));
    assert(!isFieldValid("price_anchor", v));
  }
  for (const v of ["asdf", "test", "todo", "TBD", "n/a", "none", "unknown", "lorem", "foo", "xxx"]) {
    assert(!isFieldValid("buyer", v));
  }
});

Deno.test("parity — accepts legitimate concise values (SEO, SMBs)", () => {
  assert(isFieldValid("acquisition_channel", "SEO"));
  assert(isFieldValid("buyer", "SMBs"));
});

Deno.test("parity — validateImportStrategy reports missing/too-short/bad-placeholder/filler", () => {
  const issues = validateImportStrategy({
    ...full,
    buyer: "",
    wow_moment: "x",
    positioning: RECOMMEND_PLACEHOLDER,
    acquisition_channel: "xxxx",
  });
  const map = Object.fromEntries(issues.map((i) => [i.field, i.reason]));
  assertEquals(map.buyer, "missing");
  assert(/too-short/.test(map.wow_moment));
  assertEquals(map.positioning, "placeholder-not-allowed");
  assertEquals(map.acquisition_channel, "filler");
});

Deno.test("parity — full valid input has zero issues", () => {
  assertEquals(validateImportStrategy(full).length, 0);
});

Deno.test("parity — REGRESSION: blank price_anchor/upgrade_trigger never generate issues", () => {
  const issues = validateImportStrategy({ ...sixRequiredOnly, price_anchor: "", upgrade_trigger: "" });
  const map = Object.fromEntries(issues.map((i) => [i.field, i.reason]));
  assertEquals(map.price_anchor, undefined);
  assertEquals(map.upgrade_trigger, undefined);
});
