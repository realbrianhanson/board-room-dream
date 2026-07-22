/**
 * Pure selector for zero-batch failure reconciliation (see hygiene.ts).
 * Extracted so it can be tested without a live DB.
 *
 * Contract:
 *  - build-safe plan present → "locked"
 *  - no safe plan, project is an import → "imported"
 *  - no safe plan, greenfield → "validated"
 */
export type ZeroBatchInput = {
  hasSafePlan: boolean;
  isImport: boolean;
};

export function nextStatusAfterZeroBatchFailure(input: ZeroBatchInput): "locked" | "imported" | "validated" {
  if (input.hasSafePlan) return "locked";
  return input.isImport ? "imported" : "validated";
}
