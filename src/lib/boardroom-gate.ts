// Pure state helper for the Boardroom project route's convene gate.
//
// Scope-aware: for imported projects, the Boardroom (plan) is only in
// scope when the owner selected the `improvements` goal at import time. A
// successful A–Z audit is only required when `code_audit` is ALSO selected
// (full or audit+improvements). Design-only / audit-only imports render an
// explicit out-of-scope state pointing at their real next stage — the
// convene button never appears for them.
//
// Greenfield projects always render "ready" — this helper never gates them.

import {
  deriveImportWorkflow,
  nextImportRoute,
  type ImportNextRoute,
  type ImportWorkflow,
} from "@/lib/import-workflow";

export type BoardroomGateInputs = {
  loading: boolean;
  error: string | null;
  isImport: boolean;
  /** Raw persisted goals from `intakes.answers.goals`. Normalised inside. */
  goals?: unknown;
  projectId: string;
  hasRepo: boolean;
  hasSuccessfulAudit: boolean;
  hasBuildSafePlan: boolean;
  hasBuildSafeDesign: boolean;
};

export type BoardroomGateState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      // Owner did not select `improvements`, so Boardroom (plan) is not in
      // scope for this import. UI must render an explanatory card and a
      // typed link to `nextRoute`, and MUST NOT mount BoardroomSession.
      kind: "out-of-scope";
      workflow: ImportWorkflow;
      nextRoute: ImportNextRoute;
    }
  | { kind: "needs-import-audit"; message: string }
  | { kind: "ready"; workflow: ImportWorkflow | null };

// Exact backend message used by boardroom-orchestrator's start_run gate. Kept
// in sync so the client-side hint matches the server-side rejection.
export const IMPORT_AUDIT_GATE_MESSAGE =
  "Complete a successful A–Z audit before convening the improvement board.";

export function computeBoardroomGate(
  inputs: BoardroomGateInputs,
): BoardroomGateState {
  if (inputs.loading) return { kind: "loading" };
  if (inputs.error) return { kind: "error", message: inputs.error };

  if (!inputs.isImport) {
    // Greenfield: helper never gates. Route-level status gate + convene
    // rubric handle intake/killed cases.
    return { kind: "ready", workflow: null };
  }

  const workflow = deriveImportWorkflow(inputs.goals);

  // Boardroom (plan) is only in scope when the owner selected improvements.
  if (!workflow.requiresPlan) {
    const nextRoute = nextImportRoute(workflow, {
      projectId: inputs.projectId,
      hasRepo: inputs.hasRepo,
      auditComplete: inputs.hasSuccessfulAudit,
      planComplete: inputs.hasBuildSafePlan,
      designComplete: inputs.hasBuildSafeDesign,
    });
    return { kind: "out-of-scope", workflow, nextRoute };
  }

  // Improvements is in scope. Audit is only required when `code_audit` is
  // ALSO selected — pure improvements-only imports convene immediately.
  if (workflow.requiresAudit && !inputs.hasSuccessfulAudit) {
    return { kind: "needs-import-audit", message: IMPORT_AUDIT_GATE_MESSAGE };
  }

  return { kind: "ready", workflow };
}
