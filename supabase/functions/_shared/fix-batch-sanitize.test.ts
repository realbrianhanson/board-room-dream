// Regression tests for sanitizeFixPrompt — proves that fix batches
// derived from post-validation SUPPORTED P0/P1 findings never leak items
// tied to rejected/unpublished downgrade titles or file_paths.
//
// Run: cd supabase/functions && deno test _shared/fix-batch-sanitize.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sanitizeFixPrompt } from "./fix-batch-sanitize.ts";

// Observed live case: audit 9ced5102 emitted a two-item fix prompt whose
// first item was tied to a REJECTED "Invalid Supabase auth method
// getClaims" finding and whose second item was tied to the SUPPORTED
// batch-count-policy P1. The sanitized prompt must retain only the
// batch-count-policy item and must contain neither "auth-middleware" nor
// "getClaims".
Deno.test("sanitizeFixPrompt — drops rejected auth-middleware item, retains supported batch-count-policy item", () => {
  const rawPrompt = [
    "Batch 7.1 — Post-audit fixes.",
    "",
    "1. In `src/integrations/supabase/auth-middleware.ts` replace the invalid `supabase.auth.getClaims(token)` call with `supabase.auth.getUser(token)` to prevent the runtime crash.",
    "",
    "2. In `supabase/functions/_shared/batch-count-policy.ts` remove the generic 'owner-unknown assumption: <what you assume and why>' directive from productStrategyContract and replace it with per-field missing-context language matching import-contract.ts.",
    "",
    "Acceptance checks:",
    "1. Grep confirms `getClaims` is no longer present in src/integrations/supabase/auth-middleware.ts.",
    "2. Grep confirms 'owner-unknown assumption' is no longer present in supabase/functions/_shared/batch-count-policy.ts.",
    "",
    "Keep everything else identical.",
    "Typecheck when done.",
  ].join("\n");

  const result = sanitizeFixPrompt(
    rawPrompt,
    [
      {
        title: "Missing owner-unknown assumption boundary in productStrategyContract",
        file_path: "supabase/functions/_shared/batch-count-policy.ts",
      },
    ],
    [
      {
        title: "Invalid Supabase auth method getClaims causes runtime crash",
        file_path: "src/integrations/supabase/auth-middleware.ts",
      },
    ],
  );

  assertEquals(result.reason, "ok");
  assertEquals(result.keptItemCount, 1);
  assertEquals(result.droppedRejected, 1);
  assert(result.prompt, "expected a sanitized prompt");
  const out = result.prompt!;
  assert(!/getClaims/i.test(out), `sanitized prompt still mentions getClaims: ${out}`);
  assert(!/auth-middleware/i.test(out), `sanitized prompt still mentions auth-middleware: ${out}`);
  assert(/batch-count-policy\.ts/.test(out), "sanitized prompt should still reference the supported file");
  // Retained item is renumbered as 1.
  assert(/^1\.\s/m.test(out), "retained item should be numbered 1.");
  // Footer preserved.
  assert(/Keep everything else identical\./.test(out));
  assert(/Typecheck when done\./.test(out));
});

Deno.test("sanitizeFixPrompt — all items rejected/unmatched returns null (no batch inserted)", () => {
  const rawPrompt = [
    "Batch 7.1 — Post-audit fixes.",
    "",
    "1. In `src/integrations/supabase/auth-middleware.ts` fix getClaims.",
    "",
    "Acceptance checks:",
    "1. Grep confirms getClaims is gone.",
    "",
    "Keep everything else identical.",
    "Typecheck when done.",
  ].join("\n");

  const result = sanitizeFixPrompt(
    rawPrompt,
    [{ title: "Unrelated supported finding", file_path: "src/lib/unrelated.ts" }],
    [{ title: "Invalid Supabase auth method getClaims causes runtime crash", file_path: "src/integrations/supabase/auth-middleware.ts" }],
  );
  assertEquals(result.prompt, null);
  assertEquals(result.keptItemCount, 0);
  assertEquals(result.droppedRejected, 1);
  assertEquals(result.reason, "no_items_retained");
});

Deno.test("sanitizeFixPrompt — no supported findings returns null (no batch inserted)", () => {
  const rawPrompt = "Batch 1 — x.\n\n1. Do something.\n\nAcceptance checks:\n1. Done.\n\nKeep everything else identical.\nTypecheck when done.";
  const result = sanitizeFixPrompt(rawPrompt, [], [{ title: "x", file_path: "x.ts" }]);
  assertEquals(result.prompt, null);
  assertEquals(result.reason, "no_supported");
});

Deno.test("sanitizeFixPrompt — multiple supported items retained and renumbered", () => {
  const rawPrompt = [
    "Batch 3.1 — Fixes.",
    "",
    "1. Update src/lib/alpha.ts to correct the calc.",
    "2. In src/integrations/supabase/auth-middleware.ts fix getClaims.",
    "3. In src/lib/beta.ts adjust the guard.",
    "4. Random unmatched task with no cited file.",
    "",
    "Acceptance checks:",
    "1. src/lib/alpha.ts test passes.",
    "2. src/lib/beta.ts test passes.",
    "3. getClaims removed.",
    "",
    "Keep everything else identical.",
    "Typecheck when done.",
  ].join("\n");

  const result = sanitizeFixPrompt(
    rawPrompt,
    [
      { title: "alpha calc bug", file_path: "src/lib/alpha.ts" },
      { title: "beta guard drift", file_path: "src/lib/beta.ts" },
    ],
    [
      { title: "Invalid Supabase auth method getClaims causes runtime crash", file_path: "src/integrations/supabase/auth-middleware.ts" },
    ],
  );
  assertEquals(result.reason, "ok");
  assertEquals(result.keptItemCount, 2);
  assertEquals(result.droppedRejected, 1);
  assertEquals(result.droppedUnmatched, 1);
  const out = result.prompt!;
  assert(/^1\.\s.*alpha\.ts/m.test(out));
  assert(/^2\.\s.*beta\.ts/m.test(out));
  assert(!/getClaims/i.test(out));
  assert(!/auth-middleware/i.test(out));
  assert(!/Random unmatched task/.test(out));
  // Acceptance filtered to supported-only.
  assert(/Acceptance checks:\n1\.\s.*alpha\.ts/.test(out));
  assert(/2\.\s.*beta\.ts/.test(out));
  assert(!/getClaims removed/.test(out));
});

Deno.test("sanitizeFixPrompt — empty raw prompt returns null", () => {
  const result = sanitizeFixPrompt("", [{ title: "x", file_path: "x.ts" }], []);
  assertEquals(result.prompt, null);
  assertEquals(result.reason, "empty_input");
});

Deno.test("sanitizeFixPrompt — synthesizes generic acceptance when none survive", () => {
  const rawPrompt = [
    "Batch 2.1 — Fixes.",
    "",
    "1. Update src/lib/alpha.ts.",
    "",
    "Acceptance checks:",
    "1. getClaims removed from auth-middleware.",
    "",
    "Keep everything else identical.",
    "Typecheck when done.",
  ].join("\n");
  const result = sanitizeFixPrompt(
    rawPrompt,
    [{ title: "alpha calc bug", file_path: "src/lib/alpha.ts" }],
    [{ title: "getClaims", file_path: "src/integrations/supabase/auth-middleware.ts" }],
  );
  assertEquals(result.reason, "ok");
  const out = result.prompt!;
  assert(/Acceptance checks:\n1\.\s+Verify each numbered fix/.test(out));
  assert(!/getClaims/i.test(out));
});
