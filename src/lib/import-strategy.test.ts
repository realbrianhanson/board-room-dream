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
});
