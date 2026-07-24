// Pure state helper for the Design Council project route's eligibility gate.
//
// Scope-aware: for imported projects, Design is only in scope when the
// owner selected `design_review`. A build-safe plan is only required when
// the owner also selected `improvements` (audit+design and design-only
// convene without a plan). A successful A–Z audit is only required when
// `code_audit` was selected.
//
// Greenfield projects preserve prior behavior: they require a build-safe
// plan before Design opens.

import {
  deriveImportWorkflow,
  nextImportRoute,
  type ImportNextRoute,
  type ImportWorkflow,
} from "@/lib/import-workflow";

export type DesignGateInputs = {
  loading: boolean;
  error: string | null;
  isImport: boolean;
  goals?: unknown;
  projectId: string;
  hasRepo: boolean;
  hasSuccessfulAudit: boolean;
  hasBuildSafePlan: boolean;
  hasBuildSafeDesign: boolean;
};

export type DesignGateState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      // Owner did not select `design_review`, so Design is out of scope
      // for this import. Route MUST NOT mount BoardroomSession.
      kind: "out-of-scope";
      workflow: ImportWorkflow;
      nextRoute: ImportNextRoute;
    }
  | {
      // Prerequisite for design is missing (repo, audit, or plan) — Design
      // can't open yet. Route renders a precise next-step card.
      kind: "needs-prereq";
      workflow: ImportWorkflow | null;
      missing: "repo" | "audit" | "plan";
      isImport: boolean;
    }
  | { kind: "ready"; workflow: ImportWorkflow | null };


export function computeDesignGate(inputs: DesignGateInputs): DesignGateState {
  if (inputs.loading) return { kind: "loading" };
  if (inputs.error) return { kind: "error", message: inputs.error };

  if (!inputs.isImport) {
    // Greenfield: unchanged — a build-safe plan is required before Design.
    if (!inputs.hasBuildSafePlan) {
      return { kind: "needs-prereq", workflow: null, missing: "plan", isImport: false };
    }
    return { kind: "ready", workflow: null };
  }

  const workflow = deriveImportWorkflow(inputs.goals);

  if (!workflow.requiresDesign) {
    const nextRoute = nextImportRoute(workflow, {
      projectId: inputs.projectId,
      hasRepo: inputs.hasRepo,
      auditComplete: inputs.hasSuccessfulAudit,
      planComplete: inputs.hasBuildSafePlan,
      designComplete: inputs.hasBuildSafeDesign,
    });
    return { kind: "out-of-scope", workflow, nextRoute };
  }

  if (workflow.requiresAudit && !inputs.hasSuccessfulAudit) {
    return { kind: "needs-prereq", workflow, missing: "audit", isImport: true };
  }

  if (workflow.requiresPlan && !inputs.hasBuildSafePlan) {
    return { kind: "needs-prereq", workflow, missing: "plan", isImport: true };
  }

  return { kind: "ready", workflow };
}
