import { describe, it, expect } from "vitest";
import { auditRowGuidance } from "../audits";

describe("APP-RELIABILITY-FINDINGS-R1 / task 6b: auditRowGuidance", () => {
  it("audited project: shows ledger open", () => {
    expect(auditRowGuidance({ hasAudit: true, isImport: true, status: "auditing" }).label)
      .toBe("Audit ledger open");
  });

  it("imported without audit: guides to A–Z audit on real code", () => {
    const g = auditRowGuidance({ hasAudit: false, isImport: true, status: "imported" });
    expect(g.label).toMatch(/A.Z audit/);
    expect(g.tone).toBe("primary");
  });

  it("greenfield building: guides to ship a batch", () => {
    const g = auditRowGuidance({ hasAudit: false, isImport: false, status: "building" });
    expect(g.label).toMatch(/ship a batch/i);
    expect(g.tone).toBe("primary");
  });

  it("greenfield locked without audit: guides toward generating & shipping a batch", () => {
    const g = auditRowGuidance({ hasAudit: false, isImport: false, status: "locked" });
    expect(g.label).toMatch(/batch/i);
    expect(g.tone).toBe("muted");
  });

  it("greenfield validated without audit: muted no-audits placeholder", () => {
    const g = auditRowGuidance({ hasAudit: false, isImport: false, status: "validated" });
    expect(g.label).toMatch(/No audits/i);
    expect(g.tone).toBe("muted");
  });
});
