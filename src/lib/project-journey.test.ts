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

  it("imported after ship: final prompts stage done, Audit still gated by pre-plan signal", () => {
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
    // Legacy imports (no persisted goals) now render the full modular
    // journey — the terminal stage is truthfully labeled Prompts, not Ship.
    expect(stages.find((s) => s.key === "prompts")!.state).toBe("done");
    expect(stages.find((s) => s.key === "audit")!.state).toBe("done");
  });

});

describe("buildJourney — modular imported workflow by goals", () => {
  const bare = { is_import: true, status: "imported", github_repo: "u/r" as string | null };

  it("audit-only: [setup, report]; no Plan/Design/Prompts", () => {
    const s = buildJourney({ ...bare, goals: ["code_audit"] });
    expect(s.map((x) => x.key)).toEqual(["setup", "report"]);
    expect(s.find((x) => x.key === "report")!.state).toBe("current");
  });

  it("audit-only: report done after pre-plan audit", () => {
    const s = buildJourney({ ...bare, goals: ["code_audit"], has_import_audit: true });
    expect(s.find((x) => x.key === "report")!.state).toBe("done");
  });

  it("design-only: [setup, design, prompts] — skips audit + plan", () => {
    const s = buildJourney({ ...bare, goals: ["design_review"] });
    expect(s.map((x) => x.key)).toEqual(["setup", "design", "prompts"]);
    expect(s.find((x) => x.key === "design")!.state).toBe("current");
  });

  it("improvements-only: [setup, plan, prompts] — skips audit + design", () => {
    const s = buildJourney({ ...bare, goals: ["improvements"] });
    expect(s.map((x) => x.key)).toEqual(["setup", "plan", "prompts"]);
  });

  it("two-goal custom (audit + design): [setup, audit, design, prompts]", () => {
    const s = buildJourney({ ...bare, goals: ["code_audit", "design_review"] });
    expect(s.map((x) => x.key)).toEqual(["setup", "audit", "design", "prompts"]);
  });

  it("full: [setup, audit, plan, design, prompts]; prompts labeled truthfully (not Build/Ship)", () => {
    const s = buildJourney({
      ...bare,
      goals: ["code_audit", "design_review", "improvements"],
    });
    expect(s.map((x) => x.key)).toEqual(["setup", "audit", "plan", "design", "prompts"]);
    expect(s.map((x) => x.label)).not.toContain("Build");
    expect(s.map((x) => x.label)).not.toContain("Ship");
  });

  it("legacy imported (missing goals) falls back to full modular journey", () => {
    const s = buildJourney({ ...bare });
    expect(s.map((x) => x.key)).toEqual(["setup", "audit", "plan", "design", "prompts"]);
  });

  it("prompts stage completes when batches exist", () => {
    const s = buildJourney({
      ...bare,
      goals: ["improvements"],
      has_locked_plan: true,
      has_batches: true,
    });
    expect(s.find((x) => x.key === "prompts")!.state).toBe("done");
  });
});

