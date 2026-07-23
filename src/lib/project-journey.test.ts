import { describe, it, expect } from "vitest";
import { buildJourney } from "./project-journey";

const base = {
  is_import: true,
  status: "imported",
  github_repo: "user/repo",
};

describe("buildJourney — imported projects distinguish pre-plan Audit from final ship audit", () => {
  it("imported repo linked but no pre-plan audit yet: Audit is current, not done", () => {
    const stages = buildJourney({ ...base });
    const setup = stages.find((s) => s.key === "setup")!;
    const audit = stages.find((s) => s.key === "audit")!;
    expect(setup.state).toBe("done");
    expect(audit.state).toBe("current");
  });

  it("imported after pre-plan audit ran: Audit is done, Plan is current", () => {
    const stages = buildJourney({ ...base, has_import_audit: true });
    expect(stages.find((s) => s.key === "audit")!.state).toBe("done");
    expect(stages.find((s) => s.key === "plan")!.state).toBe("current");
  });

  it("imported after plan locked: Audit stays done via pre-plan signal, not final", () => {
    const stages = buildJourney({
      ...base,
      status: "locked",
      has_import_audit: true,
      has_locked_plan: true,
    });
    expect(stages.find((s) => s.key === "audit")!.state).toBe("done");
    expect(stages.find((s) => s.key === "plan")!.state).toBe("done");
    expect(stages.find((s) => s.key === "design")!.state).toBe("current");
  });

  it("imported final ship audit alone must NOT check off the pre-plan Audit stage", () => {
    // A post-build final_az completed, but the pre-plan audit never ran.
    // Pre-plan Audit must remain the current uncompleted stage.
    const stages = buildJourney({
      ...base,
      status: "auditing",
      has_final_audit: true,
      has_import_audit: false,
    });
    expect(stages.find((s) => s.key === "audit")!.state).toBe("current");
  });

  it("imported after ship: Ship done, Audit still gated by pre-plan signal", () => {
    const stages = buildJourney({
      ...base,
      status: "done",
      has_import_audit: true,
      has_locked_plan: true,
      has_design: true,
      has_batches: true,
      all_passed: true,
      has_final_audit: true,
    });
    expect(stages.find((s) => s.key === "ship")!.state).toBe("done");
    expect(stages.find((s) => s.key === "audit")!.state).toBe("done");
  });
});
