// Prompt-scope regression tests for the plan/design pipeline in queues.ts.
// Static source scan proves that every step that can introduce or approve
// executable scope threads the owner-selected scope contract exactly once,
// plus behavior checks on scopeContractForPrompt covering design-only,
// improvements-only, full, and legacy (no goals) workflows.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveImportWorkflow } from "../_shared/import-workflow.ts";
import { scopeContractForPrompt } from "../_shared/import-scope-gates.ts";

const src = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));

function body(name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const rest = src.slice(start);
  // Next top-level export marks the end of this function's body.
  const nextIdx = rest.indexOf("\nexport async function ", 1);
  return nextIdx < 0 ? rest : rest.slice(0, nextIdx);
}

// Count occurrences of the substring so we can assert scope is applied
// EXACTLY once per queueing function — never doubled into system + user.
function count(hay: string, needle: string): number {
  let n = 0;
  let i = 0;
  while (true) {
    const j = hay.indexOf(needle, i);
    if (j < 0) return n;
    n += 1;
    i = j + needle.length;
  }
}

Deno.test("queueRound1: loads scope once and wraps the system prompt for imports", () => {
  const b = body("queueRound1");
  assertEquals(count(b, "getScopeContract("), 1, "scope contract loaded exactly once");
  assertEquals(count(b, "withScope("), 1, "system wrapped exactly once");
  // Design-only design brief must describe the LOCKED PLAN as OUT OF SCOPE,
  // never "convene later"; that instruction lives in queueRound1's design
  // branch when workflow.requiresPlan is false.
  assertStringIncludes(b, "out of scope");
  assertStringIncludes(b, "FROZEN");
});

Deno.test("queueRound2: cross-examination receives scope exactly once", () => {
  const b = body("queueRound2");
  assertEquals(count(b, "getScopeContract("), 1);
  assertEquals(count(b, "withScope("), 1);
  // Loaded ONCE at function scope, not per seat (bounded prompt size).
  const perSeat = b.indexOf("SEATS.map");
  const load = b.indexOf("getScopeContract(");
  assert(load < perSeat, "scope must load before the per-seat map");
});

Deno.test("queueRound3: chair synthesis (and loop revisions) receive scope", () => {
  const b = body("queueRound3");
  assertEquals(count(b, "getScopeContract("), 1);
  assertEquals(count(b, "withScope("), 1);
});

Deno.test("queueRound3Extract: pure extraction does NOT need scope", () => {
  const b = body("queueRound3Extract");
  assertEquals(
    count(b, "getScopeContract("),
    0,
    "extraction cannot introduce scope; no contract needed",
  );
  assertEquals(count(b, "withScope("), 0);
});

Deno.test("queueRound4: scored vote receives scope exactly once", () => {
  const b = body("queueRound4");
  assertEquals(count(b, "getScopeContract("), 1);
  assertEquals(count(b, "withScope("), 1);
  const perSeat = b.indexOf("voters.map");
  const load = b.indexOf("getScopeContract(");
  assert(load < perSeat, "scope must load once before the per-voter map");
});

Deno.test("queueFinalRuling: chair-ruled fallback receives scope", () => {
  const b = body("queueFinalRuling");
  assertEquals(count(b, "getScopeContract("), 1);
  assertEquals(count(b, "withScope("), 1);
});

Deno.test("queueBlueprint: PRD authoring receives scope", () => {
  const b = body("queueBlueprint");
  assertEquals(count(b, "getScopeContract("), 1);
  assertEquals(count(b, "withScope("), 1);
});

Deno.test("queueBlueprintExtract: pure extraction does NOT need scope", () => {
  const b = body("queueBlueprintExtract");
  assertEquals(count(b, "getScopeContract("), 0);
  assertEquals(count(b, "withScope("), 0);
});

// ---- scope contract content for the four target workflows -----------------

Deno.test("scope contract — design-only freezes product scope and data model", () => {
  const w = deriveImportWorkflow(["design_review"]);
  const s = scopeContractForPrompt(w);
  assertStringIncludes(s, "SCOPE CONTRACT");
  assertStringIncludes(s, "Product Improvements is NOT selected");
  assertStringIncludes(s, "Preserve the existing product scope and data model");
  // Design IS in scope — no visual-freeze clause.
  assert(!/Preserve the existing visual system/.test(s));
});

Deno.test("scope contract — improvements-only forbids restyling and preserves visuals", () => {
  const w = deriveImportWorkflow(["improvements"]);
  const s = scopeContractForPrompt(w);
  assertStringIncludes(s, "Design Review is NOT selected");
  assertStringIncludes(s, "Preserve the existing visual system");
  assertStringIncludes(s, "typography or palette changes");
  // Improvements IS in scope — no product-freeze clause.
  assert(!/Product Improvements is NOT selected/.test(s));
});

Deno.test("scope contract — full three-goal workflow names scope, adds no freeze clauses", () => {
  const w = deriveImportWorkflow(["code_audit", "design_review", "improvements"]);
  const s = scopeContractForPrompt(w);
  assertStringIncludes(s, "SCOPE CONTRACT");
  assertStringIncludes(s, "Selected scope:");
  assert(!/is NOT selected/.test(s), "full workflow must not emit any NOT-selected clauses");
});

Deno.test("scope contract — legacy no-goals defaults to full and stays unconstrained", () => {
  const w = deriveImportWorkflow(undefined);
  const s = scopeContractForPrompt(w);
  assertStringIncludes(s, "SCOPE CONTRACT");
  assert(!/is NOT selected/.test(s));
});

// ---- greenfield preservation ---------------------------------------------

Deno.test("greenfield runs skip scope loading in Round 1", () => {
  const b = body("queueRound1");
  // Guarded behind isImport in queueRound1 so greenfield runs pass "" to
  // withScope, which is a no-op.
  assertStringIncludes(b, `isImport ? await getScopeContract(admin, run) : ""`);
});
