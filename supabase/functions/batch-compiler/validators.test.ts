// Deterministic tests for the F1 / F1b compile-authority guards.
// Run: cd supabase/functions && deno test batch-compiler/validators.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  batchAuthorityError,
  detectUnsafeCommands,
  findExistingCreateCollision,
  looksLikeUnrelatedCiScope,
  normalizeSqlIdent,
  shapeError,
  skeletonError,
  titleSemanticallyMatches,
  type Parsed,
} from "./validators.ts";

const currentBatch = {
  title: "Schema Additions & Shared Modules",
  channel: "supabase",
  batch_no: 1,
};
const codeBatch = { title: "Runway Safety Gate UI", channel: "code", batch_no: 5 };

const validSupabaseSkeleton = [
  "Batch 1 — Schema Additions & Shared Modules. Numbered items only, no scope creep.",
  "",
  "1. ALTER TABLE public.audit_findings ADD COLUMN reviewer text; keep existing columns intact.",
  "2. ALTER FUNCTION public.has_role(uuid, app_role) STABLE; leave signature unchanged.",
  "3. VERIFY that public.batches has the compiled_prompt_md column already added in an earlier migration.",
  "4. Add a supabase/functions/_shared/scanner.ts module exporting scan() and consumed by audit-runner/index.ts.",
  "",
  "Notes:",
  "- The DB inventory already lists audit_findings, batches, and has_role — do not re-create them.",
  "- The migration must run cleanly on the current live schema without duplicate-object errors.",
  "- Do not touch profiles, cohorts, or api_keys in this batch.",
  "- Keep imports and existing RLS policies unchanged; only additive changes are in scope for this batch and no client-facing routes should shift.",
  "- The compiled migration should run in a single transaction and be idempotent under session_replication_role=replica for local restores.",
  "",
  "Keep everything else identical.",
  "Typecheck when done.",
].join("\n");

function baseValid(): Parsed {
  return {
    status: "ready",
    compiled_prompt_md: validSupabaseSkeleton,
    primary_intent_summary: "Add schema columns and shared scanner helpers.",
    rationale: "Live repo already ships audit_findings; we extend it and add the RPC.",
    drift_notes: [],
    preserved_intents: ["Extend audit_findings", "Add scanner module"],
    satisfied_items: [],
    added_prerequisites: [],
    touched_paths: [
      { path: "supabase/migrations/20260722_scanner.sql", action: "create", reason: "carry the new columns" },
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
  "src/routes/_authenticated/runway_.$projectId.tsx",
  "package.json",
]);
const schemaObjects = new Set(["audit_findings", "batches", "profiles", "has_role", "mark_finding_dismissed"]);

Deno.test("titleSemanticallyMatches — same title passes, substituted plan title fails", () => {
  assert(titleSemanticallyMatches("Schema Additions & Shared Modules\n\n...", currentBatch.title));
  assert(!titleSemanticallyMatches("Mojibake Purge & CI Grep\n\n1. grep ...", currentBatch.title));
});

Deno.test("detectUnsafeCommands — flags '|| exit 0' regression exactly", () => {
  const unsafe = detectUnsafeCommands("Run: grep -r 'â' src/ || exit 0");
  assertEquals(unsafe.length, 1);
  assert(unsafe[0].includes("|| exit 0"));
  assertEquals(detectUnsafeCommands("Run: grep -r 'foo' src/").length, 0);
  assertEquals(detectUnsafeCommands("build || true").length, 1);
});

Deno.test("looksLikeUnrelatedCiScope — flags package.json script scope without evidence", () => {
  const compiled = 'Add to package.json "scripts": { "check": "grep -r foo src/" }';
  assert(looksLikeUnrelatedCiScope(compiled, [{ claim: "x", path: "src/routes/a.tsx", detail: "y" }]));
  assert(!looksLikeUnrelatedCiScope(compiled, [{ claim: "x", path: "package.json", detail: "y" }]));
});

Deno.test("shapeError — accepts baseline valid Parsed", () => {
  assertEquals(shapeError(baseValid()), null);
});

Deno.test("normalizeSqlIdent — quoting + schema prefix collapse", () => {
  for (const v of ["audit_findings", "public.audit_findings", '"audit_findings"', "`audit_findings`", "PUBLIC.Audit_Findings", '"public"."audit_findings"'.replace('"public"."', "public.").replace('"',"")]) {
    assertEquals(normalizeSqlIdent(v.replace(/^"public"\./i, "public.")), "audit_findings", `normalize failed for ${v}`);
  }
});

Deno.test("findExistingCreateCollision — SQL variants collide", () => {
  const variants = [
    "CREATE TABLE public.audit_findings (id uuid);",
    "CREATE TABLE audit_findings (id uuid);",
    'CREATE TABLE "audit_findings" (id uuid);',
    "CREATE TABLE `audit_findings` (id uuid);",
    "CREATE TABLE IF NOT EXISTS public.audit_findings (id uuid);",
    "CREATE OR REPLACE FUNCTION public.has_role(_u uuid, _r app_role) RETURNS boolean AS $$ $$;",
  ];
  for (const v of variants) {
    const hit = findExistingCreateCollision(v, schemaObjects);
    assert(hit, `expected collision for: ${v}`);
    assert(schemaObjects.has(hit!.name), `bad hit for ${v} → ${hit?.name}`);
  }
});

Deno.test("findExistingCreateCollision — narrative 'Create a Postgres RPC name(...)' collides", () => {
  const hit = findExistingCreateCollision(
    "Then Create a Postgres RPC mark_finding_dismissed(finding_id uuid) that toggles status.",
    schemaObjects,
  );
  assert(hit, "narrative RPC create should collide");
  assertEquals(hit!.name, "mark_finding_dismissed");
});

Deno.test("F1: 6-batch current Runway vs older 12-batch plan cannot substitute scope", () => {
  const p = baseValid();
  p.compiled_prompt_md = validSupabaseSkeleton.replace(
    "Schema Additions & Shared Modules",
    "Mojibake Purge & CI Grep",
  );
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && err.toLowerCase().includes("semantically"), `expected title-substitution error, got: ${err}`);
});

Deno.test("F1b: existing DB object told to CREATE is rejected (public.audit_findings + variants)", () => {
  for (const stmt of [
    "1. CREATE TABLE public.audit_findings (id uuid primary key);",
    "1. CREATE TABLE audit_findings (id uuid);",
    '1. CREATE TABLE "audit_findings" (id uuid);',
    "1. CREATE TABLE `audit_findings` (id uuid);",
    "1. Create a Postgres RPC has_role(_u uuid, _r app_role) that returns boolean.",
  ]) {
    const p = baseValid();
    p.compiled_prompt_md = validSupabaseSkeleton.replace(
      "1. ALTER TABLE public.audit_findings ADD COLUMN reviewer text; keep existing columns intact.",
      stmt,
    );
    const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
    assert(err && /already exists in the live database/i.test(err), `expected CREATE collision on: ${stmt} → got: ${err}`);
  }
});

Deno.test("F1: unrelated CI-script addition without CI evidence is blocked", () => {
  const p = baseValid();
  p.compiled_prompt_md = validSupabaseSkeleton.replace(
    "3. VERIFY that public.batches has the compiled_prompt_md column already added in an earlier migration.",
    '3. Update package.json "scripts": { "check": "grep -r foo src/" } to scan the whole repo.',
  );
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
  p.compiled_prompt_md = validSupabaseSkeleton.replace(
    "3. VERIFY that public.batches has the compiled_prompt_md column already added in an earlier migration.",
    "3. Run: grep -r 'â' src/ || exit 0",
  );
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github", schemaObjects });
  assert(err && err.includes("|| exit 0"), `expected unsafe-command rejection, got: ${err}`);
});

Deno.test("F1: valid intent-preserving compile reaches ready (no error)", () => {
  const err = batchAuthorityError(baseValid(), currentBatch, fileTree, { source: "github", schemaObjects });
  assertEquals(err, null);
});

Deno.test("F1b skeleton: bad first-line format blocks", () => {
  const bad = "# Batch 1: Schema Additions\n\n1. do the thing\n\nKeep everything else identical.\nTypecheck when done.";
  const err = skeletonError(bad, currentBatch);
  assert(err && err.startsWith("compiled_prompt_md too short") || err && err.includes("First line"), `got: ${err}`);
});

Deno.test("F1b skeleton: missing closing footer blocks", () => {
  const bad = validSupabaseSkeleton.replace("Keep everything else identical.\nTypecheck when done.", "Ship it.");
  const err = skeletonError(bad, currentBatch);
  assert(err && err.includes("Keep everything else identical"), `got: ${err}`);
});

Deno.test("F1b skeleton: code batch requires 2–4 Acceptance checks", () => {
  const withoutAccept = [
    "Batch 5 — Runway Safety Gate UI. Numbered items only, no scope creep.",
    "",
    "1. In src/routes/_authenticated/runway_.$projectId.tsx, hide uncompiled prompts behind a disclosure.",
    "2. Disable the Copy button until compile status is 'ready'.",
    "3. Disable Mark sent until compile status is 'ready'.",
    "4. Show a small blocked/already_done rationale beneath each batch card.",
    "5. Add a keyboard-accessible focus ring to the Copy control for AA contrast.",
    "6. Keep all sidebar and header layout untouched.",
    "",
    "Keep everything else identical.",
    "Typecheck when done.",
  ].join("\n");
  const err = skeletonError(withoutAccept, codeBatch);
  assert(err && err.includes("Acceptance"), `expected acceptance error, got: ${err}`);
});

Deno.test("F1b skeleton: too short blocks", () => {
  const short = "Batch 1 — Schema Additions. Numbered items only, no scope creep.\n\n1. do x.\n\nKeep everything else identical.\nTypecheck when done.";
  const err = skeletonError(short, currentBatch);
  assert(err && err.includes("too short"), `got: ${err}`);
});
