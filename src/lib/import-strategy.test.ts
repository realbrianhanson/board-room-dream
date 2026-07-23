import { describe, expect, it } from "vitest";
import {
  isImportReady,
  isImportStrategyReady,
  missingStrategyFields,
  normalizeStrategyForPersist,
  strategyCompleteness,
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

describe("import readiness (core identity only)", () => {
  it("accepts when name + description + at least one goal are present", () => {
    expect(isImportReady({ name: "App", description: "Does X.", goals: ["code_audit"] })).toBe(true);
  });

  it("rejects when name or description or goals are missing", () => {
    expect(isImportReady({ name: "", description: "x", goals: ["code_audit"] })).toBe(false);
    expect(isImportReady({ name: "App", description: "  ", goals: ["code_audit"] })).toBe(false);
    expect(isImportReady({ name: "App", description: "x", goals: [] })).toBe(false);
  });

  it("does NOT require strategy fields", () => {
    // Even with every strategy field blank, core identity alone is enough.
    expect(isImportReady({ name: "App", description: "x", goals: ["code_audit"] })).toBe(true);
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

  it("reports the specific missing field names", () => {
    const partial = { ...full, acquisition_channel: "", wow_moment: "  " };
    expect(missingStrategyFields(partial).sort()).toEqual(["acquisition_channel", "wow_moment"].sort());
    expect(strategyCompleteness(partial)).toEqual({ filled: 6, total: 8 });
  });
});

describe("strategy persist normalization", () => {
  it("trims values and preserves blanks as empty strings (never fabricates)", () => {
    const out = normalizeStrategyForPersist({ ...full, buyer: "  ", positioning: "  X  " });
    expect(out.buyer).toBe("");
    expect(out.positioning).toBe("X");
  });

  it("always returns all 8 keys so downstream code can treat missing as explicit blanks", () => {
    const out = normalizeStrategyForPersist({});
    for (const k of STRATEGY_FIELDS) expect(out[k]).toBe("");
  });
});

describe("legacy isImportStrategyReady (full strategy)", () => {
  it("still true when everything filled", () => {
    expect(isImportStrategyReady(full)).toBe(true);
  });
  it("false when anything blank — kept for callers that need the 'complete' signal", () => {
    expect(isImportStrategyReady({ ...full, positioning: "" })).toBe(false);
  });
});
