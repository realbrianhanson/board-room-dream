// Soft batch prompt length rule (live run dd1e502e: a 2,675-char code batch
// failed the run under the old hard 2,600 cap after the one correction pass
// returned the same answer).
// Run: cd supabase/functions && deno test boardroom-orchestrator/batch-prompt-length.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  batchPromptLengthVerdict,
  batchPromptLengthWarnings,
  CODE_PROMPT_HARD_MAX_CHARS,
  CODE_PROMPT_TARGET_MAX_CHARS,
  correctionForStep,
  normalizeStepJson,
  validateStepJson,
} from "./protocol.ts";
import { codePrompt } from "./test-fixtures.ts";

Deno.test("batchPromptLengthVerdict — code: 900-3,200 accepted silently on any attempt", () => {
  for (const attempt of [0, 1]) {
    for (const chars of [900, 1800, 2600, 2675, 3200]) {
      assertEquals(batchPromptLengthVerdict("lovable", chars, attempt, 6), { ok: true }, `lovable ${chars} attempt ${attempt}`);
      assertEquals(batchPromptLengthVerdict("supabase", chars, attempt, 6), { ok: true }, `supabase ${chars} attempt ${attempt}`);
    }
  }
});

Deno.test("batchPromptLengthVerdict — code: under 900 is always an error", () => {
  for (const attempt of [0, 1, 2]) {
    const v = batchPromptLengthVerdict("lovable", 899, attempt, 2);
    assertEquals(v.ok, false);
    assertStringIncludes(String(v.error), "Batch 2 prompt_md is 899 chars");
    assertStringIncludes(String(v.error), "900-2,600 characters (hard maximum 3,200)");
  }
});

Deno.test("batchPromptLengthVerdict — code: above 3,200 fails the first attempt, warns on the correction attempt", () => {
  const first = batchPromptLengthVerdict("lovable", 3201, 0, 4);
  assertEquals(first.ok, false);
  assertStringIncludes(String(first.error), "Batch 4 prompt_md is 3201 chars");
  const second = batchPromptLengthVerdict("lovable", 3201, 1, 4);
  assertEquals(second, { ok: true, warning: { batch_no: 4, chars: 3201 } });
  assertEquals(batchPromptLengthVerdict("supabase", 5000, 2, 1), { ok: true, warning: { batch_no: 1, chars: 5000 } });
});

Deno.test("batchPromptLengthVerdict — human keeps its 300-2,400 shape with the same soft treatment", () => {
  assertEquals(batchPromptLengthVerdict("human", 300, 0, 1), { ok: true });
  assertEquals(batchPromptLengthVerdict("human", 2400, 0, 1), { ok: true });
  const short = batchPromptLengthVerdict("human", 299, 1, 1);
  assertEquals(short.ok, false);
  assertStringIncludes(String(short.error), "human batches must be 300-2,400 characters");
  assertEquals(batchPromptLengthVerdict("human", 2401, 0, 3).ok, false);
  assertEquals(batchPromptLengthVerdict("human", 2401, 1, 3), { ok: true, warning: { batch_no: 3, chars: 2401 } });
});

Deno.test("validateStepJson — the dd1e502e draft: six code batches, batch 6 at 2,675 chars, passes on the first attempt", () => {
  const batches = [1, 2, 3, 4, 5].map((n) => ({ batch_no: n, title: `B${n}`, channel: "lovable", prompt_md: codePrompt(n, 1800) }));
  batches.push({ batch_no: 6, title: "B6", channel: "supabase", prompt_md: codePrompt(6, 2675) });
  assertEquals(batches[5].prompt_md.length, 2675);
  assertEquals(validateStepJson("batches_chair", { batches }), null);
  assertEquals(validateStepJson("batches_revise_chair", { batches }, "batches", { attempt: 0 }), null);
  assertEquals(batchPromptLengthWarnings("batches_chair", { batches }, 0), []);
  assertEquals(batchPromptLengthWarnings("batches_chair", { batches }, 1), []);
});

Deno.test("validateStepJson — a code batch above the hard maximum: error on attempt 0, accepted with a warning on attempt 1", () => {
  const batches = [1, 2, 3].map((n) => ({ batch_no: n, title: `B${n}`, channel: "lovable", prompt_md: codePrompt(n, 1200) }));
  batches[1].prompt_md = codePrompt(2, CODE_PROMPT_HARD_MAX_CHARS + 100);
  const first = validateStepJson("batches_chair", { batches });
  assert(first && /Batch 2 prompt_md is 3300 chars/.test(first), `expected the batch-2 length error, got: ${first}`);
  assertEquals(validateStepJson("batches_chair", { batches }, "batches", { attempt: 0 }), first);
  assertEquals(validateStepJson("batches_chair", { batches }, "batches", { attempt: 1 }), null);
  assertEquals(batchPromptLengthWarnings("batches_chair", { batches }, 1), [{ batch_no: 2, chars: 3300 }]);
  // normalizeStepJson threads the same opts.
  assertEquals(normalizeStepJson("batches_chair", { batches }, "batches", { attempt: 1 }).error, null);
  assert(normalizeStepJson("batches_chair", { batches }, "batches").error);
});

Deno.test("validateStepJson — under 900 chars stays an error on every attempt", () => {
  const batches = [1, 2, 3].map((n) => ({ batch_no: n, title: `B${n}`, channel: "lovable", prompt_md: codePrompt(n, 1200) }));
  batches[2].prompt_md = codePrompt(3, 700);
  for (const attempt of [0, 1]) {
    const err = validateStepJson("batches_chair", { batches }, "batches", { attempt });
    assert(err && /Batch 3 prompt_md is 700 chars/.test(err), `attempt ${attempt}: expected the batch-3 error, got: ${err}`);
  }
});

Deno.test("validateStepJson — the other batch rules are unchanged (skeleton lines, channel enum, count)", () => {
  const batches = [1, 2, 3].map((n) => ({ batch_no: n, title: `B${n}`, channel: "lovable", prompt_md: codePrompt(n, 1200) }));
  const noTypecheck = batches.map((b) => ({ ...b, prompt_md: b.prompt_md.replace("Typecheck when done.", "") }));
  assertStringIncludes(String(validateStepJson("batches_chair", { batches: noTypecheck }, "batches", { attempt: 1 })), "Typecheck when done");
  const badChannel = batches.map((b, i) => (i === 0 ? { ...b, channel: "github" } : b));
  assertStringIncludes(String(validateStepJson("batches_chair", { batches: badChannel }, "batches", { attempt: 1 })), "channel");
  assertStringIncludes(String(validateStepJson("batches_chair", { batches: batches.slice(0, 2) }, "batches", { attempt: 1 })), "3-8");
});

Deno.test("batchPromptLengthWarnings — nothing for non-batch steps or malformed input", () => {
  assertEquals(batchPromptLengthWarnings("r4_vote_chair_loop0", { batches: [{ channel: "lovable", prompt_md: "x".repeat(4000) }] }, 1), []);
  assertEquals(batchPromptLengthWarnings("batches_chair", null, 1), []);
  assertEquals(batchPromptLengthWarnings("batches_chair", { batches: [null, { channel: "lovable" }] }, 1), []);
});

Deno.test("correction copy states the target range and the hard maximum", () => {
  const c = correctionForStep("batches_chair");
  assertStringIncludes(c, `900-${CODE_PROMPT_TARGET_MAX_CHARS.toLocaleString("en-US")} characters (hard maximum 3,200)`);
});
