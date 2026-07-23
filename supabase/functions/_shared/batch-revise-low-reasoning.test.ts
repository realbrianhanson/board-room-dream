// BATCH-REVISE-LOW-REASONING-R1 regression: assert queues.ts wires
// batches_revise_chair with low reasoning while the deliberative draft
// step (batches_chair) and other high-reasoning deliberative steps keep
// their existing reasoning_effort. Also confirms truncated mid-string
// output remains fail-closed under the generic JSON-tail recovery.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tryCloseJsonTail } from "./audit-findings.ts";

const queuesSrc = await Deno.readTextFile(new URL("../boardroom-orchestrator/queues.ts", import.meta.url));

// Extract the request block that immediately follows a `step_key: "<key>"`
// line, so we can inspect each step's reasoning_effort independently.
function requestBlockFor(stepKey: string): string {
  const anchor = `step_key: "${stepKey}"`;
  const idx = queuesSrc.indexOf(anchor);
  assert(idx >= 0, `step_key ${stepKey} not found in queues.ts`);
  const reqIdx = queuesSrc.indexOf("request:", idx);
  assert(reqIdx > idx, `request block after ${stepKey} not found`);
  return queuesSrc.slice(reqIdx, reqIdx + 600);
}

Deno.test("queues.ts — batches_revise_chair uses low reasoning (bounded review/merge, not deliberative draft)", () => {
  const block = requestBlockFor("batches_revise_chair");
  assertStringIncludes(block, `reasoning_effort: "low"`);
  assert(
    !/reasoning_effort:\s*"high"/.test(block),
    `batches_revise_chair must NOT be reasoning_effort=high; live run 7bb72f5a truncated at that setting. Got: ${block}`,
  );
});

Deno.test("queues.ts — batches_chair (initial draft) still uses high reasoning", () => {
  const block = requestBlockFor("batches_chair");
  assertStringIncludes(block, `reasoning_effort: "high"`);
});

Deno.test("queues.ts — batches_revise_chair keeps the 8,000 output cap (no unrelated budget increase)", () => {
  const block = requestBlockFor("batches_revise_chair");
  assertStringIncludes(block, "max_tokens: 8000");
});

Deno.test("queues.ts — batches_chair & batches_revise_chair stamp _is_import so retry correction matches contract", () => {
  for (const key of ["batches_chair", "batches_revise_chair"]) {
    const block = requestBlockFor(key);
    assertStringIncludes(block, "_is_import: isImport");
  }
});

// Live run 7bb72f5a's response ended inside a quoted prompt_md string — the
// generic EOF closer recovery must refuse to auto-close, because appending
// closers over an open string would fabricate content. Fail-closed here is
// exactly what forces the bounded correction pass to run.
Deno.test("tryCloseJsonTail generic — refuses to close output that ended inside a quoted prompt_md string", () => {
  const truncated =
    '{"batches":[{"batch_no":1,"title":"Foundation","channel":"lovable","prompt_md":"Batch 1 — Foundation.\\n\\n1. Add src/routes/index.tsx with';
  const r = tryCloseJsonTail(truncated, { shape: "generic" });
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail generic — accepts already-valid batches JSON as-is (no rescue needed)", () => {
  const doc = { batches: [{ batch_no: 1, title: "t", channel: "human", prompt_md: "p" }] };
  const r = tryCloseJsonTail(JSON.stringify(doc), { shape: "generic" });
  assert(r.ok, `expected ok, got: ${JSON.stringify(r)}`);
  if (r.ok) assertEquals(r.closed, "");
});
