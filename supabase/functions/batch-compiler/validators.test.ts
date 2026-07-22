// Deterministic tests for the F1 compile-authority guards.
// Run: cd supabase/functions && deno test batch-compiler/validators.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  batchAuthorityError,
  detectUnsafeCommands,
  looksLikeUnrelatedCiScope,
  shapeError,
  titleSemanticallyMatches,
  type Parsed,
} from "./validators.ts";

const currentBatch = {
  title: "Schema Additions & Shared Modules",
  channel: "supabase",
  batch_no: 1,
};

function baseValid(): Parsed {
  return {
    status: "ready",
    compiled_prompt_md:
      "# Batch 1 — Schema Additions & Shared Modules\n\n1. Add columns to public.audit_findings.\n2. Create RPC public.mark_finding_dismissed.\n\nKeep everything else identical.\nTypecheck when done.",
    primary_intent_summary: "Add schema columns and shared scanner helpers.",
    rationale: "Live repo already ships audit_findings; we extend it and add the RPC.",
    drift_notes: [],
    preserved_intents: ["Add columns to audit_findings", "Add mark_finding_dismissed RPC"],
    satisfied_items: [],
    added_prerequisites: [],
    touched_paths: [
      { path: "supabase/migrations/20260722_scanner.sql", action: "create", reason: "carry the new columns + RPC" },
      { path: "supabase/functions/_shared/scanner.ts", action: "create", reason: "shared scanner module" },
    ],
    evidence: [
      { claim: "audit_findings already exists", path: "supabase/functions/audit-runner/index.ts", detail: "queries audit_findings" },
    ],
  };
}

const fileTree = new Set([
  "supabase/functions/audit-runner/index.ts",
  "supabase/functions/batch-compiler/index.ts",
  "src/routes/_authenticated/audits.tsx",
  "package.json",
]);
const schemaObjects = new Set(["audit_findings", "batches", "profiles"]);

Deno.test("titleSemanticallyMatches — same title passes, substituted plan title fails", () => {
  assert(titleSemanticallyMatches("# Schema Additions & Shared Modules\n\n...", currentBatch.title));
  // The bug we're fixing — compiler swapped in "Mojibake Purge & CI Grep":
  assert(!titleSemanticallyMatches("# Mojibake Purge & CI Grep\n\n1. grep ...", currentBatch.title));
});

Deno.test("detectUnsafeCommands — flags '|| exit 0' regression exactly", () => {
  const unsafe = detectUnsafeCommands("Run: grep -r 'â' src/ || exit 0");
  assertEquals(unsafe.length, 1);
  assert(unsafe[0].includes("|| exit 0"));
  assertEquals(detectUnsafeCommands("Run: grep -r 'foo' src/").length, 0);
  assert(detectUnsafeCommands("build || true").length === 1);
});

Deno.test("looksLikeUnrelatedCiScope — flags package.json script scope without evidence", () => {
  const compiled = 'Add to package.json "scripts": { "check": "grep -r foo src/" }';
  assert(looksLikeUnrelatedCiScope(compiled, [{ claim: "x", path: "src/routes/a.tsx", detail: "y" }]));
  assert(!looksLikeUnrelatedCiScope(compiled, [{ claim: "x", path: "package.json", detail: "y" }]));
});

Deno.test("shapeError — accepts baseline valid Parsed", () => {
  assertEquals(shapeError(baseValid()), null);
});

Deno.test("F1: 6-batch current Runway vs older 12-batch plan cannot substitute scope", () => {
  const p = baseValid();
  p.compiled_prompt_md = "# Batch 1 — Mojibake Purge & CI Grep\n\n1. Add grep script to package.json.\n";
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && err.includes("semantically match"), `expected title-substitution error, got: ${err}`);
});

Deno.test("F1: existing DB object told to CREATE is rejected (must be ALTER/VERIFY/satisfied)", () => {
  const p = baseValid();
  p.compiled_prompt_md =
    "# Schema Additions & Shared Modules\n\n1. CREATE TABLE public.audit_findings (id uuid primary key);";
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && err.toLowerCase().includes("audit_findings"), `expected existing-object CREATE rejection, got: ${err}`);
});

Deno.test("F1: unrelated CI-script addition without CI evidence is blocked", () => {
  const p = baseValid();
  p.compiled_prompt_md =
    '# Schema Additions & Shared Modules\n\n1. Update package.json "scripts": { "check": "grep -r foo src/" }.';
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && /unrelated|package\.json/i.test(err), `expected unrelated-CI rejection, got: ${err}`);
});

Deno.test("F1: nonexistent UPDATE target blocks", () => {
  const p = baseValid();
  p.touched_paths = [{ path: "src/routes/does-not-exist.tsx", action: "update", reason: "?" }];
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && err.includes("does not exist"), `expected nonexistent UPDATE rejection, got: ${err}`);
});

Deno.test("F1: unsafe '|| exit 0' regression is rejected specifically", () => {
  const p = baseValid();
  p.compiled_prompt_md =
    "# Schema Additions & Shared Modules\n\n1. Run: grep -r 'â' src/ || exit 0";
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && err.includes("|| exit 0"), `expected unsafe-command rejection, got: ${err}`);
});

Deno.test("F1: valid intent-preserving compile reaches ready (no error)", () => {
  const err = batchAuthorityError(baseValid(), currentBatch, fileTree, { source: "github", schemaObjects });
  assertEquals(err, null);
});
