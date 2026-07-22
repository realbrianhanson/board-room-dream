// Pure state helper for the Boardroom project route's convene gate.
//
// The route loads three Supabase queries (project, successful final audit,
// build-safe plan) in parallel. This helper collapses the loading / error /
// gate outcomes into a single discriminated union so the route can render
// the correct branch and stay easy to test.

export type BoardroomGateInputs = {
  loading: boolean;
  error: string | null;
  isImport: boolean;
  hasSuccessfulAudit: boolean;
};

export type BoardroomGateState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "needs-import-audit"; message: string }
  | { kind: "ready" };

// Exact backend message used by boardroom-orchestrator's start_run gate. Kept
// in sync so the client-side hint matches the server-side rejection.
export const IMPORT_AUDIT_GATE_MESSAGE =
  "Complete a successful A–Z audit before convening the improvement board.";

export function computeBoardroomGate(
  inputs: BoardroomGateInputs,
): BoardroomGateState {
  if (inputs.loading) return { kind: "loading" };
  if (inputs.error) return { kind: "error", message: inputs.error };
  if (inputs.isImport && !inputs.hasSuccessfulAudit) {
    return { kind: "needs-import-audit", message: IMPORT_AUDIT_GATE_MESSAGE };
  }
  return { kind: "ready" };
}
