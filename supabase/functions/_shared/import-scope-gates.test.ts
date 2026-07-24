import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deriveImportWorkflow } from "./import-workflow.ts";
import {
  evaluateStartRunGate,
  scopeContractForPrompt,
  type StartRunState,
} from "./import-scope-gates.ts";

const st = (over: Partial<StartRunState> = {}): StartRunState => ({
  auditComplete: false,
  planLocked: false,
  designLocked: false,
  ...over,
});

Deno.test("plan gate: blocks when improvements not selected", () => {
  assertEquals(
    evaluateStartRunGate(deriveImportWorkflow(["code_audit"]), "plan", st({ auditComplete: true }))
      .allowed,
    false,
  );
  assertEquals(
    evaluateStartRunGate(deriveImportWorkflow(["design_review"]), "plan", st()).allowed,
    false,
  );
});

Deno.test("plan gate: audit required only when code_audit selected", () => {
  assertEquals(
    evaluateStartRunGate(deriveImportWorkflow(["improvements"]), "plan", st()).allowed,
    true,
  );
  const full = deriveImportWorkflow(undefined);
  assertEquals(evaluateStartRunGate(full, "plan", st()).allowed, false);
  assertEquals(evaluateStartRunGate(full, "plan", st({ auditComplete: true })).allowed, true);
});

Deno.test("design gate: design-only works without a plan", () => {
  assertEquals(
    evaluateStartRunGate(deriveImportWorkflow(["design_review"]), "design", st()).allowed,
    true,
  );
});

Deno.test("design gate: requires plan when improvements selected", () => {
  const w = deriveImportWorkflow(["design_review", "improvements"]);
  assertEquals(evaluateStartRunGate(w, "design", st()).allowed, false);
  assertEquals(evaluateStartRunGate(w, "design", st({ planLocked: true })).allowed, true);
});

Deno.test("design gate: rejects when design not selected", () => {
  assertEquals(
    evaluateStartRunGate(deriveImportWorkflow(["improvements"]), "design", st({ planLocked: true }))
      .allowed,
    false,
  );
});

Deno.test("batches gate: audit-only rejected with prompt message", () => {
  const r = evaluateStartRunGate(
    deriveImportWorkflow(["code_audit"]),
    "batches",
    st({ auditComplete: true }),
  );
  assertEquals(r.allowed, false);
  if (!r.allowed) assertMatch(r.reason, /ends at the audit report/);
});

Deno.test("batches gate: design-only allowed once design locked", () => {
  const w = deriveImportWorkflow(["design_review"]);
  assertEquals(evaluateStartRunGate(w, "batches", st()).allowed, false);
  assertEquals(evaluateStartRunGate(w, "batches", st({ designLocked: true })).allowed, true);
});

Deno.test("batches gate: improvements-only allowed once plan locked", () => {
  assertEquals(
    evaluateStartRunGate(
      deriveImportWorkflow(["improvements"]),
      "batches",
      st({ planLocked: true }),
    ).allowed,
    true,
  );
});

Deno.test("batches gate: full scope requires all three artifacts", () => {
  const w = deriveImportWorkflow(undefined);
  assertEquals(
    evaluateStartRunGate(w, "batches", st({ auditComplete: true, planLocked: true })).allowed,
    false,
  );
  assertEquals(
    evaluateStartRunGate(
      w,
      "batches",
      st({ auditComplete: true, planLocked: true, designLocked: true }),
    ).allowed,
    true,
  );
});

Deno.test("scopeContractForPrompt: improvements-only preserves visual system", () => {
  const c = scopeContractForPrompt(deriveImportWorkflow(["improvements"]));
  assertMatch(c, /Design Review is NOT selected/);
  assertMatch(c, /preserve the existing visual system/i);
});

Deno.test("scopeContractForPrompt: design-only preserves product scope", () => {
  const c = scopeContractForPrompt(deriveImportWorkflow(["design_review"]));
  assertMatch(c, /Product Improvements is NOT selected/);
  assertMatch(c, /preserve the existing product scope/i);
});

Deno.test("scopeContractForPrompt: audit-only marks report-only deliverable", () => {
  const c = scopeContractForPrompt(deriveImportWorkflow(["code_audit"]));
  assertMatch(c, /audit report only/);
});
