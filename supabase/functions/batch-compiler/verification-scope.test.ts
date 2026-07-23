// PROMPT-CONTRACT-R5 (2026-07-23): verification prompt must be layer-scope-aware
// and must never contain a test-weakening directive. The exact regression is the
// live Batch 1 "Security Hardening (RLS Proofs)" batch whose only touched path
// is supabase/tests/rls_proofs.sql; its compiler-produced verification prompt
// incorrectly required edge-function/RPC invocations and told Lovable to "fix
// the tests to match the existing RLS policies" — both must now be rejected.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  batchAuthorityError,
  classifyBatchLayer,
  verificationScopeError,
  verificationWeakeningError,
  type Parsed,
} from "./validators.ts";

const CLOSE = "\nKeep everything else identical.\nTypecheck when done.";
const filler = "narrative filler to pad the compiled prompt to at least 900 chars for skeleton validation. ".repeat(12);

const pgtapSkeleton = [
  "Batch 1 — Security Hardening (RLS Proofs). Numbered items only, no scope creep.",
  "",
  "1. Add pgTAP tests in supabase/tests/rls_proofs.sql covering owner SELECT on public.projects (positive) and anon/cross-tenant SELECT (negative).",
  "2. Do NOT modify any RLS policy, migration, or edge function in this batch.",
  "3. The migration harness must run pgTAP with `select * from runtests('rls_proofs');` and fail loudly on any assertion.",
  "",
  filler,
  "",
  "Acceptance:",
  "1. Run the pgTAP suite; owner SELECT succeeds (positive RLS case).",
  "2. Anon and cross-tenant SELECT return zero rows (negative RLS case).",
  CLOSE,
].join("\n");

function baseBatch1Ready(): Parsed {
  return {
    status: "ready",
    compiled_prompt_md: pgtapSkeleton,
    compiled_verification_prompt_md: [
      "Verify Batch 1 after implementation. Do not change product scope.",
      "Run the pgTAP suite in supabase/tests/rls_proofs.sql via `select * from runtests('rls_proofs');`.",
      "Confirm the positive owner case (SELECT as owner returns the row) AND the negative anon / cross-tenant case (SELECT returns zero rows).",
      "The RLS policies themselves must NOT change in this batch. If any assertion fails, report the reproduced failure and stop for a separate owner-reviewed fix batch; you may only repair pgTAP harness/setup defects that do not change the stated expected invariant.",
    ].join(" "),
    primary_intent_summary: "Add pgTAP RLS proofs without modifying policies.",
    rationale: "Live repo already ships the RLS policies; we add proofs only.",
    drift_notes: [],
    preserved_intents: ["Add pgTAP RLS proofs"],
    satisfied_items: [],
    added_prerequisites: [],
    touched_paths: [
      { path: "supabase/tests/rls_proofs.sql", action: "create", reason: "pgTAP RLS proofs" },
    ],
    evidence: [
      { claim: "RLS policies already exist for public.projects", path: "supabase/migrations/20260101_projects_rls.sql", detail: "CREATE POLICY ... ON public.projects" },
    ],
  };
}

const fileTree = new Set([
  "supabase/migrations/20260101_projects_rls.sql",
  "supabase/functions/audit-runner/index.ts",
]);
const currentBatch = { title: "Security Hardening (RLS Proofs)", channel: "supabase", batch_no: 1 };

Deno.test("classifyBatchLayer — pgTAP-only touched paths → db_only", () => {
  const layer = classifyBatchLayer(pgtapSkeleton, [
    { path: "supabase/tests/rls_proofs.sql", action: "create", reason: "x" },
  ]);
  assertEquals(layer, "db_only");
});

Deno.test("classifyBatchLayer — edge function path → edge_only", () => {
  const layer = classifyBatchLayer("call the RPC", [
    { path: "supabase/functions/key-vault/index.ts", action: "update", reason: "x" },
  ]);
  assertEquals(layer, "edge_only");
});

Deno.test("classifyBatchLayer — DB path + edge path → mixed", () => {
  const layer = classifyBatchLayer("", [
    { path: "supabase/migrations/m.sql", action: "create", reason: "x" },
    { path: "supabase/functions/key-vault/index.ts", action: "update", reason: "y" },
  ]);
  assertEquals(layer, "mixed");
});

Deno.test("Batch 1 regression: pgTAP-only verification with positive+negative passes", () => {
  const err = batchAuthorityError(baseBatch1Ready(), currentBatch, fileTree, { source: "github" });
  assertEquals(err, null, `expected pgTAP-only verification to pass, got: ${err}`);
});

Deno.test("Batch 1 regression: verification requiring edge-function/RPC on a DB-only batch is REJECTED", () => {
  const p = baseBatch1Ready();
  p.compiled_verification_prompt_md = [
    "Verify Batch 1 after implementation. Do not change product scope.",
    "Directly call the affected edge functions and RPCs with success and failure cases.",
    "Then run/add Deno edge tests covering the new scanner module.",
    "If any tests fail, fix the tests to match the existing RLS policies.",
  ].join(" ");
  const err = batchAuthorityError(p, currentBatch, fileTree, { source: "github" });
  assert(err, "expected verification to be rejected");
  // The scope error is reported first for db_only batches.
  assert(/DB-only|Layer-scope drift|edge-function/i.test(err!), `expected layer-scope error, got: ${err}`);
});

Deno.test("Batch 1 regression: verification with 'fix the tests to match existing RLS policies' is REJECTED", () => {
  const err = verificationWeakeningError(
    "Verify Batch 1. If any tests fail, fix the tests to match the existing RLS policies and rerun.",
  );
  assert(err, "expected weakening rejection");
  assert(/test-weakening/i.test(err!), `expected weakening message, got: ${err}`);
});

Deno.test("verificationWeakeningError — flags rewrite/disable/skip variants", () => {
  for (const bad of [
    "Rewrite the failing assertions so the suite passes.",
    "Disable the failing test that blocks the pipeline.",
    "Skip the failing assertion and rerun.",
    "Adjust the tests to reflect current behavior.",
    "Make the tests green by removing the negative case.",
    "Update the tests to match existing behavior.",
  ]) {
    const err = verificationWeakeningError(`Verify. ${bad}`);
    assert(err, `expected rejection for: ${bad}`);
  }
});

Deno.test("verificationWeakeningError — legitimate 'fix only reproduced defects' passes", () => {
  const ok = verificationWeakeningError(
    "Verify Batch 1. If any pgTAP setup defect is reproduced, repair only the harness and rerun the same expected invariant unchanged.",
  );
  assertEquals(ok, null);
});

Deno.test("verificationScopeError — db_only without positive+negative is REJECTED", () => {
  const err = verificationScopeError(
    "Verify. Run the pgTAP suite and confirm the migration applied.",
    "db_only",
  );
  assert(err && /positive AND negative/i.test(err), `got: ${err}`);
});

Deno.test("verificationScopeError — edge_only requires direct invocation", () => {
  const err = verificationScopeError(
    "Verify. Run the pgTAP suite and confirm the migration applied.",
    "edge_only",
  );
  assert(err && /edge\/RPC/i.test(err), `got: ${err}`);
});

Deno.test("verificationScopeError — mixed requires both layers", () => {
  const err = verificationScopeError(
    "Verify. Directly invoke the edge function with success and failure cases.",
    "mixed",
  );
  assert(err && /BOTH the DB layer/i.test(err), `got: ${err}`);
});

// -- New tightened-contract regressions (PROMPT-CONTRACT-R5.1, 2026-07-23) -----

Deno.test("edge_only — 'Run Deno edge tests' alone is REJECTED (no direct invocation)", () => {
  const err = verificationScopeError(
    "Verify Batch. Run the Deno edge tests for the affected function.",
    "edge_only",
  );
  assert(err && /directly invoke/i.test(err), `expected direct-invocation rejection, got: ${err}`);
});

Deno.test("edge_only — 'Review the edge function' without a direct call is REJECTED", () => {
  const err = verificationScopeError(
    "Verify Batch. Review the edge function key-vault for correctness.",
    "edge_only",
  );
  assert(err && /directly invoke/i.test(err), `expected direct-invocation rejection, got: ${err}`);
});

Deno.test("edge_only — direct call with success only is REJECTED (missing failure/unauthorized)", () => {
  const err = verificationScopeError(
    "Verify Batch. Invoke the key-vault edge function as an authorized user; expect a 200 response.",
    "edge_only",
  );
  assert(err && /failure\s*\/\s*unauthorized|auth-negative/i.test(err), `expected failure-case rejection, got: ${err}`);
});

Deno.test("edge_only — direct call with success AND unauthorized PASSES", () => {
  const err = verificationScopeError(
    "Verify Batch. Invoke the key-vault edge function as an authenticated user; expect 200. Then invoke it without a token; expect 401 unauthorized.",
    "edge_only",
  );
  assertEquals(err, null, `expected pass, got: ${err}`);
});

Deno.test("edge_only — curl call with success AND unauthorized PASSES (curl counts as direct invocation)", () => {
  const err = verificationScopeError(
    "Verify Batch. curl the /functions/v1/key-vault endpoint with a valid token; expect 200. Then curl it without a token; expect 401.",
    "edge_only",
  );
  assertEquals(err, null, `expected pass, got: ${err}`);
});

Deno.test("mixed — missing DB positive/negative is REJECTED", () => {
  const err = verificationScopeError(
    "Verify Batch. Run the pgTAP migration schema check. Invoke the edge function with success (200) and failure (401 unauthorized).",
    "mixed",
  );
  assert(err && /DB positive AND negative/i.test(err), `expected DB positive/negative rejection, got: ${err}`);
});

Deno.test("mixed — missing edge success/failure is REJECTED", () => {
  const err = verificationScopeError(
    "Verify Batch. Run pgTAP with positive owner case and negative anon case. Then invoke the edge function key-vault to sanity-check.",
    "mixed",
  );
  assert(err && /edge\/RPC success AND failure/i.test(err), `expected edge success/failure rejection, got: ${err}`);
});

Deno.test("mixed — fully explicit DB positive/negative + edge invocation + success/failure PASSES", () => {
  const err = verificationScopeError(
    [
      "Verify Batch.",
      "Run pgTAP: positive owner SELECT succeeds; negative anon returns zero rows (cross-tenant blocked).",
      "Then invoke the key-vault edge function: as an authenticated user returns 200; without a token returns 401 unauthorized.",
    ].join(" "),
    "mixed",
  );
  assertEquals(err, null, `expected pass, got: ${err}`);
});


// Batch 1 compile blocker (2026-07-23): the never-weaken detector must be
// clause-aware — safe prohibitions ("do not rewrite the tests") must PASS while
// positive/imperative weakening directives must still REJECT.
Deno.test("weakening — PASS: 'Do not rewrite the tests; report the reproduced failure and stop.'", () => {
  assertEquals(
    verificationWeakeningError("Do not rewrite the tests; report the reproduced failure and stop."),
    null,
  );
});

Deno.test("weakening — PASS: 'Never weaken or remove the negative RLS assertion.'", () => {
  assertEquals(
    verificationWeakeningError("Never weaken or remove the negative RLS assertion."),
    null,
  );
});

Deno.test("weakening — PASS: 'Repair only harness defects without changing expected invariants.'", () => {
  assertEquals(
    verificationWeakeningError("Repair only harness defects without changing expected invariants."),
    null,
  );
});

Deno.test("weakening — REJECT: 'Rewrite the tests to match the existing policies.'", () => {
  const err = verificationWeakeningError("Rewrite the tests to match the existing policies.");
  assert(err && /test-weakening directive/i.test(err), `expected rejection, got: ${err}`);
});

Deno.test("weakening — REJECT mixed clause: 'Do not change the policy; rewrite the failing tests to match it.'", () => {
  const err = verificationWeakeningError("Do not change the policy; rewrite the failing tests to match it.");
  assert(err && /test-weakening directive/i.test(err), `expected rejection of second clause, got: ${err}`);
});

Deno.test("weakening — REJECT: 'Skip the failing assertion so the suite passes.'", () => {
  const err = verificationWeakeningError("Skip the failing assertion so the suite passes.");
  assert(err && /test-weakening directive/i.test(err), `expected rejection, got: ${err}`);
});
