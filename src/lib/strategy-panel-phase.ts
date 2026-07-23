/**
 * Pure phase selector for the Strategy Context panel.
 *
 * Discriminated states — the panel MUST render exactly one of these:
 *  - "loading"  → the intake fetch is still in flight
 *  - "error"    → the intake fetch failed (surface the message + Retry)
 *  - "missing"  → the fetch succeeded but there is no intake row yet
 *                 (owner should be nudged into intake; non-owner sees nothing)
 *  - "ready"    → we have an intake row and can render the form/summary
 *
 * A permanent skeleton on any of these outcomes is a bug — that's the
 * exact defect this helper is designed to prevent. Never return "loading"
 * once a fetch has settled, even if the row is null.
 */
export type StrategyPanelPhase = "loading" | "error" | "missing" | "ready";

export function strategyPanelPhase(input: {
  loading: boolean;
  error: string | null;
  intakeId: string | null;
}): StrategyPanelPhase {
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (!input.intakeId) return "missing";
  return "ready";
}
