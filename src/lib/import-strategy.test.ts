import { describe, expect, it } from "vitest";
import { isImportStrategyReady, type ImportStrategyInput } from "./import-strategy";

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

describe("import strategy gating", () => {
  it("accepts a full strategy", () => {
    expect(isImportStrategyReady(full)).toBe(true);
  });

  it("blocks submission when acquisition_channel is empty", () => {
    expect(isImportStrategyReady({ ...full, acquisition_channel: "" })).toBe(false);
    expect(isImportStrategyReady({ ...full, acquisition_channel: "  " })).toBe(false);
  });

  it("blocks submission when any other required strategy field is empty", () => {
    for (const k of Object.keys(full) as (keyof ImportStrategyInput)[]) {
      expect(isImportStrategyReady({ ...full, [k]: "" })).toBe(false);
    }
  });
});
