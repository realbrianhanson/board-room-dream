/**
 * Pure scope-gate helpers for imported projects. Both client route guards
 * and server start_run authorization derive answers from these functions
 * so gate behavior stays identical across the two boundaries.
 *
 * Server MUST re-derive from persisted intakes.answers.goals — never trust
 * scope in the request body. See supabase/functions/_shared/import-scope-gates.ts
 * for the Deno mirror.
 *
 * Keep dependency-free.
 */

import type { ImportWorkflow } from "./import-workflow";

export type StartRunKind = "plan" | "design" | "batches";

export type StartRunState = {
  auditComplete: boolean; // successful final_az audit present
  planLocked: boolean;
  designLocked: boolean;
  /**
   * A GitHub repo is linked to this project (`projects.github_repo` non-null).
   * Plan / design / batches all compile against live code, so this MUST be
   * checked before the artifact prerequisites.
   */
  hasRepo: boolean;
};

export type GateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      nextStep?: "repo_setup" | "audit" | "plan" | "design";
    };

const REPO_REQUIRED_REASON =
  "Link your GitHub repo in Audit Center before this stage runs. The board compiles against live code.";

/**
 * Deterministic authorization for boardroom start_run against the persisted
 * import workflow. Non-import projects should bypass these gates and use
 * the existing greenfield rules — the caller decides when to invoke this.
 */
export function evaluateStartRunGate(
  workflow: ImportWorkflow,
  kind: StartRunKind,
  state: StartRunState,
): GateDecision {
  if (kind === "plan") {
    if (!workflow.requiresPlan) {
      return {
        allowed: false,
        reason:
          "Improvements are not in the selected scope. Product improvement plans only run when the Product Improvements goal is selected.",
      };
    }
    if (!state.hasRepo) {
      return { allowed: false, reason: REPO_REQUIRED_REASON, nextStep: "repo_setup" };
    }
    if (workflow.requiresAudit && !state.auditComplete) {
      return {
        allowed: false,
        reason: "The selected Red-Team Audit must complete before the improvement plan runs.",
        nextStep: "audit",
      };
    }
    return { allowed: true };
  }

  if (kind === "design") {
    if (!workflow.requiresDesign) {
      return {
        allowed: false,
        reason:
          "Design Council is not in the selected scope. Enable Design Upgrade to run a design brief.",
      };
    }
    if (!state.hasRepo) {
      return { allowed: false, reason: REPO_REQUIRED_REASON, nextStep: "repo_setup" };
    }
    if (workflow.requiresAudit && !state.auditComplete) {
      return {
        allowed: false,
        reason: "The selected Red-Team Audit must complete before the design brief runs.",
        nextStep: "audit",
      };
    }
    if (workflow.requiresPlan && !state.planLocked) {
      return {
        allowed: false,
        reason:
          "The selected improvement plan must be locked before the design brief runs.",
        nextStep: "plan",
      };
    }
    return { allowed: true };
  }

  // batches
  if (!workflow.generatesPrompts) {
    return {
      allowed: false,
      reason:
        "The selected scope ends at the audit report. Add Design Review or Product Improvements to generate build prompts.",
    };
  }
  if (!state.hasRepo) {
    return { allowed: false, reason: REPO_REQUIRED_REASON, nextStep: "repo_setup" };
  }
  if (workflow.requiresAudit && !state.auditComplete) {
    return {
      allowed: false,
      reason: "The selected Red-Team Audit must complete before prompts are generated.",
      nextStep: "audit",
    };
  }
  if (workflow.requiresPlan && !state.planLocked) {
    return {
      allowed: false,
      reason: "The selected improvement plan must be locked before prompts are generated.",
      nextStep: "plan",
    };
  }
  if (workflow.requiresDesign && !state.designLocked) {
    return {
      allowed: false,
      reason: "The selected design brief must be locked before prompts are generated.",
      nextStep: "design",
    };
  }
  return { allowed: true };
}


/**
 * Human-readable scope contract inserted into LLM prompts. Prevents seats
 * from inventing findings/features outside the selected scope.
 */
export function scopeContractForPrompt(workflow: ImportWorkflow): string {
  const lines: string[] = ["SCOPE CONTRACT (selected by the owner):"];
  lines.push(`- Selected scope: ${workflow.scopeLabel}.`);
  if (!workflow.requiresPlan) {
    lines.push(
      "- Product Improvements is NOT selected. Do not propose monetization, feature, positioning, or product-scope changes. Preserve the existing product scope and data model.",
    );
  }
  if (!workflow.requiresDesign) {
    lines.push(
      "- Design Review is NOT selected. Do not propose visual restyling, typography or palette changes, or redesign. Preserve the existing visual system.",
    );
  }
  if (!workflow.requiresAudit) {
    lines.push(
      "- Code Audit is NOT selected. Do not manufacture audit findings; rely only on evidence supplied in this prompt.",
    );
  }
  if (workflow.auditOnly) {
    lines.push(
      "- Deliverable is the evidence-backed audit report only. Do not generate build prompts.",
    );
  }
  return lines.join("\n");
}
