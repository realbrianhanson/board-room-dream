import {
  deriveImportWorkflow,
  type ImportGoal,
} from "@/lib/import-workflow";

export type JourneyFlags = {
  is_import?: boolean;
  status: string;
  github_repo?: string | null;
  has_locked_plan?: boolean;
  has_design?: boolean;
  has_batches?: boolean;
  /**
   * Persisted import goals from `intakes.answers.goals`. When undefined
   * (legacy imports saved before the field existed) the workflow helper
   * falls back to the full set — see `deriveImportWorkflow`.
   */
  goals?: readonly ImportGoal[] | string[] | null;
  /**
   * A successful pre-plan A–Z audit exists (only meaningful for imports).
   * Distinct from `has_final_audit`: this specifically captures the initial
   * audit that reads the imported repo BEFORE a plan is locked. It is the
   * single truthful signal for checking off the pre-plan Audit stage on
   * the imported journey and must NOT be confused with the post-build
   * final verification audit.
   */
  has_import_audit?: boolean;
  /**
   * A successful final_az audit ran after the plan was locked (or the
   * project reached a post-build lifecycle state). This is the ship /
   * verification signal — never the pre-plan gate.
   */
  has_final_audit?: boolean;
  all_passed?: boolean;
};

export type JourneyStage = {
  key: string;
  label: string;
  state: "done" | "current" | "upcoming";
};

export function buildJourney(f: JourneyFlags): JourneyStage[] {
  const done: Record<string, boolean> = {};
  let keys: { key: string; label: string }[];
  if (f.is_import) {
    const workflow = deriveImportWorkflow(f.goals ?? undefined);
    // Audit-only: single terminal "Report" stage — no Plan/Design/Prompts,
    // and no Build/Ship. The report IS the deliverable.
    if (workflow.auditOnly) {
      keys = [
        { key: "setup", label: "Link repo" },
        { key: "report", label: "Report" },
      ];
      done.setup = !!f.github_repo;
      done.report = !!f.has_import_audit;
    } else {
      keys = [{ key: "setup", label: "Link repo" }];
      done.setup = !!f.github_repo;
      if (workflow.requiresAudit) {
        keys.push({ key: "audit", label: "Audit" });
        // Pre-plan audit stage uses the DISTINCT pre-plan signal only.
        // Never fall back to has_final_audit — a post-build final audit
        // must not retroactively "complete" the pre-plan Audit stage.
        done.audit = !!f.has_import_audit;
      }
      if (workflow.requiresPlan) {
        keys.push({ key: "plan", label: "Plan" });
        done.plan = !!f.has_locked_plan;
      }
      if (workflow.requiresDesign) {
        keys.push({ key: "design", label: "Design" });
        done.design = !!f.has_design;
      }
      if (workflow.generatesPrompts) {
        keys.push({ key: "prompts", label: "Prompts" });
        // Truthful label: the imported workflow ends when Lovable-ready
        // build prompts have been compiled. Batch presence is the signal;
        // Build/Ship semantics do not apply to a prompts-only deliverable.
        done.prompts = !!f.has_batches;
      }
    }
  } else {
    keys = [
      { key: "intake", label: "Intake" },
      { key: "plan", label: "Boardroom" },
      { key: "design", label: "Design" },
      { key: "build", label: "Build" },
      { key: "audit", label: "Audit" },
      { key: "ship", label: "Ship" },
    ];
    done.intake =
      !!f.has_locked_plan ||
      ["boardroom", "locked", "building", "auditing", "polishing", "done"].includes(f.status);
    done.plan = !!f.has_locked_plan;
    done.design = !!f.has_design;
    done.build = !!f.has_batches && !!f.all_passed;
    done.audit = f.status === "done";
    done.ship = f.status === "done";
  }
  const firstNotDone = keys.findIndex((k) => !done[k.key]);
  return keys.map((k, i) => ({
    key: k.key,
    label: k.label,
    state: done[k.key]
      ? "done"
      : i === firstNotDone
        ? "current"
        : "upcoming",
  }));
}
