// BATCH-REVIEW-LOW-REASONING-R1 regression: batches_review_{inspector,contrarian}
// must run at low reasoning (bounded schema-validation review). Live run
// b67878e0 truncated Inspector at 2,486 output tokens / 301 chars because no
// explicit reasoning_effort was set and the provider default consumed the
// budget before the concise review JSON could finish. Chair draft stays high;
// revise stays low; caps unchanged; retries preserve low via spread of
// baseRequest in buildValidationRetryRequest.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tryCloseJsonTail } from "./audit-findings.ts";
import { buildValidationRetryRequest } from "./batch-context.ts";
import { correctionForStep } from "../boardroom-orchestrator/protocol.ts";

const queuesSrc = await Deno.readTextFile(new URL("../boardroom-orchestrator/queues.ts", import.meta.url));

// The two reviewer step keys are built from a shared rows.map(...) block
// keyed on `batches_review_${seat}`. Grab the surrounding request block so
// we can assert reasoning + cap on the shared config.
function reviewerRequestBlock(): string {
  const anchor = "step_key: `batches_review_${seat}`";
  const idx = queuesSrc.indexOf(anchor);
  assert(idx >= 0, "batches_review_${seat} step block not found in queues.ts");
  const reqIdx = queuesSrc.indexOf("request:", idx);
  assert(reqIdx > idx, "request block after batches_review_${seat} not found");
  return queuesSrc.slice(reqIdx, reqIdx + 1600);
}

function requestBlockFor(stepKey: string): string {
  const anchor = `step_key: "${stepKey}"`;
  const idx = queuesSrc.indexOf(anchor);
  assert(idx >= 0, `step_key ${stepKey} not found`);
  const reqIdx = queuesSrc.indexOf("request:", idx);
  return queuesSrc.slice(reqIdx, reqIdx + 1600);
}

Deno.test("queues.ts — batches_review_{inspector,contrarian} use low reasoning (shared block, both seats covered)", () => {
  const block = reviewerRequestBlock();
  assertStringIncludes(block, `reasoning_effort: "low"`);
  assert(
    !/reasoning_effort:\s*"high"/.test(block),
    `reviewer request must NOT be reasoning_effort=high (live run b67878e0 truncated at provider default). Got: ${block}`,
  );
  // The shared rows.map serves BOTH inspector and contrarian — the ["inspector", "contrarian"] tuple must still be there.
  assertStringIncludes(queuesSrc, `(["inspector", "contrarian"] as const).map`);
});

Deno.test("queues.ts — reviewer output cap unchanged at 2,500 (no unrelated budget increase)", () => {
  const block = reviewerRequestBlock();
  assertStringIncludes(block, "max_tokens: 2500");
});

Deno.test("queues.ts — batches_chair draft still high; batches_revise_chair still low (no cross-regression)", () => {
  const draft = requestBlockFor("batches_chair");
  assertStringIncludes(draft, `reasoning_effort: "high"`);
  const revise = requestBlockFor("batches_revise_chair");
  assertStringIncludes(revise, `reasoning_effort: "low"`);
});

Deno.test("buildValidationRetryRequest — reviewer retry preserves reasoning_effort:low from baseRequest (no provider-default fallback)", () => {
  const base = {
    json_output: true,
    temperature: 0.2,
    reasoning_effort: "low",
    max_tokens: 2500,
  };
  const res = buildValidationRetryRequest({
    stepKey: "batches_review_inspector",
    baseRequest: base,
    baseMessages: [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
    assistantContent: '{"issues":[{"severity":"minor","text":"unfinished',
    validationError: "truncated mid-string",
    truncated: true,
    correction: correctionForStep("batches_review_inspector"),
  });
  assertEquals((res.request as any).reasoning_effort, "low");
  assertEquals((res.request as any).max_tokens, 2500);
});

// Fail-closed guard for the exact live shape: JSON ended inside issue.text.
Deno.test("tryCloseJsonTail generic — refuses to close reviewer JSON truncated inside issue.text", () => {
  const truncated =
    '{"verdict":"revise","summary":"ok","issues":[{"severity":"minor","batch_no":1,"text":"prompt_md refers to src/routes/index.tsx but the';
  const r = tryCloseJsonTail(truncated, { shape: "generic" });
  assertEquals(r.ok, false);
});

Deno.test("tryCloseJsonTail generic — accepts already-valid reviewer JSON as-is", () => {
  const doc = { verdict: "approve", summary: "ok", issues: [] };
  const r = tryCloseJsonTail(JSON.stringify(doc), { shape: "generic" });
  assert(r.ok, `expected ok, got: ${JSON.stringify(r)}`);
  if (r.ok) assertEquals(r.closed, "");
});
