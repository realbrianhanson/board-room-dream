/**
 * Pure gate helper for "may the owner generate the build sequence?".
 *
 * The Runway page enforces that a build-safe design brief must exist before
 * the Chair sequences batches. This helper mirrors the disabled-state logic
 * so we can prove in tests that generate can never be invoked without
 * hasDesign, and there is no bypass button.
 */
export type DesignGateInput = {
  hasPlan: boolean;
  hasDesign: boolean;
  totalBatches: number;
  runInFlight: boolean;
  generating: boolean;
};

export function canGenerateBuildSequence(input: DesignGateInput): boolean {
  if (!input.hasPlan) return false;
  if (input.totalBatches > 0) return false;
  if (input.runInFlight) return false;
  if (input.generating) return false;
  return input.hasDesign === true;
}

export const DESIGN_GATE_MESSAGE =
  "Finish the Design Council first — no build-safe design brief yet.";
