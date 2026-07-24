import { describe, expect, it } from "vitest";
import { deriveImportWorkflow } from "./import-workflow";
import {
  evaluateStartRunGate,
  scopeContractForPrompt,
  type StartRunState,
} from "./import-scope-gates";

const st = (over: Partial<StartRunState> = {}): StartRunState => ({
  auditComplete: false,
  planLocked: false,
  designLocked: false,
  hasRepo: true,
  ...over,
});


describe("evaluateStartRunGate: plan", () => {
  it("blocks plan when improvements not selected (audit-only)", () => {
    const w = deriveImportWorkflow(["code_audit"]);
    const r = evaluateStartRunGate(w, "plan", st({ auditComplete: true }));
    expect(r.allowed).toBe(false);
  });
  it("blocks plan when improvements not selected (design-only)", () => {
    const w = deriveImportWorkflow(["design_review"]);
    expect(evaluateStartRunGate(w, "plan", st()).allowed).toBe(false);
  });
  it("requires audit only when code_audit is selected", () => {
    const w = deriveImportWorkflow(["improvements"]);
    expect(evaluateStartRunGate(w, "plan", st()).allowed).toBe(true);
    const full = deriveImportWorkflow(undefined);
    expect(evaluateStartRunGate(full, "plan", st()).allowed).toBe(false);
    expect(evaluateStartRunGate(full, "plan", st({ auditComplete: true })).allowed).toBe(true);
  });
});

describe("evaluateStartRunGate: design", () => {
  it("design-only works without a plan", () => {
    const w = deriveImportWorkflow(["design_review"]);
    expect(evaluateStartRunGate(w, "design", st()).allowed).toBe(true);
  });
  it("blocks design when not selected", () => {
    const w = deriveImportWorkflow(["improvements"]);
    expect(evaluateStartRunGate(w, "design", st({ planLocked: true })).allowed).toBe(false);
  });
  it("requires plan when improvements is selected", () => {
    const w = deriveImportWorkflow(["design_review", "improvements"]);
    expect(evaluateStartRunGate(w, "design", st()).allowed).toBe(false);
    expect(evaluateStartRunGate(w, "design", st({ planLocked: true })).allowed).toBe(true);
  });
  it("requires audit when code_audit selected", () => {
    const w = deriveImportWorkflow(["design_review", "code_audit"]);
    expect(evaluateStartRunGate(w, "design", st()).allowed).toBe(false);
    expect(evaluateStartRunGate(w, "design", st({ auditComplete: true })).allowed).toBe(true);
  });
});

describe("evaluateStartRunGate: batches", () => {
  it("rejects audit-only with prompt scope message", () => {
    const w = deriveImportWorkflow(["code_audit"]);
    const r = evaluateStartRunGate(w, "batches", st({ auditComplete: true }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/ends at the audit report/);
  });
  it("design-only allows batches once design locked", () => {
    const w = deriveImportWorkflow(["design_review"]);
    expect(evaluateStartRunGate(w, "batches", st()).allowed).toBe(false);
    expect(evaluateStartRunGate(w, "batches", st({ designLocked: true })).allowed).toBe(true);
  });
  it("improvements-only allows batches once plan locked (no design needed)", () => {
    const w = deriveImportWorkflow(["improvements"]);
    expect(evaluateStartRunGate(w, "batches", st({ planLocked: true })).allowed).toBe(true);
  });
  it("full scope requires all three artifacts", () => {
    const w = deriveImportWorkflow(undefined);
    expect(
      evaluateStartRunGate(w, "batches", st({ auditComplete: true, planLocked: true })).allowed,
    ).toBe(false);
    expect(
      evaluateStartRunGate(
        w,
        "batches",
        st({ auditComplete: true, planLocked: true, designLocked: true }),
      ).allowed,
    ).toBe(true);
  });
});

describe("scopeContractForPrompt", () => {
  it("improvements-only preserves visual system", () => {
    const c = scopeContractForPrompt(deriveImportWorkflow(["improvements"]));
    expect(c).toMatch(/Design Review is NOT selected/);
    expect(c).toMatch(/preserve the existing visual system/i);
  });
  it("design-only preserves product scope", () => {
    const c = scopeContractForPrompt(deriveImportWorkflow(["design_review"]));
    expect(c).toMatch(/Product Improvements is NOT selected/);
    expect(c).toMatch(/preserve the existing product scope/i);
  });
  it("audit-only marks report-only deliverable", () => {
    const c = scopeContractForPrompt(deriveImportWorkflow(["code_audit"]));
    expect(c).toMatch(/audit report only/);
  });
  it("full scope has no NOT-selected exclusions", () => {
    const c = scopeContractForPrompt(deriveImportWorkflow(undefined));
    expect(c).not.toMatch(/NOT selected/);
  });
});

describe("evaluateStartRunGate: repo prerequisite (imports compile live code)", () => {
  it("blocks plan when GitHub repo not linked (improvements-only)", () => {
    const w = deriveImportWorkflow(["improvements"]);
    const r = evaluateStartRunGate(w, "plan", st({ hasRepo: false }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.nextStep).toBe("repo_setup");
      expect(r.reason).toMatch(/Link your GitHub repo/);
    }
  });
  it("blocks design when GitHub repo not linked (design-only)", () => {
    const w = deriveImportWorkflow(["design_review"]);
    const r = evaluateStartRunGate(w, "design", st({ hasRepo: false }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.nextStep).toBe("repo_setup");
  });
  it("blocks batches when GitHub repo not linked (design-only, design locked)", () => {
    const w = deriveImportWorkflow(["design_review"]);
    const r = evaluateStartRunGate(w, "batches", st({ designLocked: true, hasRepo: false }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.nextStep).toBe("repo_setup");
  });
  it("repo missing takes precedence over audit missing for plan (full scope)", () => {
    const w = deriveImportWorkflow(undefined);
    const r = evaluateStartRunGate(w, "plan", st({ hasRepo: false }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.nextStep).toBe("repo_setup");
  });
  it("out-of-scope reject wins over missing repo (improvements not selected → plan)", () => {
    const w = deriveImportWorkflow(["code_audit"]);
    const r = evaluateStartRunGate(w, "plan", st({ hasRepo: false, auditComplete: true }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.nextStep).toBeUndefined();
  });
});
