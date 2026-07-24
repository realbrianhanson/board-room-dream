import { describe, it, expect } from "vitest";
import {
  computeBoardroomGate,
  IMPORT_AUDIT_GATE_MESSAGE,
} from "./boardroom-gate";

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

describe("computeBoardroomGate — loading / error / greenfield", () => {
  it("returns loading while queries are in flight", () => {
    expect(
      computeBoardroomGate({ ...baseImportInputs, loading: true }),
    ).toEqual({ kind: "loading" });
  });

  it("returns error state (retryable) when any query failed", () => {
    expect(
      computeBoardroomGate({ ...baseImportInputs, error: "network exploded" }),
    ).toEqual({ kind: "error", message: "network exploded" });
  });

  it("error takes precedence over the import-audit gate", () => {
    const s = computeBoardroomGate({ ...baseImportInputs, error: "boom" });
    expect(s.kind).toBe("error");
  });

  it("greenfield is always ready — goals field is ignored", () => {
    for (const hasSuccessfulAudit of [false, true]) {
      const s = computeBoardroomGate({
        ...baseImportInputs,
        isImport: false,
        goals: null,
        hasSuccessfulAudit,
      });
      expect(s.kind).toBe("ready");
      if (s.kind === "ready") expect(s.workflow).toBeNull();
    }
  });
});

describe("computeBoardroomGate — imported scope semantics", () => {
  it("legacy imported (no goals) → full workflow, gated on audit like before", () => {
    const gated = computeBoardroomGate({ ...baseImportInputs, goals: null });
    expect(gated).toEqual({
      kind: "needs-import-audit",
      message: IMPORT_AUDIT_GATE_MESSAGE,
    });
    const ready = computeBoardroomGate({
      ...baseImportInputs,
      goals: null,
      hasSuccessfulAudit: true,
    });
    expect(ready.kind).toBe("ready");
  });

  it("full workflow: requires successful audit before ready", () => {
    const goals = ["code_audit", "design_review", "improvements"];
    expect(
      computeBoardroomGate({ ...baseImportInputs, goals }).kind,
    ).toBe("needs-import-audit");
    expect(
      computeBoardroomGate({
        ...baseImportInputs,
        goals,
        hasSuccessfulAudit: true,
      }).kind,
    ).toBe("ready");
  });

  it("audit+improvements (no design): requires audit before ready", () => {
    const goals = ["code_audit", "improvements"];
    expect(
      computeBoardroomGate({ ...baseImportInputs, goals }).kind,
    ).toBe("needs-import-audit");
    expect(
      computeBoardroomGate({
        ...baseImportInputs,
        goals,
        hasSuccessfulAudit: true,
      }).kind,
    ).toBe("ready");
  });

  it("improvements-only: ready immediately, no audit required", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["improvements"],
    });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.workflow?.requiresAudit).toBe(false);
      expect(s.workflow?.requiresPlan).toBe(true);
    }
  });

  it("design+improvements: ready without an audit", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["design_review", "improvements"],
    });
    expect(s.kind).toBe("ready");
  });
});

describe("computeBoardroomGate — out-of-scope routing", () => {
  it("audit-only: out of scope; nextRoute points at the audit report", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["code_audit"],
      hasSuccessfulAudit: true,
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.workflow.auditOnly).toBe(true);
    expect(s.nextRoute.kind).toBe("done");
    expect(s.nextRoute.path).toBe(`/audits/${PID}`);
  });

  it("audit-only without audit yet: nextRoute is 'audit' → Audit Center", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["code_audit"],
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("audit");
    expect(s.nextRoute.path).toBe(`/audits/${PID}`);
  });

  it("design-only: out of scope; nextRoute is Design", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["design_review"],
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("design");
    expect(s.nextRoute.path).toBe(`/design/${PID}`);
  });

  it("design-only with locked design: nextRoute is Runway (artifacts ready)", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["design_review"],
      hasBuildSafeDesign: true,
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("runway");
    expect(s.nextRoute.path).toBe(`/runway/${PID}`);
  });

  it("audit+design (no improvements): needs audit → nextRoute is 'audit'", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["code_audit", "design_review"],
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("audit");
  });

  it("audit+design with audit done → nextRoute is Design", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["code_audit", "design_review"],
      hasSuccessfulAudit: true,
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("design");
  });

  it("out-of-scope import without a repo → routes to Audit Center for repo setup", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["design_review"],
      hasRepo: false,
    });
    expect(s.kind).toBe("out-of-scope");
    if (s.kind !== "out-of-scope") return;
    expect(s.nextRoute.kind).toBe("repo_setup");
    expect(s.nextRoute.path).toBe(`/audits/${PID}`);
  });
});

describe("computeBoardroomGate — repo prerequisite (imports compile live code)", () => {
  it("returns needs-repo when improvements selected but no GitHub repo linked", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["improvements"],
      hasRepo: false,
    });
    expect(s.kind).toBe("needs-repo");
    if (s.kind === "needs-repo") expect(s.workflow.requiresPlan).toBe(true);
  });
  it("needs-repo beats needs-import-audit when both are missing", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["code_audit", "improvements"],
      hasRepo: false,
      hasSuccessfulAudit: false,
    });
    expect(s.kind).toBe("needs-repo");
  });
  it("out-of-scope still fires when improvements not selected, regardless of repo", () => {
    const s = computeBoardroomGate({
      ...baseImportInputs,
      goals: ["code_audit"],
      hasRepo: false,
    });
    expect(s.kind).toBe("out-of-scope");
  });
});
