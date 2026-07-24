import { describe, it, expect } from "vitest";
import { computeAuditScope } from "./audit-scope";

const PID = "proj-1";
const base = {
  loading: false as const,
  error: null as string | null,
  isImport: true,
  projectId: PID,
};

describe("computeAuditScope — loading/error/greenfield", () => {
  it("loading short-circuits", () => {
    expect(computeAuditScope({ ...base, loading: true })).toEqual({ kind: "loading" });
  });
  it("error short-circuits", () => {
    expect(computeAuditScope({ ...base, error: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
  });
  it("greenfield returns greenfield mode", () => {
    expect(computeAuditScope({ ...base, isImport: false, goals: null })).toEqual({
      kind: "greenfield",
    });
  });
});

describe("computeAuditScope — imports without code_audit are Repo Setup only", () => {
  it("design-only: repo-setup mode; continue → Design; no strategy gate", () => {
    const s = computeAuditScope({ ...base, goals: ["design_review"] });
    expect(s.kind).toBe("import-repo-setup-only");
    if (s.kind !== "import-repo-setup-only") return;
    expect(s.continueCta?.kind).toBe("design");
    expect(s.continueCta?.to).toBe("/design/$projectId");
    expect(s.workflow.requiresAudit).toBe(false);
  });

  it("improvements-only: repo-setup mode; continue → Boardroom", () => {
    const s = computeAuditScope({ ...base, goals: ["improvements"] });
    expect(s.kind).toBe("import-repo-setup-only");
    if (s.kind !== "import-repo-setup-only") return;
    expect(s.continueCta?.kind).toBe("plan");
    expect(s.continueCta?.to).toBe("/boardroom/$projectId");
  });

  it("design+improvements: repo-setup mode; continue prefers Boardroom", () => {
    const s = computeAuditScope({ ...base, goals: ["design_review", "improvements"] });
    expect(s.kind).toBe("import-repo-setup-only");
    if (s.kind !== "import-repo-setup-only") return;
    expect(s.continueCta?.kind).toBe("plan");
  });
});

describe("computeAuditScope — imports with code_audit render full audit UI", () => {
  it("audit-only: postAuditCta is null (stay in Audit Center); strategy NOT required", () => {
    const s = computeAuditScope({ ...base, goals: ["code_audit"] });
    expect(s.kind).toBe("import-with-audit");
    if (s.kind !== "import-with-audit") return;
    expect(s.postAuditCta).toBeNull();
    expect(s.requiresStrategy).toBe(false);
    expect(s.workflow.auditOnly).toBe(true);
  });

  it("audit+design: postAuditCta → Design; strategy NOT required", () => {
    const s = computeAuditScope({ ...base, goals: ["code_audit", "design_review"] });
    expect(s.kind).toBe("import-with-audit");
    if (s.kind !== "import-with-audit") return;
    expect(s.postAuditCta?.kind).toBe("design");
    expect(s.requiresStrategy).toBe(false);
  });

  it("audit+improvements: postAuditCta → Boardroom; strategy required", () => {
    const s = computeAuditScope({ ...base, goals: ["code_audit", "improvements"] });
    expect(s.kind).toBe("import-with-audit");
    if (s.kind !== "import-with-audit") return;
    expect(s.postAuditCta?.kind).toBe("plan");
    expect(s.requiresStrategy).toBe(true);
  });

  it("full: postAuditCta → Boardroom (plan wins); strategy required", () => {
    const s = computeAuditScope({
      ...base,
      goals: ["code_audit", "design_review", "improvements"],
    });
    expect(s.kind).toBe("import-with-audit");
    if (s.kind !== "import-with-audit") return;
    expect(s.postAuditCta?.kind).toBe("plan");
    expect(s.requiresStrategy).toBe(true);
  });

  it("legacy import (no goals): defaults to full workflow — audit + strategy + Boardroom CTA", () => {
    const s = computeAuditScope({ ...base, goals: null });
    expect(s.kind).toBe("import-with-audit");
    if (s.kind !== "import-with-audit") return;
    expect(s.requiresStrategy).toBe(true);
    expect(s.postAuditCta?.kind).toBe("plan");
  });
});
