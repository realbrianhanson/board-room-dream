// Pure decision tests for boardroom-orchestrator start_run scope gates.
// Covers the exact permutations the handler evaluates before creating a run.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveImportWorkflow } from "../_shared/import-workflow.ts";
import { evaluateStartRunGate } from "../_shared/import-scope-gates.ts";

const state = (
  partial: Partial<{ auditComplete: boolean; planLocked: boolean; designLocked: boolean; hasRepo: boolean }>,
) => ({
  auditComplete: false,
  planLocked: false,
  designLocked: false,
  hasRepo: true,
  ...partial,
});


Deno.test("start_run plan: rejected when improvements not selected (audit-only)", () => {
  const w = deriveImportWorkflow(["code_audit"]);
  const d = evaluateStartRunGate(w, "plan", state({ auditComplete: true }));
  assert(!d.allowed && /Improvements are not in the selected scope/i.test(d.reason));
});

Deno.test("start_run plan: requires audit only when code_audit is selected", () => {
  const w = deriveImportWorkflow(["improvements"]);
  const d = evaluateStartRunGate(w, "plan", state({}));
  assert(d.allowed, "plan must run without audit when code_audit not selected");
});

Deno.test("start_run plan: needs completed audit when both selected", () => {
  const w = deriveImportWorkflow(["code_audit", "improvements"]);
  const blocked = evaluateStartRunGate(w, "plan", state({}));
  assert(!blocked.allowed && blocked.nextStep === "audit");
  const ok = evaluateStartRunGate(w, "plan", state({ auditComplete: true }));
  assert(ok.allowed);
});

Deno.test("start_run design: design-only works without plan", () => {
  const w = deriveImportWorkflow(["design_review"]);
  const d = evaluateStartRunGate(w, "design", state({}));
  assert(d.allowed);
});

Deno.test("start_run design: requires plan when improvements also selected", () => {
  const w = deriveImportWorkflow(["design_review", "improvements"]);
  const blocked = evaluateStartRunGate(w, "design", state({}));
  assert(!blocked.allowed && blocked.nextStep === "plan");
  const ok = evaluateStartRunGate(w, "design", state({ planLocked: true }));
  assert(ok.allowed);
});

Deno.test("start_run design: rejected when design_review not selected", () => {
  const w = deriveImportWorkflow(["improvements"]);
  const d = evaluateStartRunGate(w, "design", state({ planLocked: true }));
  assert(!d.allowed && /Design Council is not in the selected scope/i.test(d.reason));
});

Deno.test("start_run batches: audit-only rejects with clear scope message", () => {
  const w = deriveImportWorkflow(["code_audit"]);
  const d = evaluateStartRunGate(w, "batches", state({ auditComplete: true }));
  assert(!d.allowed && /ends at the audit report/i.test(d.reason));
});

Deno.test("start_run batches: design-only works with locked design", () => {
  const w = deriveImportWorkflow(["design_review"]);
  assert(!evaluateStartRunGate(w, "batches", state({})).allowed);
  assert(evaluateStartRunGate(w, "batches", state({ designLocked: true })).allowed);
});

Deno.test("start_run batches: improvements-only works with locked plan", () => {
  const w = deriveImportWorkflow(["improvements"]);
  assert(!evaluateStartRunGate(w, "batches", state({})).allowed);
  assert(evaluateStartRunGate(w, "batches", state({ planLocked: true })).allowed);
});

Deno.test("start_run batches: full scope requires audit + plan + design", () => {
  const w = deriveImportWorkflow(["code_audit", "design_review", "improvements"]);
  assert(!evaluateStartRunGate(w, "batches", state({ planLocked: true, designLocked: true })).allowed);
  assert(evaluateStartRunGate(w, "batches", state({ auditComplete: true, planLocked: true, designLocked: true })).allowed);
});

Deno.test("start_run batches: two-goal audit+improvements works after audit+plan", () => {
  const w = deriveImportWorkflow(["code_audit", "improvements"]);
  const ok = evaluateStartRunGate(w, "batches", state({ auditComplete: true, planLocked: true }));
  assert(ok.allowed);
});

Deno.test("start_run batches: legacy no-goals expects full pipeline", () => {
  const w = deriveImportWorkflow(undefined);
  assert(!evaluateStartRunGate(w, "batches", state({})).allowed);
  assert(evaluateStartRunGate(w, "batches", state({ auditComplete: true, planLocked: true, designLocked: true })).allowed);
});

Deno.test("start_run repo gate: plan blocked without github_repo", () => {
  const w = deriveImportWorkflow(["improvements"]);
  const d = evaluateStartRunGate(w, "plan", state({ hasRepo: false }));
  assert(!d.allowed && d.nextStep === "repo_setup" && /Link your GitHub repo/i.test(d.reason));
});

Deno.test("start_run repo gate: design blocked without github_repo", () => {
  const w = deriveImportWorkflow(["design_review"]);
  const d = evaluateStartRunGate(w, "design", state({ hasRepo: false }));
  assert(!d.allowed && d.nextStep === "repo_setup");
});

Deno.test("start_run repo gate: batches blocked without github_repo", () => {
  const w = deriveImportWorkflow(["design_review"]);
  const d = evaluateStartRunGate(w, "batches", state({ designLocked: true, hasRepo: false }));
  assert(!d.allowed && d.nextStep === "repo_setup");
});
