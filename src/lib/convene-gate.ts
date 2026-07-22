/**
 * Deterministic gate for "may the owner convene the improvement board?".
 *
 * Mirrors the boardroom-orchestrator start_run contract for imports:
 * a successful final A–Z audit (status ∈ clean|findings) must exist first.
 * Failed/running audits do NOT satisfy the gate.
 *
 * Returned string is the exact message rendered in the UI and returned by
 * the backend, so tests can match either side.
 */
export const IMPORT_AUDIT_GATE_MESSAGE =
  "Complete a successful A–Z audit before convening the improvement board.";

export type ConveneGateInput = {
  isImport: boolean;
  gateLoading: boolean;
  hasSuccessfulFinalAudit: boolean;
};

export function importConveneGate(input: ConveneGateInput): string | null {
  if (!input.isImport) return null;
  if (input.gateLoading) return IMPORT_AUDIT_GATE_MESSAGE;
  if (!input.hasSuccessfulFinalAudit) return IMPORT_AUDIT_GATE_MESSAGE;
  return null;
}

/**
 * Does an audit row (final_az) count as a successful terminal outcome?
 * Import-audit eligibility contract: failed / running / cancelled / any
 * non-terminal do NOT unlock the improvement board. Only clean|findings do.
 */
export function isSuccessfulFinalAudit(audit: { status: string }): boolean {
  return audit.status === "clean" || audit.status === "findings";
}
