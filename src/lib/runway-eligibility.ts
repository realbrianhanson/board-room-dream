// Pure eligibility helper for the Build Runway route.
//
// Replaces the ad-hoc `hasPlan`-based top-level render predicates so that
// design-only and improvements-only imports can reach the running / paused /
// failed batch-run states with ONLY the artifacts their scope actually
// requires. The rules:
//
//   greenfield: needs build-safe plan (design nudge preserved on the
//               ready-but-no-batches card, unchanged).
//   imported audit-only: terminal — no prompts stage at all.
//   imported without a linked repo (when any selected stage needs live code):
//                          needs-repo.
//   imported design_review: needs a build-safe design.
//   imported improvements:  needs a build-safe plan.
//   imported combined:      needs every selected artifact.
//   imported legacy (no goals): defaults to full workflow (plan + design).
//
// The generate button's disabled state and title copy come from the same
// helper so wording always names the missing selected prerequisite.

import {
  deriveImportWorkflow,
  type ImportWorkflow,
} from "@/lib/import-workflow";

export type RunwayMissingPrereq = "audit" | "plan" | "design";

export type RunwayScopeVariant =
  | "greenfield"
  | "design_only"
  | "improvements_only"
  | "combined"
  | "legacy_full";

export type RunwayEligibilityInputs = {
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

export type RunwayEligibility =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      // Imported audit-only: this scope ends with the audit report — the
      // Runway is terminal. Never show generate prompts.
      kind: "audit-only-terminal";
      workflow: ImportWorkflow;
    }
  | {
      // Any selected stage needs live code but the repo is not linked.
      kind: "needs-repo";
      workflow: ImportWorkflow | null;
      isImport: boolean;
    }
  | {
      // A selected artifact is missing. `missing[0]` is the ordered
      // first-missing prerequisite (audit → plan → design) and drives the
      // CTA + button title copy.
      kind: "needs-prereq";
      workflow: ImportWorkflow | null;
      isImport: boolean;
      missing: RunwayMissingPrereq[];
      firstMissing: RunwayMissingPrereq;
      ctaTo: "/audits/$projectId" | "/boardroom/$projectId" | "/design/$projectId";
      ctaLabel: string;
      missingLabel: string;
    }
  | {
      // All selected prerequisites are met. Runway may render batches,
      // in-flight runs, paused/failed states, or the "generate" empty card.
      kind: "ready";
      workflow: ImportWorkflow | null;
      scopeVariant: RunwayScopeVariant;
      /** Human copy for the promise the generated prompts will keep. */
      promptScopeCopy: string;
    };

const REPO_REQUIRED_MESSAGE =
  "Link your GitHub repo in the Audit Center — the Chair needs live code to compile the prompts.";

const NEEDS_LABEL: Record<RunwayMissingPrereq, string> = {
  audit: "a completed A–Z audit",
  plan: "a build-safe improvement plan",
  design: "a build-safe design brief",
};

const NEEDS_ROUTE: Record<
  RunwayMissingPrereq,
  { to: "/audits/$projectId" | "/boardroom/$projectId" | "/design/$projectId"; label: string }
> = {
  audit: { to: "/audits/$projectId", label: "Open the Audit Center" },
  plan: { to: "/boardroom/$projectId", label: "To the Boardroom" },
  design: { to: "/design/$projectId", label: "Open the Design Council" },
};

const SCOPE_COPY: Record<RunwayScopeVariant, string> = {
  greenfield:
    "Batch prompts compile against the locked plan and design.",
  design_only:
    "Design-only prompts install the new house style and preserve behavior, product logic, data model, auth, and integrations exactly as they are.",
  improvements_only:
    "Improvement prompts change what the app does and preserve your existing visual design.",
  combined:
    "Prompts cover the selected scope — both the improvement plan and the new design brief.",
  legacy_full:
    "Batch prompts compile against the locked plan and design brief.",
};

export function computeRunwayEligibility(
  inputs: RunwayEligibilityInputs,
): RunwayEligibility {
  if (inputs.loading) return { kind: "loading" };
  if (inputs.error) return { kind: "error", message: inputs.error };

  // ---- Greenfield: unchanged behavior — plan required to enter Runway. ----
  if (!inputs.isImport) {
    if (!inputs.hasBuildSafePlan) {
      const step = NEEDS_ROUTE.plan;
      return {
        kind: "needs-prereq",
        workflow: null,
        isImport: false,
        missing: ["plan"],
        firstMissing: "plan",
        ctaTo: step.to,
        ctaLabel: step.label,
        missingLabel: NEEDS_LABEL.plan,
      };
    }
    return {
      kind: "ready",
      workflow: null,
      scopeVariant: "greenfield",
      promptScopeCopy: SCOPE_COPY.greenfield,
    };
  }

  // ---- Imported: workflow-driven prerequisites. ----
  const workflow = deriveImportWorkflow(inputs.goals);

  if (workflow.auditOnly) {
    return { kind: "audit-only-terminal", workflow };
  }

  // A selected stage needing live code + no repo → repo setup blocks all.
  const needsLiveCode =
    workflow.requiresAudit || workflow.requiresPlan || workflow.requiresDesign;
  if (needsLiveCode && !inputs.hasRepo) {
    return { kind: "needs-repo", workflow, isImport: true };
  }

  // Ordered prerequisite check: audit → plan → design. Every selected
  // artifact must be locked before prompts can generate.
  const missing: RunwayMissingPrereq[] = [];
  if (workflow.requiresAudit && !inputs.hasSuccessfulAudit) missing.push("audit");
  if (workflow.requiresPlan && !inputs.hasBuildSafePlan) missing.push("plan");
  if (workflow.requiresDesign && !inputs.hasBuildSafeDesign) missing.push("design");

  if (missing.length > 0) {
    const first = missing[0];
    const route = NEEDS_ROUTE[first];
    return {
      kind: "needs-prereq",
      workflow,
      isImport: true,
      missing,
      firstMissing: first,
      ctaTo: route.to,
      ctaLabel: route.label,
      missingLabel: missing.map((m) => NEEDS_LABEL[m]).join(" · "),
    };
  }

  // Ready. Pick a scope variant so copy is precise.
  let variant: RunwayScopeVariant;
  if (
    (workflow.goals.length === 0) ||
    (workflow.requiresPlan &&
      workflow.requiresDesign &&
      workflow.requiresAudit &&
      workflow.goals.length === 3)
  ) {
    // Empty goals is legacy full; explicit full scope also treats as full copy.
    variant = "legacy_full";
  } else if (workflow.requiresPlan && workflow.requiresDesign) {
    variant = "combined";
  } else if (workflow.requiresDesign && !workflow.requiresPlan) {
    variant = "design_only";
  } else if (workflow.requiresPlan && !workflow.requiresDesign) {
    variant = "improvements_only";
  } else {
    variant = "combined";
  }

  return {
    kind: "ready",
    workflow,
    scopeVariant: variant,
    promptScopeCopy: SCOPE_COPY[variant],
  };
}

export const RUNWAY_REPO_REQUIRED_MESSAGE = REPO_REQUIRED_MESSAGE;
