import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isFieldValid,
  RECOMMEND_PLACEHOLDER,
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

Deno.test("parity — 8 canonical strategy fields", () => {
  assertEquals(STRATEGY_FIELDS.length, 8);
});

Deno.test("parity — single-character filler rejected on non-price fields", () => {
  assert(!isFieldValid("buyer", "x"));
  // "xxxx" is repeated-single-char filler; must be rejected now.
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

Deno.test("parity — recommend placeholder only valid on recommendable fields", () => {
  assert(isFieldValid("price_anchor", RECOMMEND_PLACEHOLDER));
  assert(isFieldValid("upgrade_trigger", RECOMMEND_PLACEHOLDER));
  assert(!isFieldValid("buyer", RECOMMEND_PLACEHOLDER));
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

