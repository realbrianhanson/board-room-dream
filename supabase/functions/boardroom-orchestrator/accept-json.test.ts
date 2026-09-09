// The shared JSON acceptance pipeline and the resume-time revalidation of a
// failed step's stored output.
// Run: cd supabase/functions && deno test boardroom-orchestrator/accept-json.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { acceptStepJson, REVALIDATE_ON_RESUME_ERRORS, revalidateStoredStep } from "./accept-json.ts";
import { codePrompt } from "./test-fixtures.ts";

// The dd1e502e shape: six code batches, the sixth 2,675 characters.
function liveDraft() {
  const batches = [1, 2, 3, 4, 5].map((n) => ({ batch_no: n, title: `B${n}`, channel: "lovable", prompt_md: codePrompt(n, 1900) }));
  batches.push({ batch_no: 6, title: "B6", channel: "lovable", prompt_md: codePrompt(6, 2675) });
  return { batches };
}

const failedRow = (overrides: Record<string, unknown> = {}) => ({
  step_key: "batches_chair",
  status: "failed",
  error: "invalid_json_after_correction",
  response_text: JSON.stringify(liveDraft()),
  response_json: { _meta: { finish_reason: "stop", tokens_out: 4100, reasoning_tokens: 10, wire_max_tokens: 9500, fallback: { from: "primary", to: "reserve" } } },
  ...overrides,
});

Deno.test("acceptStepJson — strict JSON: normalized value, no recovery markers, no warning", () => {
  const acc = acceptStepJson("batches_chair", JSON.stringify(liveDraft()), "batches", { attempt: 0 });
  assertEquals(acc.error, null);
  assert(acc.candidate && acc.value);
  assertEquals(acc.value.batches.length, 6);
  assertEquals(acc.tailClosed, null);
  assertEquals(acc.recoveryMode, null);
  assertEquals(acc.lengthWarning, []);
});

Deno.test("acceptStepJson — fenced / prose-wrapped answers are extracted and still validated", () => {
  const wrapped = "Here is the JSON:\n```json\n" + JSON.stringify(liveDraft()) + "\n```\nDone.";
  const acc = acceptStepJson("batches_chair", wrapped, "batches", { attempt: 0 });
  assertEquals(acc.error, null);
  assert(acc.recoveryMode, "a recovery mode is recorded");
  assertEquals(acc.value.batches.length, 6);
});

Deno.test("acceptStepJson — a redundant trailing closer is recovered before the tail closer", () => {
  const acc = acceptStepJson("batches_chair", JSON.stringify(liveDraft()) + "\n}", "batches", { attempt: 0 });
  assertEquals(acc.error, null);
  assertEquals(acc.recoveryMode, "trailing_redundant_closer");
});

Deno.test("acceptStepJson — a missing outer closer is balanced and the value validated", () => {
  const text = JSON.stringify(liveDraft()).slice(0, -1);
  const acc = acceptStepJson("batches_chair", text, "batches", { attempt: 0 });
  assertEquals(acc.error, null);
  assertEquals(acc.tailClosed, "}");
});

Deno.test("acceptStepJson — unparseable text: null candidate, the parse error", () => {
  const acc = acceptStepJson("batches_chair", "not json at all", "batches", { attempt: 0 });
  assertEquals(acc.candidate, null);
  assertEquals(acc.value, null);
  assertEquals(acc.error, "Response was not parseable JSON.");
});

Deno.test("acceptStepJson — the attempt decides the soft length rule and the warning", () => {
  const draft = liveDraft();
  draft.batches[2].prompt_md = codePrompt(3, 3400);
  const first = acceptStepJson("batches_chair", JSON.stringify(draft), "batches", { attempt: 0 });
  assertStringIncludes(String(first.error), "Batch 3 prompt_md is 3400 chars");
  const second = acceptStepJson("batches_chair", JSON.stringify(draft), "batches", { attempt: 1 });
  assertEquals(second.error, null);
  assertEquals(second.lengthWarning, [{ batch_no: 3, chars: 3400 }]);
});

Deno.test("revalidateStoredStep — the dd1e502e row (6 batches, one at 2,675 chars) now completes from its stored text", () => {
  const r = revalidateStoredStep(failedRow(), "batches");
  assert(r.ok, `expected a pass, got ${r.ok ? "" : r.reason}`);
  const json = r.response_json as any;
  assertEquals(json.batches.length, 6);
  assertEquals(json.batches[5].prompt_md.length, 2675);
  // _meta.revalidated is merged INTO the failed row's _meta, not over it.
  assertEquals(json._meta.revalidated, true);
  assertEquals(json._meta.finish_reason, "stop");
  assertEquals(json._meta.fallback, { from: "primary", to: "reserve" });
  assertEquals(json._meta.length_warning, undefined, "2,675 is inside the silent band — no warning");
});

Deno.test("revalidateStoredStep — attempt 1 semantics: a batch above 3,200 is accepted with length_warning", () => {
  const draft = liveDraft();
  draft.batches[0].prompt_md = codePrompt(1, 3250);
  const r = revalidateStoredStep(failedRow({ response_text: JSON.stringify(draft) }), "batches");
  assert(r.ok);
  assertEquals((r.response_json as any)._meta.length_warning, [{ batch_no: 1, chars: 3250 }]);
});

Deno.test("revalidateStoredStep — a truly truncated text still falls through", () => {
  const cut = JSON.stringify(liveDraft()).slice(0, 4000);
  const r = revalidateStoredStep(failedRow({ error: "truncated_after_correction", response_text: cut }), "batches");
  assertEquals(r.ok, false);
  assert(!r.ok && r.reason);
});

Deno.test("revalidateStoredStep — a budget-cut draft that tail-closes below the contract minimum falls through", () => {
  // Cut right after batch 3's closing brace: the tail closer balances it to
  // a valid-looking 3-batch plan, but a greenfield run needs 6.
  const full = JSON.stringify(liveDraft());
  const cut = full.slice(0, full.indexOf(',{"batch_no":4'));
  const greenfield = revalidateStoredStep(failedRow({ error: "truncated_after_correction", response_text: cut }), "batches");
  assertEquals(greenfield.ok, false);
  assert(!greenfield.ok && /3 complete entries — minimum 6/.test(greenfield.reason), `got: ${!greenfield.ok && greenfield.reason}`);
  // An import run's minimum is 3, so the same cut completes with tail_closed recorded.
  const imported = revalidateStoredStep(failedRow({ error: "truncated_after_correction", response_text: cut, request: { _is_import: true } }), "batches");
  assert(imported.ok, `expected a pass, got ${imported.ok ? "" : imported.reason}`);
  assertEquals((imported.response_json as any).batches.length, 3);
  assertEquals((imported.response_json as any)._meta.tail_closed, "]}");
  // The same cut on a row that was NOT flagged truncated keeps the plain pipeline verdict.
  const plain = revalidateStoredStep(failedRow({ error: "invalid_json_after_correction", response_text: cut }), "batches");
  assert(plain.ok);
  // A single-judgment step is never completed in part.
  const vote = revalidateStoredStep(
    failedRow({ step_key: "cr_verdict_chair", error: "truncated_after_correction", response_text: '{"verdict":"rejected","rationale":"no"' }),
    "plan",
  );
  assertEquals(vote.ok, false);
  assert(!vote.ok && /cannot be completed in part/.test(vote.reason));
});

Deno.test("revalidateStoredStep — a stored draft that breaks a hard rule still falls through", () => {
  const draft = liveDraft();
  draft.batches[3].prompt_md = codePrompt(4, 800);
  const r = revalidateStoredStep(failedRow({ response_text: JSON.stringify(draft) }), "batches");
  assertEquals(r.ok, false);
  assert(!r.ok && /Batch 4 prompt_md is 800 chars/.test(r.reason), `got: ${!r.ok && r.reason}`);
});

Deno.test("revalidateStoredStep — only validation failures with stored text are re-judged", () => {
  assertEquals(revalidateStoredStep(failedRow({ response_text: "" }), "batches").ok, false);
  assertEquals(revalidateStoredStep(failedRow({ response_text: null }), "batches").ok, false);
  assertEquals(revalidateStoredStep(failedRow({ error: "cancelled_parent_terminal" }), "batches").ok, false);
  assertEquals(revalidateStoredStep(failedRow({ error: "Proxy timeout after 105s" }), "batches").ok, false);
  assertEquals(revalidateStoredStep(failedRow({ error: null }), "batches").ok, false);
  assertEquals([...REVALIDATE_ON_RESUME_ERRORS].sort(), ["invalid_json_after_correction", "truncated_after_correction"]);
});

Deno.test("revalidateStoredStep — recovery markers ride along on _meta", () => {
  const r = revalidateStoredStep(failedRow({ response_text: "```json\n" + JSON.stringify(liveDraft()) + "\n```" }), "batches");
  assert(r.ok);
  assert((r.response_json as any)._meta.recovery_mode, "recovery_mode recorded");
  assertEquals((r.response_json as any)._meta.revalidated, true);
});

Deno.test("index.ts — executeStep and both resume paths share the pipeline", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals((src.match(/acceptStepJson\(/g) ?? []).length, 1, "exactly one call, in executeStep");
  assert(!src.includes("tryRecoverTrailingRedundantCloser("), "the inline recovery chain moved to accept-json.ts");
  assert(!src.includes("extractJsonCandidate("), "the inline extraction moved to accept-json.ts");
  assertEquals((src.match(/completeStepFromStoredOutput\(admin, run, st(ep)?\)/g) ?? []).length, 2, "resume_failed and retry_step both revalidate first");
  assertStringIncludes(src, 'validateStepJson("batches_revise_chair", revise.response_json, run.kind, { attempt: 1 })');
});
