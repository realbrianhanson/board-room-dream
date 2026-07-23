import { describe, expect, it } from "vitest";
import {
  isImportCoreReady,
  isImportReady,
  isImportStrategyReady,
  missingImportFields,
  missingStrategyFields,
  normalizeStrategyForPersist,
  strategyCompleteness,
  isMonetizationOwnerInputUnset,
  isRecommendPlaceholder,
  RECOMMEND_PLACEHOLDER,
  REQUIRED_STRATEGY_FIELDS,
  OPTIONAL_MONETIZATION_FIELDS,
  STRATEGY_FIELDS,
  isOptionalMonetizationField,
  type ImportStrategyInput,
} from "./import-strategy";

const full: ImportStrategyInput = {
  buyer: "Independent advisers",
  acquisition_channel: "LinkedIn DMs I already run",
  paid_offer: "Weekly briefing",
  price_anchor: "$29/mo",
  upgrade_trigger: "Monthly regulator update",
  activation_moment: "See the first flagged risk in 90s",
  wow_moment: "One-page risk summary",
  positioning: "Unlike PDFs, flags client-specific risk",
};

// Six required + two optional monetization fields — never claim "all eight
// required" anywhere in the UI or the readiness gates.
const sixRequiredOnly: ImportStrategyInput = {
  ...full,
  price_anchor: "",
  upgrade_trigger: "",
};

describe("field partition — 6 required + 2 optional", () => {
  it("exposes the exact partition", () => {
    expect(REQUIRED_STRATEGY_FIELDS.length).toBe(6);
    expect(OPTIONAL_MONETIZATION_FIELDS).toEqual(["price_anchor", "upgrade_trigger"]);
    expect([...REQUIRED_STRATEGY_FIELDS, ...OPTIONAL_MONETIZATION_FIELDS].sort()).toEqual(
      [...STRATEGY_FIELDS].sort(),
    );
    for (const f of OPTIONAL_MONETIZATION_FIELDS) expect(isOptionalMonetizationField(f)).toBe(true);
    for (const f of REQUIRED_STRATEGY_FIELDS) expect(isOptionalMonetizationField(f)).toBe(false);
  });
});

describe("core-identity readiness", () => {
  it("accepts name + description + at least one goal", () => {
    expect(isImportCoreReady({ name: "App", description: "Does X.", goals: ["code_audit"] })).toBe(true);
  });
  it("rejects when any is missing", () => {
    expect(isImportCoreReady({ name: "", description: "x", goals: ["code_audit"] })).toBe(false);
    expect(isImportCoreReady({ name: "App", description: "  ", goals: ["code_audit"] })).toBe(false);
    expect(isImportCoreReady({ name: "App", description: "x", goals: [] })).toBe(false);
  });
});

describe("isImportReady (six required only)", () => {
  it("REGRESSION — six valid required fields + BOTH monetization blank => ready", () => {
    expect(isImportReady({
      name: "App", description: "x", goals: ["code_audit"], strategy: sixRequiredOnly,
    })).toBe(true);
  });

  it("REGRESSION — blocks when any of the six required fields is blank/invalid", () => {
    for (const f of REQUIRED_STRATEGY_FIELDS) {
      expect(isImportReady({
        name: "App", description: "x", goals: ["code_audit"],
        strategy: { ...sixRequiredOnly, [f]: "" },
      })).toBe(false);
      expect(isImportReady({
        name: "App", description: "x", goals: ["code_audit"],
        strategy: { ...sixRequiredOnly, [f]: "x" },
      })).toBe(false);
      expect(isImportReady({
        name: "App", description: "x", goals: ["code_audit"],
        strategy: { ...sixRequiredOnly, [f]: "xxxx" },
      })).toBe(false);
    }
  });

  it("accepts the RECOMMEND placeholder for price_anchor and upgrade_trigger", () => {
    expect(isImportReady({
      name: "App", description: "x", goals: ["code_audit"],
      strategy: { ...sixRequiredOnly, price_anchor: RECOMMEND_PLACEHOLDER, upgrade_trigger: RECOMMEND_PLACEHOLDER },
    })).toBe(true);
  });

  it("accepts every combination of blank / placeholder / real value on the two optional fields", () => {
    const opts = ["", RECOMMEND_PLACEHOLDER, "$29/mo"];
    for (const p of opts) for (const u of opts) {
      expect(isImportReady({
        name: "App", description: "x", goals: ["code_audit"],
        strategy: { ...sixRequiredOnly, price_anchor: p, upgrade_trigger: u === "$29/mo" ? "Second client added" : u },
      })).toBe(true);
    }
  });

  it("missingImportFields lists only the six required, never price/upgrade", () => {
    expect(missingImportFields(sixRequiredOnly)).toEqual([]);
    expect(missingImportFields(full)).toEqual([]);
    expect(missingImportFields({ ...full, buyer: "", wow_moment: " " }).sort()).toEqual(
      ["buyer", "wow_moment"].sort(),
    );
    // Blank optional monetization fields never appear as missing.
    expect(missingImportFields({ ...full, price_anchor: "", upgrade_trigger: "" })).toEqual([]);
  });
});

describe("strategy completeness helper", () => {
  it("returns 6/6 required + 2/2 optional when everything is filled", () => {
    expect(strategyCompleteness(full)).toEqual({
      required: { filled: 6, total: 6 },
      optional: { filled: 2, total: 2 },
    });
  });
  it("returns 6/6 required + 0/2 optional when monetization is deferred (blank)", () => {
    expect(strategyCompleteness(sixRequiredOnly)).toEqual({
      required: { filled: 6, total: 6 },
      optional: { filled: 0, total: 2 },
    });
  });
  it("recommend placeholder counts as an optional 'filled' owner decision", () => {
    expect(strategyCompleteness({
      ...sixRequiredOnly,
      price_anchor: RECOMMEND_PLACEHOLDER,
      upgrade_trigger: RECOMMEND_PLACEHOLDER,
    })).toEqual({
      required: { filled: 6, total: 6 },
      optional: { filled: 2, total: 2 },
    });
  });
  it("returns 0/6 when required fields are empty", () => {
    expect(strategyCompleteness({})).toEqual({
      required: { filled: 0, total: 6 },
      optional: { filled: 0, total: 2 },
    });
  });
  it("missingStrategyFields still enumerates every blank field for the UI", () => {
    expect(missingStrategyFields({})).toEqual([...STRATEGY_FIELDS]);
  });
});

describe("recommend placeholder helper", () => {
  it("detects the canonical placeholder case-insensitively", () => {
    expect(isRecommendPlaceholder(RECOMMEND_PLACEHOLDER)).toBe(true);
    expect(isRecommendPlaceholder(RECOMMEND_PLACEHOLDER.toUpperCase())).toBe(true);
    expect(isRecommendPlaceholder("  " + RECOMMEND_PLACEHOLDER + "  ")).toBe(true);
    expect(isRecommendPlaceholder("$29/mo")).toBe(false);
    expect(isRecommendPlaceholder("")).toBe(false);
  });
});

describe("monetization owner-input unset helper", () => {
  it("recognizes canonical and legacy owner-decision phrases without treating real values as unset", () => {
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
      expect(isMonetizationOwnerInputUnset(v)).toBe(true);
      expect(isFieldValid("price_anchor", v)).toBe(true);
      expect(isFieldValid("upgrade_trigger", v)).toBe(true);
    }
    expect(isMonetizationOwnerInputUnset("$29/month")).toBe(false);
    expect(isMonetizationOwnerInputUnset("Upgrade after second project")).toBe(false);
  });
});

describe("persist normalization", () => {
  it("trims values and preserves blanks as empty strings", () => {
    const out = normalizeStrategyForPersist({ ...full, buyer: "  ", positioning: "  X  " });
    expect(out.buyer).toBe("");
    expect(out.positioning).toBe("X");
  });
  it("always returns all 8 keys", () => {
    const out = normalizeStrategyForPersist({});
    for (const k of STRATEGY_FIELDS) expect(out[k]).toBe("");
  });
  it("REGRESSION — blank price_anchor / upgrade_trigger stay blank through normalization", () => {
    const out = normalizeStrategyForPersist({ price_anchor: "", upgrade_trigger: "   " });
    expect(out.price_anchor).toBe("");
    expect(out.upgrade_trigger).toBe("");
    // Never coerced to the recommend placeholder or an invented value.
    expect(out.price_anchor).not.toContain("recommend");
    expect(out.upgrade_trigger).not.toContain("recommend");
  });
});

describe("legacy isImportStrategyReady (aligned with 6-required rule)", () => {
  it("true when everything filled with real values", () => {
    expect(isImportStrategyReady(full)).toBe(true);
  });
  it("REGRESSION — true when the six required are filled and price/upgrade are blank", () => {
    expect(isImportStrategyReady(sixRequiredOnly)).toBe(true);
  });
  it("false when a required field is blank", () => {
    expect(isImportStrategyReady({ ...full, positioning: "" })).toBe(false);
  });
  it("false for obvious filler on any field", () => {
    expect(isImportStrategyReady({ ...full, buyer: "xxxx" })).toBe(false);
    expect(isImportStrategyReady({ ...full, positioning: "test" })).toBe(false);
  });
  it("false when recommend placeholder appears on a required field", () => {
    expect(isImportStrategyReady({ ...full, buyer: RECOMMEND_PLACEHOLDER })).toBe(false);
  });
});

import { isFieldValid, validateImportStrategy } from "./import-strategy";

describe("field-level validation", () => {
  it("rejects single-character filler on non-price fields", () => {
    expect(isFieldValid("buyer", "x")).toBe(false);
    expect(isFieldValid("buyer", "xxxx")).toBe(false);
    expect(isFieldValid("buyer", "Independent advisers")).toBe(true);
  });
  it("accepts blank on optional monetization fields (owner deferring)", () => {
    expect(isFieldValid("price_anchor", "")).toBe(true);
    expect(isFieldValid("upgrade_trigger", "")).toBe(true);
    // ...and rejects blank on required fields.
    expect(isFieldValid("buyer", "")).toBe(false);
    expect(isFieldValid("positioning", "")).toBe(false);
  });
  it("accepts short but meaningful price anchor values", () => {
    expect(isFieldValid("price_anchor", "$0")).toBe(true);
    expect(isFieldValid("price_anchor", "£9")).toBe(true);
    expect(isFieldValid("price_anchor", "free")).toBe(true);
    expect(isFieldValid("price_anchor", "$")).toBe(false);
    expect(isFieldValid("price_anchor", "--")).toBe(false);
  });
  it("accepts placeholder only on recommendable fields", () => {
    expect(isFieldValid("price_anchor", RECOMMEND_PLACEHOLDER)).toBe(true);
    expect(isFieldValid("upgrade_trigger", RECOMMEND_PLACEHOLDER)).toBe(true);
    expect(isFieldValid("buyer", RECOMMEND_PLACEHOLDER)).toBe(false);
  });
  it("rejects repeated-single-character filler on every field", () => {
    for (const v of ["xxxx", "1111", "----", "aaaaaaa"]) {
      expect(isFieldValid("buyer", v)).toBe(false);
      expect(isFieldValid("wow_moment", v)).toBe(false);
      expect(isFieldValid("price_anchor", v)).toBe(false);
    }
  });
  it("rejects punctuation-only values", () => {
    expect(isFieldValid("buyer", "!!!")).toBe(false);
    expect(isFieldValid("positioning", "…")).toBe(false);
  });
  it("rejects common placeholder tokens case-insensitively", () => {
    for (const v of ["asdf", "ASDF", "test", "Testing", "todo", "TBD", "n/a", "N/A", "none", "unknown", "lorem", "Lorem Ipsum", "placeholder", "foo", "bar", "xxx"]) {
      expect(isFieldValid("buyer", v)).toBe(false);
    }
  });
  it("accepts legitimate concise values", () => {
    expect(isFieldValid("buyer", "SMBs")).toBe(true);
    expect(isFieldValid("acquisition_channel", "SEO")).toBe(true);
    expect(isFieldValid("wow_moment", "One-tap export")).toBe(true);
  });
  it("validateImportStrategy — no issues for six-required-only fixture", () => {
    expect(validateImportStrategy(sixRequiredOnly)).toEqual([]);
    expect(validateImportStrategy({
      ...sixRequiredOnly, price_anchor: RECOMMEND_PLACEHOLDER, upgrade_trigger: RECOMMEND_PLACEHOLDER,
    })).toEqual([]);
  });
  it("validateImportStrategy reports missing / too-short / bad-placeholder / filler", () => {
    const issues = validateImportStrategy({
      ...full,
      buyer: "",
      wow_moment: "x",
      positioning: RECOMMEND_PLACEHOLDER,
      acquisition_channel: "xxxx",
      paid_offer: "asdf",
    });
    const map = Object.fromEntries(issues.map((i) => [i.field, i.reason]));
    expect(map.buyer).toBe("missing");
    expect(map.wow_moment).toMatch(/too-short/);
    expect(map.positioning).toBe("placeholder-not-allowed");
    expect(map.acquisition_channel).toBe("filler");
    expect(map.paid_offer).toBe("filler");
  });
  it("REGRESSION — validateImportStrategy never reports issues for blank optional monetization fields", () => {
    const issues = validateImportStrategy({ ...sixRequiredOnly, price_anchor: "", upgrade_trigger: "" });
    const map = Object.fromEntries(issues.map((i) => [i.field, i.reason]));
    expect(map.price_anchor).toBeUndefined();
    expect(map.upgrade_trigger).toBeUndefined();
  });
  it("still flags filler on optional monetization fields (blank OK; junk not OK)", () => {
    const issues = validateImportStrategy({ ...sixRequiredOnly, price_anchor: "xxxx" });
    const map = Object.fromEntries(issues.map((i) => [i.field, i.reason]));
    expect(map.price_anchor).toBe("filler");
  });
  it("isImportReady uses field validator (rejects 'x' and 'xxxx')", () => {
    expect(isImportReady({
      name: "App", description: "x", goals: ["code_audit"],
      strategy: { ...full, buyer: "x" },
    })).toBe(false);
    expect(isImportReady({
      name: "App", description: "x", goals: ["code_audit"],
      strategy: { ...full, buyer: "xxxx" },
    })).toBe(false);
  });
});
