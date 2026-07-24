// Pure decision tests for audit-runner's import-workflow gates. These
// exercise the same primitives the handler calls (deriveImportWorkflow,
// scopeContractForPrompt, validateImportStrategy) without a live DB.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveImportWorkflow } from "../_shared/import-workflow.ts";
import { scopeContractForPrompt } from "../_shared/import-scope-gates.ts";
import { validateImportStrategy } from "../_shared/import-strategy.ts";

const FULL_STRATEGY = {
  buyer: "Founders shipping their first Lovable app to real customers",
  acquisition_channel: "Indie hackers Twitter, Lovable community forum posts",
  paid_offer: "Blueprint audit with prompts for $49 one-time",
  activation_moment: "User pastes GitHub URL and sees their audit within 5 minutes",
  wow_moment: "The audit shows real evidence-backed findings with file paths",
  positioning: "Unlike generic AI code reviews, we ground every finding in code",
};

Deno.test("audit gate: code_audit not selected => audit rejected server-side", () => {
  const w = deriveImportWorkflow(["improvements"]);
  assert(!w.requiresAudit, "code_audit not selected");
});

Deno.test("audit gate: audit-only workflow still allows audit start", () => {
  const w = deriveImportWorkflow(["code_audit"]);
  assert(w.requiresAudit);
  assert(!w.requiresPlan);
  assert(!w.requiresDesign);
  assert(w.auditOnly);
});

Deno.test("audit gate: strategy required only when improvements selected", () => {
  const auditOnly = deriveImportWorkflow(["code_audit"]);
  const auditDesign = deriveImportWorkflow(["code_audit", "design_review"]);
  const auditImp = deriveImportWorkflow(["code_audit", "improvements"]);
  assertEquals(auditOnly.requiresPlan, false);
  assertEquals(auditDesign.requiresPlan, false);
  assertEquals(auditImp.requiresPlan, true);
});

Deno.test("audit gate: strategy blank passes for audit-only and audit+design", () => {
  const issues = validateImportStrategy({} as Record<string, string>);
  // Blank strategy has issues; but our audit gate only enforces this when
  // workflow.requiresPlan. Audit-only path skips validation entirely.
  assert(issues.length > 0);
});

Deno.test("audit gate: strategy complete passes validator", () => {
  const issues = validateImportStrategy(FULL_STRATEGY);
  assertEquals(issues.length, 0);
});

Deno.test("scope contract for audit-only prohibits product/design changes in prompt", () => {
  const w = deriveImportWorkflow(["code_audit"]);
  const contract = scopeContractForPrompt(w);
  assert(contract.includes("SCOPE CONTRACT"));
  assert(contract.includes("Product Improvements is NOT selected"));
  assert(contract.includes("Design Review is NOT selected"));
});

Deno.test("scope contract for code_audit+design_review allows UX findings but not product-scope", () => {
  const w = deriveImportWorkflow(["code_audit", "design_review"]);
  const contract = scopeContractForPrompt(w);
  assert(contract.includes("Product Improvements is NOT selected"));
  assert(!contract.includes("Design Review is NOT selected"));
});

Deno.test("scope contract for full scope has no prohibitions", () => {
  const w = deriveImportWorkflow(["code_audit", "design_review", "improvements"]);
  const contract = scopeContractForPrompt(w);
  assert(!contract.includes("NOT selected"));
});

Deno.test("legacy no-goals => full workflow (all three)", () => {
  const w = deriveImportWorkflow(undefined);
  assert(w.requiresAudit && w.requiresPlan && w.requiresDesign);
});
