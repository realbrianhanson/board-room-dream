export type JourneyFlags = {
  is_import?: boolean;
  status: string;
  github_repo?: string | null;
  has_locked_plan?: boolean;
  has_design?: boolean;
  has_batches?: boolean;
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
    done.audit = !!f.has_final_audit;
    done.plan = !!f.has_locked_plan;
    done.design = !!f.has_design;
    done.build = !!f.has_batches && !!f.all_passed;
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
