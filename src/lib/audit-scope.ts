// Pure helper for the Audit Center route.
//
// Scope-aware for imported projects: when `code_audit` is NOT selected, the
// page becomes Repo Setup only — no audit start/retry surface, no strategy
// gate, and a typed Continue CTA to the next selected stage. When
// `code_audit` IS selected, the full audit UI renders; the post-audit CTA
// depends on the other selected goals (audit-only stays put).
//
// The strategy-context gate is required only when `improvements` is
// selected — audit-only and audit+design imports don't need it and MUST
// NOT be blocked by it.
//
// Greenfield projects preserve prior behavior via `{ kind: "greenfield" }`.
//
// Keep dependency-free.

import {
  deriveImportWorkflow,
  type ImportWorkflow,
} from "@/lib/import-workflow";

export type AuditContinueTarget = "plan" | "design";

export type AuditContinueCta = {
  kind: AuditContinueTarget;
  to: "/boardroom/$projectId" | "/design/$projectId";
  label: string;
};

export type AuditScopeState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "greenfield" }
  | {
      // Import without `code_audit`: page is Repo Setup only. Show
      // GitHubRepoCard and a scope explanation. Continue routes to the
      // next selected stage (Boardroom or Design). Never render audit
      // start/retry controls in this mode.
      kind: "import-repo-setup-only";
      workflow: ImportWorkflow;
      continueCta: AuditContinueCta | null;
    }
  | {
      // Import with `code_audit`: full audit UI. Strategy gate applies
      // only when improvements is also selected. The post-audit CTA
      // depends on the workflow — audit-only stays in the Audit Center.
      kind: "import-with-audit";
      workflow: ImportWorkflow;
      requiresStrategy: boolean;
      postAuditCta: AuditContinueCta | null;
    };

export type AuditScopeInputs = {
  loading: boolean;
  error: string | null;
  isImport: boolean;
  /** Raw persisted goals from `intakes.answers.goals`. Normalised inside. */
  goals?: unknown;
  projectId: string;
};

function continueCtaFor(workflow: ImportWorkflow): AuditContinueCta | null {
  // Precedence when both plan + design are selected: Boardroom first —
  // improvement plan runs before the design pass in every combined scope.
  if (workflow.requiresPlan) {
    return { kind: "plan", to: "/boardroom/$projectId", label: "To the Boardroom" };
  }
  if (workflow.requiresDesign) {
    return { kind: "design", to: "/design/$projectId", label: "Open the Design Council" };
  }
  return null;
}

export function computeAuditScope(inputs: AuditScopeInputs): AuditScopeState {
  if (inputs.loading) return { kind: "loading" };
  if (inputs.error) return { kind: "error", message: inputs.error };

  if (!inputs.isImport) return { kind: "greenfield" };

  const workflow = deriveImportWorkflow(inputs.goals);

  if (!workflow.requiresAudit) {
    // Repo Setup only. No audit controls. Continue CTA depends on scope.
    return {
      kind: "import-repo-setup-only",
      workflow,
      continueCta: continueCtaFor(workflow),
    };
  }

  return {
    kind: "import-with-audit",
    workflow,
    requiresStrategy: workflow.requiresPlan,
    postAuditCta: continueCtaFor(workflow),
  };
}
