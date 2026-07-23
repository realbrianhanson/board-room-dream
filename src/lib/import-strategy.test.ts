import { describe, expect, it } from "vitest";
import {
  isImportCoreReady,
  isImportReady,
  isImportStrategyReady,
  missingImportFields,
  missingStrategyFields,
  normalizeStrategyForPersist,
  strategyCompleteness,
  isRecommendPlaceholder,
  RECOMMEND_PLACEHOLDER,
  STRATEGY_FIELDS,
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

describe("isImportReady (core + strategy context required)", () => {
  it("requires all 8 strategy fields alongside core identity", () => {
    expect(isImportReady({ name: "App", description: "x", goals: ["code_audit"] })).toBe(false);
    expect(
      isImportReady({ name: "App", description: "x", goals: ["code_audit"], strategy: full }),
    ).toBe(true);
  });

  it("accepts the RECOMMEND placeholder for price_anchor and upgrade_trigger", () => {
    const withPlaceholders: ImportStrategyInput = {
      ...full,
      price_anchor: RECOMMEND_PLACEHOLDER,
      upgrade_trigger: RECOMMEND_PLACEHOLDER,
    };
    expect(
      isImportReady({ name: "App", description: "x", goals: ["code_audit"], strategy: withPlaceholders }),
    ).toBe(true);
  });

  it("still rejects when a non-recommendable field is blank", () => {
    expect(
      isImportReady({
        name: "App",
        description: "x",
        goals: ["code_audit"],
        strategy: { ...full, positioning: "" },
      }),
    ).toBe(false);
  });

  it("missingImportFields lists the exact remaining fields", () => {
    expect(missingImportFields({ ...full, buyer: "", wow_moment: " " }).sort()).toEqual(
      ["buyer", "wow_moment"].sort(),
    );
    expect(missingImportFields(full)).toEqual([]);
  });
});

describe("strategy completeness helper", () => {
  it("counts all 8 fields when full", () => {
    expect(strategyCompleteness(full)).toEqual({ filled: 8, total: 8 });
    expect(missingStrategyFields(full)).toEqual([]);
  });
  it("returns every field name when empty", () => {
    expect(missingStrategyFields({})).toEqual([...STRATEGY_FIELDS]);
    expect(strategyCompleteness({})).toEqual({ filled: 0, total: 8 });
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
});

describe("legacy isImportStrategyReady (strict)", () => {
  it("true when everything filled with real values", () => {
    expect(isImportStrategyReady(full)).toBe(true);
  });
  it("false for placeholder values (strict gate does not accept 'recommend')", () => {
    expect(isImportStrategyReady({ ...full, price_anchor: RECOMMEND_PLACEHOLDER })).toBe(false);
  });
  it("false when anything blank", () => {
    expect(isImportStrategyReady({ ...full, positioning: "" })).toBe(false);
  });
  it("false for obvious filler that field-level validation rejects", () => {
    // Strict gate must agree with isFieldValid — no "xxxx" / "test" escape hatch.
    expect(isImportStrategyReady({ ...full, buyer: "xxxx" })).toBe(false);
    expect(isImportStrategyReady({ ...full, positioning: "test" })).toBe(false);
  });
});

import { isFieldValid, validateImportStrategy } from "./import-strategy";

describe("field-level validation", () => {
  it("rejects single-character filler on non-price fields", () => {
    expect(isFieldValid("buyer", "x")).toBe(false);
    // "xxxx" is repeated-single-char filler — rejected under the strengthened rules.
    expect(isFieldValid("buyer", "xxxx")).toBe(false);
    expect(isFieldValid("buyer", "Independent advisers")).toBe(true);
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
  it("strategyCompleteness only counts valid fields, not filler", () => {
    const badFew: Partial<typeof full> = { ...full, buyer: "xxxx", positioning: "asdf" };
    expect(strategyCompleteness(badFew)).toEqual({ filled: 6, total: 8 });
    expect(strategyCompleteness(full)).toEqual({ filled: 8, total: 8 });
  });
});

