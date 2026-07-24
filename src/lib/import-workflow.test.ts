import { describe, expect, it } from "vitest";
import {
  deriveImportWorkflow,
  nextImportRoute,
  normalizeImportGoals,
  type ImportStageFlags,
} from "./import-workflow";

const stage = (over: Partial<ImportStageFlags> = {}): ImportStageFlags => ({
  projectId: "p1",
  hasRepo: false,
  auditComplete: false,
  planComplete: false,
  designComplete: false,
  ...over,
});

describe("normalizeImportGoals", () => {
  it("keeps only supported values, dedupes, canonical order", () => {
    expect(normalizeImportGoals(["improvements", "code_audit", "improvements"])).toEqual([
      "code_audit",
      "improvements",
    ]);
  });
  it("drops unknown values", () => {
    expect(normalizeImportGoals(["code_audit", "bogus", 42, null])).toEqual(["code_audit"]);
  });
  it("legacy fallback: empty array => all three", () => {
    expect(normalizeImportGoals([])).toEqual(["code_audit", "design_review", "improvements"]);
  });
  it("legacy fallback: missing/non-array => all three", () => {
    expect(normalizeImportGoals(undefined)).toEqual(["code_audit", "design_review", "improvements"]);
    expect(normalizeImportGoals(null)).toEqual(["code_audit", "design_review", "improvements"]);
    expect(normalizeImportGoals({})).toEqual(["code_audit", "design_review", "improvements"]);
  });
});

describe("deriveImportWorkflow", () => {
  it("audit only", () => {
    const w = deriveImportWorkflow(["code_audit"]);
    expect(w).toMatchObject({
      requiresAudit: true,
      requiresPlan: false,
      requiresDesign: false,
      generatesPrompts: false,
      auditOnly: true,
    });
    expect(w.scopeLabel).toBe("Code audit");
  });
  it("design only", () => {
    const w = deriveImportWorkflow(["design_review"]);
    expect(w).toMatchObject({
      requiresAudit: false,
      requiresDesign: true,
      requiresPlan: false,
      generatesPrompts: true,
      auditOnly: false,
    });
  });
  it("improvements only", () => {
    const w = deriveImportWorkflow(["improvements"]);
    expect(w).toMatchObject({
      requiresPlan: true,
      generatesPrompts: true,
      auditOnly: false,
    });
  });
  it("two-goal custom (audit + design)", () => {
    const w = deriveImportWorkflow(["design_review", "code_audit"]);
    expect(w.goals).toEqual(["code_audit", "design_review"]);
    expect(w.auditOnly).toBe(false);
    expect(w.generatesPrompts).toBe(true);
    expect(w.scopeLabel).toBe("Code audit + Design review");
  });
  it("all three (legacy default)", () => {
    const w = deriveImportWorkflow(undefined);
    expect(w.goals).toEqual(["code_audit", "design_review", "improvements"]);
    expect(w.auditOnly).toBe(false);
    expect(w.generatesPrompts).toBe(true);
    expect(w.scopeLabel).toBe("Code audit, Design review + Improvements");
  });
});

describe("nextImportRoute", () => {
  it("audit-only stops at audit report, never boardroom", () => {
    const w = deriveImportWorkflow(["code_audit"]);
    expect(nextImportRoute(w, stage({ hasRepo: true }))).toEqual({
      kind: "audit",
      path: "/audits/p1",
    });
    expect(nextImportRoute(w, stage({ hasRepo: true, auditComplete: true }))).toEqual({
      kind: "done",
      path: "/audits/p1",
    });
  });
  it("routes to repo setup first when scope needs live code", () => {
    const w = deriveImportWorkflow(["improvements"]);
    expect(nextImportRoute(w, stage())).toEqual({ kind: "repo_setup", path: "/audits/p1" });
  });
  it("full path: repo → audit → plan → design → runway", () => {
    const w = deriveImportWorkflow(undefined);
    expect(nextImportRoute(w, stage()).kind).toBe("repo_setup");
    expect(nextImportRoute(w, stage({ hasRepo: true })).kind).toBe("audit");
    expect(
      nextImportRoute(w, stage({ hasRepo: true, auditComplete: true })).kind,
    ).toBe("plan");
    expect(
      nextImportRoute(
        w,
        stage({ hasRepo: true, auditComplete: true, planComplete: true }),
      ).kind,
    ).toBe("design");
    expect(
      nextImportRoute(
        w,
        stage({
          hasRepo: true,
          auditComplete: true,
          planComplete: true,
          designComplete: true,
        }),
      ),
    ).toEqual({ kind: "runway", path: "/runway/p1" });
  });
  it("design-only path skips plan", () => {
    const w = deriveImportWorkflow(["design_review"]);
    expect(nextImportRoute(w, stage({ hasRepo: true })).kind).toBe("design");
    expect(
      nextImportRoute(w, stage({ hasRepo: true, designComplete: true })).kind,
    ).toBe("runway");
  });
});
