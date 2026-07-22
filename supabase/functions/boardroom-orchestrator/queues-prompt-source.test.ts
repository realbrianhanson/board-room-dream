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

// R3 — owner-authority coverage test. Every direct `admin.from("run_steps").insert`
// in queues.ts must be either (a) routed through queueSteps (which injects
// OWNER_AUTHORITY_RULES and verified owner sources) or (b) explicitly
// allow-listed in this test because it cannot introduce executable scope
// (pure extraction, pipeline-health smoke test, or audit-merge over
// pre-normalized findings). Adding a new decision/generative direct insert
// without also documenting it here MUST fail this test.
Deno.test("queues.ts — no unaudited direct run_steps insert may introduce scope", () => {
  // Only these direct-insert step keys are allowed to exist in queues.ts.
  // Every other step must go through queueSteps.
  const allowedDirectInsertStepKeys = (key: string): boolean => {
    // Pure extraction — lifts already-produced Chair fields into structured JSON.
    if (/^r3_extract_chair_loop/.test(key)) return true;
    // Pure extraction — lifts ## Features H2 out of Chair PRD.
    if (key === "r5_blueprint_extract_chair") return true;
    // Pipeline-health smoke test — canned single-user message, no scope.
    if (key === "r1_test_chair") return true;
    // Chair audit merge over prose-stripped seat findings only.
    if (key === "audit_chair_merge") return true;
    return false;
  };

  const directInsertRegex = /admin\.from\("run_steps"\)\.insert\(/g;
  const matches = queuesSrc.match(directInsertRegex) ?? [];
  // 1 helper wrapper definition + N call sites. The wrapper is on line ~104
  // ("return admin.from..."). Count the call sites separately.
  const callSiteMatches = queuesSrc.match(/^\s+await admin\.from\("run_steps"\)\.insert\(/gm) ?? [];
  assert(matches.length >= callSiteMatches.length, "regex counting sanity");

  // Every direct-insert call site must have a step_key on the inserted row
  // (or be the rows-array form used by queueChangeRequestExam, which we
  // already routed through queueSteps). Extract step_key strings that appear
  // near each direct-insert call site by scanning forward from each match.
  const src = queuesSrc;
  let cursor = 0;
  const found: string[] = [];
  while (true) {
    const idx = src.indexOf('admin.from("run_steps").insert(', cursor);
    if (idx === -1) break;
    cursor = idx + 1;
    // Skip the helper wrapper definition itself (line 104: `return admin...`).
    const before = src.slice(Math.max(0, idx - 80), idx);
    if (/return\s+$/.test(before)) continue;
    // Skip prose mentions of the helper inside comments (line starts with `//`).
    const lineStart = src.lastIndexOf("\n", idx) + 1;
    const lineLead = src.slice(lineStart, idx);
    if (/^\s*(\/\/|\*)/.test(lineLead)) continue;
    const window = src.slice(idx, idx + 800);
    const m = window.match(/step_key:\s*["`]([^"`]+)["`]/);
    if (m) found.push(m[1]);
    else found.push("(no-step-key-detected)");
  }

  for (const key of found) {
    assert(
      allowedDirectInsertStepKeys(key),
      `direct admin.from("run_steps").insert with step_key="${key}" is not allow-listed. ` +
      `Route it through queueSteps so OWNER_AUTHORITY_RULES + verified owner sources are injected, ` +
      `or add it to allowedDirectInsertStepKeys with a comment explaining why it cannot introduce scope.`,
    );
  }
});
