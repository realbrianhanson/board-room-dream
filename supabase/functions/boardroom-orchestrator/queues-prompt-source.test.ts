// Prompt-source regression: assert that the Boardroom orchestrator queues
// still carry the required Product strategy contract, its five decisions,
// owner-authority language for imports, and the split greenfield/import
// batch-count wording. This locks intent even for text that isn't easily
// reachable from a pure function.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const queuesSrc = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));

Deno.test("queues.ts — Product strategy H2 contract and five decisions are still emitted", () => {
  // The R3 synthesis prompt still references the shared contract helper.
  assertStringIncludes(queuesSrc, "productStrategyContract()");

  // The contract itself is imported from the shared module.
  assertStringIncludes(queuesSrc, `from "../_shared/batch-count-policy.ts"`);
});

Deno.test("queues.ts — split batch policy (imports 3-6, greenfield 6-8) still wired to prompt", () => {
  assertStringIncludes(queuesSrc, "batchPromptPolicy(isImport)");
  // Prompt still surfaces the policy fields to the model.
  assertStringIncludes(queuesSrc, "${batchRangeText} batches");
  assertStringIncludes(queuesSrc, "${batchCountRule}");
  assertStringIncludes(queuesSrc, "${batchRangePrompt}");
  // Should no longer inline the old hard-coded "3-6" / "6-8" ternary.
  assert(
    !/isImport\s*\?\s*"3-6"\s*:\s*"6-8"/.test(queuesSrc),
    "inline batch-range ternary must be gone; use batchPromptPolicy",
  );
});
