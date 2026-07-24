import { describe, it, expect } from "vitest";
import { computeRunwayEligibility } from "./runway-eligibility";

const PID = "proj-1";

const base = {
  loading: false as const,
  error: null as string | null,
  isImport: true,
  projectId: PID,
  hasRepo: true,
  hasSuccessfulAudit: false,
  hasBuildSafePlan: false,
  hasBuildSafeDesign: false,
};

describe("computeRunwayEligibility — loading / error / greenfield", () => {
  it("loading short-circuits", () => {
    expect(computeRunwayEligibility({ ...base, loading: true })).toEqual({
      kind: "loading",
    });
  });
  it("error short-circuits", () => {
    expect(computeRunwayEligibility({ ...base, error: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("greenfield without plan → needs-prereq (plan)", () => {
    const s = computeRunwayEligibility({ ...base, isImport: false });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.missing).toEqual(["plan"]);
    expect(s.ctaTo).toBe("/boardroom/$projectId");
  });

  it("greenfield with plan → ready (variant greenfield)", () => {
    const s = computeRunwayEligibility({
      ...base,
      isImport: false,
      hasBuildSafePlan: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.scopeVariant).toBe("greenfield");
  });
});

describe("computeRunwayEligibility — imported terminal / missing repo", () => {
  it("audit-only: terminal — never ready", () => {
    const s = computeRunwayEligibility({ ...base, goals: ["code_audit"] });
    expect(s.kind).toBe("audit-only-terminal");
  });

  it("imported without repo → needs-repo (design-only)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["design_review"],
      hasRepo: false,
    });
    expect(s.kind).toBe("needs-repo");
  });

  it("imported without repo → needs-repo (improvements-only)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["improvements"],
      hasRepo: false,
    });
    expect(s.kind).toBe("needs-repo");
  });
});

describe("computeRunwayEligibility — modular imported prerequisites", () => {
  it("design-only + locked design + no plan → ready (design_only)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["design_review"],
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.scopeVariant).toBe("design_only");
      expect(s.promptScopeCopy).toContain("preserve behavior");
    }
  });

  it("design-only missing design → needs-prereq (design)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["design_review"],
    });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.firstMissing).toBe("design");
    expect(s.ctaTo).toBe("/design/$projectId");
  });

  it("improvements-only + locked plan + no design → ready (improvements_only)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["improvements"],
      hasBuildSafePlan: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.scopeVariant).toBe("improvements_only");
      expect(s.promptScopeCopy).toContain("preserve your existing visual design");
    }
  });

  it("improvements-only missing plan → needs-prereq (plan)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["improvements"],
    });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.firstMissing).toBe("plan");
    expect(s.ctaTo).toBe("/boardroom/$projectId");
  });

  it("audit+design missing audit → needs-prereq (audit)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["code_audit", "design_review"],
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.firstMissing).toBe("audit");
  });

  it("audit+design ready when audit + design present", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["code_audit", "design_review"],
      hasSuccessfulAudit: true,
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.scopeVariant).toBe("design_only");
  });

  it("audit+improvements ready needs plan; audit alone insufficient", () => {
    const missingPlan = computeRunwayEligibility({
      ...base,
      goals: ["code_audit", "improvements"],
      hasSuccessfulAudit: true,
    });
    expect(missingPlan.kind).toBe("needs-prereq");
    if (missingPlan.kind === "needs-prereq")
      expect(missingPlan.firstMissing).toBe("plan");

    const ready = computeRunwayEligibility({
      ...base,
      goals: ["code_audit", "improvements"],
      hasSuccessfulAudit: true,
      hasBuildSafePlan: true,
    });
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready") expect(ready.scopeVariant).toBe("improvements_only");
  });

  it("design+improvements ready when both artifacts present (combined)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["design_review", "improvements"],
      hasBuildSafePlan: true,
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.scopeVariant).toBe("combined");
  });

  it("design+improvements missing both surfaces plan first (order audit→plan→design)", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["design_review", "improvements"],
    });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.missing).toEqual(["plan", "design"]);
    expect(s.firstMissing).toBe("plan");
  });

  it("full: all three prereqs needed; audit surfaces first", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["code_audit", "design_review", "improvements"],
    });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.missing).toEqual(["audit", "plan", "design"]);
    expect(s.firstMissing).toBe("audit");
  });

  it("full ready → variant legacy_full copy", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: ["code_audit", "design_review", "improvements"],
      hasSuccessfulAudit: true,
      hasBuildSafePlan: true,
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.scopeVariant).toBe("legacy_full");
  });

  it("legacy imported (no goals) → full workflow gating; audit missing first", () => {
    const s = computeRunwayEligibility({ ...base, goals: null });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind !== "needs-prereq") return;
    expect(s.firstMissing).toBe("audit");
  });

  it("legacy imported ready when audit + plan + design present", () => {
    const s = computeRunwayEligibility({
      ...base,
      goals: null,
      hasSuccessfulAudit: true,
      hasBuildSafePlan: true,
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.scopeVariant).toBe("legacy_full");
  });
});
