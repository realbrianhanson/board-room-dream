import { describe, it, expect } from "vitest";
import { computeDesignGate } from "./design-gate";

const PID = "proj-1";
const baseImportInputs = {
  loading: false as const,
  error: null as string | null,
  isImport: true,
  projectId: PID,
  hasRepo: true,
  hasSuccessfulAudit: false,
  hasBuildSafePlan: false,
  hasBuildSafeDesign: false,
};

describe("computeDesignGate — loading / error / greenfield", () => {
  it("loading and error branches short-circuit", () => {
    expect(computeDesignGate({ ...baseImportInputs, loading: true })).toEqual({
      kind: "loading",
    });
    expect(
      computeDesignGate({ ...baseImportInputs, error: "boom" }),
    ).toEqual({ kind: "error", message: "boom" });
  });

  it("greenfield without a build-safe plan → needs-prereq (plan)", () => {
    const s = computeDesignGate({
      ...baseImportInputs,
      isImport: false,
      goals: null,
    });
    expect(s).toEqual({
      kind: "needs-prereq",
      workflow: null,
      missing: "plan",
      isImport: false,
    });
  });

  it("greenfield with a build-safe plan → ready", () => {
    const s = computeDesignGate({
      ...baseImportInputs,
      isImport: false,
      goals: null,
      hasBuildSafePlan: true,
    });
    expect(s).toEqual({ kind: "ready", workflow: null });
  });
});

describe("computeDesignGate — imported scope semantics", () => {
  it("audit-only: out of scope; nextRoute is Audit", () => {
    const s = computeDesignGate({
      ...baseImportInputs,
      goals: ["code_audit"],
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("audit");
    expect(s.nextRoute.path).toBe(`/audits/${PID}`);
  });

  it("improvements-only: out of scope; nextRoute is Boardroom (plan)", () => {
    const s = computeDesignGate({
      ...baseImportInputs,
      goals: ["improvements"],
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("plan");
    expect(s.nextRoute.path).toBe(`/boardroom/${PID}`);
  });

  it("design-only: ready — no audit, no plan required", () => {
    const s = computeDesignGate({
      ...baseImportInputs,
      goals: ["design_review"],
    });
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.workflow?.requiresAudit).toBe(false);
    expect(s.workflow?.requiresPlan).toBe(false);
    expect(s.workflow?.requiresDesign).toBe(true);
  });

  it("audit+design: needs successful audit before ready; plan NOT required", () => {
    const goals = ["code_audit", "design_review"];
    const s1 = computeDesignGate({ ...baseImportInputs, goals });
    expect(s1.kind).toBe("needs-prereq");
    if (s1.kind === "needs-prereq") expect(s1.missing).toBe("audit");

    const s2 = computeDesignGate({
      ...baseImportInputs,
      goals,
      hasSuccessfulAudit: true,
    });
    expect(s2.kind).toBe("ready");
  });

  it("design+improvements: no audit required; plan required", () => {
    const goals = ["design_review", "improvements"];
    const s1 = computeDesignGate({ ...baseImportInputs, goals });
    expect(s1.kind).toBe("needs-prereq");
    if (s1.kind === "needs-prereq") expect(s1.missing).toBe("plan");

    const s2 = computeDesignGate({
      ...baseImportInputs,
      goals,
      hasBuildSafePlan: true,
    });
    expect(s2.kind).toBe("ready");
  });

  it("full: needs audit first, then plan, then ready", () => {
    const goals = ["code_audit", "design_review", "improvements"];
    const s1 = computeDesignGate({ ...baseImportInputs, goals });
    expect(s1.kind).toBe("needs-prereq");
    if (s1.kind === "needs-prereq") expect(s1.missing).toBe("audit");

    const s2 = computeDesignGate({
      ...baseImportInputs,
      goals,
      hasSuccessfulAudit: true,
    });
    expect(s2.kind).toBe("needs-prereq");
    if (s2.kind === "needs-prereq") expect(s2.missing).toBe("plan");

    const s3 = computeDesignGate({
      ...baseImportInputs,
      goals,
      hasSuccessfulAudit: true,
      hasBuildSafePlan: true,
    });
    expect(s3.kind).toBe("ready");
  });

  it("legacy imported (no goals) → full workflow behavior", () => {
    const s1 = computeDesignGate({ ...baseImportInputs, goals: null });
    expect(s1.kind).toBe("needs-prereq");
    if (s1.kind === "needs-prereq") expect(s1.missing).toBe("audit");

    const s2 = computeDesignGate({
      ...baseImportInputs,
      goals: null,
      hasSuccessfulAudit: true,
      hasBuildSafePlan: true,
    });
    expect(s2.kind).toBe("ready");
  });

  it("out-of-scope import without repo → nextRoute is repo_setup", () => {
    const s = computeDesignGate({
      ...baseImportInputs,
      goals: ["improvements"],
      hasRepo: false,
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("repo_setup");
  });
});

describe("computeDesignGate — repo prerequisite (imports compile live code)", () => {
  const base = {
    loading: false as const,
    error: null as string | null,
    isImport: true,
    projectId: "p",
    hasRepo: true,
    hasSuccessfulAudit: false,
    hasBuildSafePlan: false,
    hasBuildSafeDesign: false,
  };
  it("design-only without repo → needs-prereq missing=repo", () => {
    const s = computeDesignGate({ ...base, goals: ["design_review"], hasRepo: false });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind === "needs-prereq") expect(s.missing).toBe("repo");
  });
  it("needs-repo beats missing audit for audit+design", () => {
    const s = computeDesignGate({
      ...base,
      goals: ["code_audit", "design_review"],
      hasRepo: false,
    });
    expect(s.kind).toBe("needs-prereq");
    if (s.kind === "needs-prereq") expect(s.missing).toBe("repo");
  });
  it("design not in scope → out-of-scope regardless of repo", () => {
    const s = computeDesignGate({ ...base, goals: ["improvements"], hasRepo: false });
    expect(s.kind).toBe("out-of-scope");
  });
});
