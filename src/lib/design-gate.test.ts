import { describe, expect, it } from "vitest";
import { canGenerateBuildSequence, DESIGN_GATE_MESSAGE } from "./design-gate";

describe("canGenerateBuildSequence", () => {
  const base = { hasPlan: true, hasDesign: true, totalBatches: 0, runInFlight: false, generating: false };

  it("returns true only when plan+design exist and no batches/runs are in flight", () => {
    expect(canGenerateBuildSequence(base)).toBe(true);
  });

  it("blocks generation without a build-safe design brief (no bypass)", () => {
    expect(canGenerateBuildSequence({ ...base, hasDesign: false })).toBe(false);
  });

  it("blocks generation without a locked plan", () => {
    expect(canGenerateBuildSequence({ ...base, hasPlan: false })).toBe(false);
  });

  it("blocks generation when batches already exist", () => {
    expect(canGenerateBuildSequence({ ...base, totalBatches: 6 })).toBe(false);
  });

  it("blocks generation while a run is in flight or the button is already firing", () => {
    expect(canGenerateBuildSequence({ ...base, runInFlight: true })).toBe(false);
    expect(canGenerateBuildSequence({ ...base, generating: true })).toBe(false);
  });

  it("exposes a clear message for the disabled state", () => {
    expect(DESIGN_GATE_MESSAGE).toMatch(/Design Council/);
  });
});
