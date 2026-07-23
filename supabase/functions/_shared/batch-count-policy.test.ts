// Pure prompt-policy + product-strategy contract regression.
// Run: cd supabase/functions && deno test _shared/batch-count-policy.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { batchPromptPolicy, productStrategyContract } from "./batch-count-policy.ts";
import { correctionForStep, validateStepJson } from "../boardroom-orchestrator/protocol.ts";

// -------- batchPromptPolicy --------

Deno.test("batchPromptPolicy — greenfield asks for 6-8 (prefer 6)", () => {
  const p = batchPromptPolicy(false);
  assertEquals(p.minBatches, 6);
  assertEquals(p.maxBatches, 8);
  assertEquals(p.rangeText, "6-8");
  assertStringIncludes(p.rangePrompt, "6-8 dependency-safe");
  assertStringIncludes(p.rangePrompt, "STRONGLY PREFER 6");
  assertStringIncludes(p.countRule, "Exactly 6 batches");
});

Deno.test("batchPromptPolicy — imports ask for 3-6, smallest-without-padding", () => {
  const p = batchPromptPolicy(true);
  assertEquals(p.minBatches, 3);
  assertEquals(p.maxBatches, 6);
  assertEquals(p.rangeText, "3-6");
  assertStringIncludes(p.rangePrompt, "SMALLEST count");
  assertStringIncludes(p.rangePrompt, "Do NOT invent extra batches");
  assertStringIncludes(p.countRule, "Between 3 and 6 batches");
  assert(!/Exactly 6 batches/i.test(p.rangePrompt + p.countRule), "imports must not demand exactly six");
});

// -------- productStrategyContract --------

Deno.test("productStrategyContract — locks the five owner-authority decisions", () => {
  const s = productStrategyContract();
  assertStringIncludes(s, `"## Product strategy"`);
  // Five decisions.
  assertStringIncludes(s, "Reachable buyer");
  assertStringIncludes(s, "acquisition channel");
  assertStringIncludes(s, "Paid offer");
  assertStringIncludes(s, "Price anchor");
  assertStringIncludes(s, "Upgrade trigger");
  assertStringIncludes(s, "First-90-second activation moment");
  assertStringIncludes(s, "Screenshot-worthy wow moment");
  assertStringIncludes(s, `Positioning line completing "Unlike`);
});

Deno.test("productStrategyContract — removes the generic 'owner-unknown assumption' directive", () => {
  const s = productStrategyContract();
  assert(!/owner-unknown assumption/i.test(s), "must not emit a generic owner-unknown assumption directive");
  // Missing owner inputs must instead be surfaced as missing context.
  assertStringIncludes(s, "state the context is missing");
  assertStringIncludes(s, "do not invent");
});

Deno.test("productStrategyContract — price/upgrade advisory boundary matches import-contract.ts wording", () => {
  const s = productStrategyContract();
  // Price/upgrade allowed as owner-approval-required proposals only.
  assertStringIncludes(s, "[OWNER DECISION REQUIRED]");
  assertStringIncludes(s, "proposal_requires_owner_approval");
  assertStringIncludes(s, "never carries an \"OWNER-AUTHORIZED\" marker");
  assertStringIncludes(s, "EXCLUDED from any locked plan, executable batch, compiled implementation prompt, checkout flow, pricing CTA, or monetization scope");
  // Reference the shared contract file so drift is caught.
  assertStringIncludes(s, "supabase/functions/_shared/import-contract.ts");
  // Advisory carve-out must not extend to buyer/positioning/activation/wow/paid_offer.
  const paidOfferBullet = s.split("\n").find((l) => l.startsWith("- Paid offer")) ?? "";
  assert(!/OWNER DECISION REQUIRED/.test(paidOfferBullet), "paid offer must not be an advisory-eligible field");
  const buyerBullet = s.split("\n").find((l) => l.startsWith("- Reachable buyer")) ?? "";
  assert(!/OWNER DECISION REQUIRED/.test(buyerBullet), "buyer must not be an advisory-eligible field");
});

// -------- validateStepJson batch-count coverage --------

function makeBatches(n: number) {
  const filler = "x".repeat(320);
  return Array.from({ length: n }, (_, i) => ({
    batch_no: i + 1,
    title: `Batch ${i + 1}`,
    channel: "human",
    prompt_md: `Batch ${i + 1} — human step.\n\n1. Step one is a plain-language action the student takes in an external console. ${filler}`,
  }));
}

Deno.test("validateStepJson — batches_chair accepts a valid 3-batch payload (imports)", () => {
  assertEquals(validateStepJson("batches_chair", { batches: makeBatches(3) }), null);
});

Deno.test("validateStepJson — batches_chair accepts a valid 8-batch payload (greenfield upper bound)", () => {
  assertEquals(validateStepJson("batches_chair", { batches: makeBatches(8) }), null);
});

Deno.test("validateStepJson — batches_chair rejects 2 batches (below floor)", () => {
  const err = validateStepJson("batches_chair", { batches: makeBatches(2) });
  assert(err && /3-8/.test(err), `expected 3-8 range error, got: ${err}`);
});

Deno.test("validateStepJson — batches_chair rejects 9 batches (above ceiling)", () => {
  const err = validateStepJson("batches_chair", { batches: makeBatches(9) });
  assert(err && /3-8/.test(err), `expected 3-8 range error, got: ${err}`);
});

// -------- correctionForStep no longer forces six --------

Deno.test("correctionForStep — batch generation copy is contract-consistent (imports 3-6, greenfield 6-8), no exactly-six mandate", () => {
  for (const k of ["batches_chair", "batches_revise_chair"]) {
    const cImport = correctionForStep(k, { isImport: true });
    assertStringIncludes(cImport, "3-6 batches");
    assertStringIncludes(cImport, "smallest count");
    assert(!/\b3-8 batches\b/.test(cImport), `import copy must not offer 3-8 (got: ${cImport})`);
    assert(!/exactly\s+6\s+batches/i.test(cImport), `must not require exactly six batches (got: ${cImport})`);
    assert(!/exactly\s+six\s+batches/i.test(cImport), `must not require exactly six batches (got: ${cImport})`);

    const cGreen = correctionForStep(k, { isImport: false });
    assertStringIncludes(cGreen, "6-8 batches");
    assert(!/\b3-8 batches\b/.test(cGreen), `greenfield copy must not offer 3-8 (got: ${cGreen})`);
    assert(!/exactly\s+6\s+batches/i.test(cGreen), `must not require exactly six batches (got: ${cGreen})`);
  }
});
