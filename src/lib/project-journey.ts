export type JourneyFlags = {
  is_import?: boolean;
  status: string;
  github_repo?: string | null;
  has_locked_plan?: boolean;
  has_design?: boolean;
  has_batches?: boolean;
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
    keys = [
      { key: "setup", label: "Link repo" },
      { key: "audit", label: "Audit" },
      { key: "plan", label: "Plan" },
      { key: "design", label: "Design" },
      { key: "build", label: "Build" },
      { key: "ship", label: "Ship" },
    ];
    done.setup = !!f.github_repo;
    // Pre-plan audit stage uses the DISTINCT pre-plan signal only.
    // Never fall back to has_final_audit here — a post-build final audit
    // must not retroactively "complete" the pre-plan Audit stage.
    done.audit = !!f.has_import_audit;
    done.plan = !!f.has_locked_plan;
    done.design = !!f.has_design;
    done.build = !!f.has_batches && !!f.all_passed;
    // Ship keeps its final-verification semantics — status == 'done' is the
    // owner-visible published state.
    done.ship = f.status === "done";
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
