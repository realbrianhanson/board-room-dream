/**
 * Server mirror of src/lib/import-workflow.ts. Rules and legacy fallback
 * MUST stay identical — server authorization never trusts a client-
 * supplied scope; it always re-derives from persisted intakes.answers.goals.
 */

export const IMPORT_GOALS = ["code_audit", "design_review", "improvements"] as const;
export type ImportGoal = (typeof IMPORT_GOALS)[number];

export type ImportWorkflow = {
  goals: readonly ImportGoal[];
  requiresAudit: boolean;
  requiresPlan: boolean;
  requiresDesign: boolean;
  generatesPrompts: boolean;
  auditOnly: boolean;
  scopeLabel: string;
};

export type ImportStageFlags = {
  projectId: string;
  hasRepo: boolean;
  auditComplete: boolean;
  planComplete: boolean;
  designComplete: boolean;
};

export type ImportNextRoute =
  | { kind: "repo_setup"; path: string }
  | { kind: "audit"; path: string }
  | { kind: "plan"; path: string }
  | { kind: "design"; path: string }
  | { kind: "runway"; path: string }
  | { kind: "done"; path: string };

const GOAL_SET = new Set<string>(IMPORT_GOALS);

export function normalizeImportGoals(input: unknown): readonly ImportGoal[] {
  const raw = Array.isArray(input) ? input : [];
  const kept = new Set<ImportGoal>();
  for (const v of raw) {
    if (typeof v === "string" && GOAL_SET.has(v)) {
      kept.add(v as ImportGoal);
    }
  }
  if (kept.size === 0) return [...IMPORT_GOALS];
  return IMPORT_GOALS.filter((g) => kept.has(g));
}

function scopeLabelFor(goals: readonly ImportGoal[]): string {
  const parts: string[] = [];
  if (goals.includes("code_audit")) parts.push("Code audit");
  if (goals.includes("design_review")) parts.push("Design review");
  if (goals.includes("improvements")) parts.push("Improvements");
  if (parts.length === 0) return "No scope selected";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} + ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} + ${parts[2]}`;
}

export function deriveImportWorkflow(input: unknown): ImportWorkflow {
  const goals = normalizeImportGoals(input);
  const requiresAudit = goals.includes("code_audit");
  const requiresDesign = goals.includes("design_review");
  const requiresPlan = goals.includes("improvements");
  const generatesPrompts = requiresPlan || requiresDesign;
  const auditOnly = requiresAudit && !requiresDesign && !requiresPlan;
  return {
    goals,
    requiresAudit,
    requiresPlan,
    requiresDesign,
    generatesPrompts,
    auditOnly,
    scopeLabel: scopeLabelFor(goals),
  };
}

export function nextImportRoute(
  workflow: ImportWorkflow,
  stage: ImportStageFlags,
): ImportNextRoute {
  const needsRepo =
    workflow.requiresAudit || workflow.requiresPlan || workflow.requiresDesign;
  if (needsRepo && !stage.hasRepo) {
    return { kind: "repo_setup", path: `/runway/${stage.projectId}` };
  }
  if (workflow.requiresAudit && !stage.auditComplete) {
    return { kind: "audit", path: `/audits/${stage.projectId}` };
  }
  if (workflow.auditOnly) {
    return { kind: "done", path: `/audits/${stage.projectId}` };
  }
  if (workflow.requiresPlan && !stage.planComplete) {
    return { kind: "plan", path: `/boardroom/${stage.projectId}` };
  }
  if (workflow.requiresDesign && !stage.designComplete) {
    return { kind: "design", path: `/design/${stage.projectId}` };
  }
  if (workflow.generatesPrompts) {
    return { kind: "runway", path: `/runway/${stage.projectId}` };
  }
  return { kind: "done", path: `/audits/${stage.projectId}` };
}
