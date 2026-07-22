import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  downgradeUnsupported,
  hasCallerMarker,
  hasCurrentMarker,
  hasImpactMarker,
  hasRuntimeFailureMarker,
  hasSchemaLedgerMarker,
  isMigrationPath,
  looksLikeMissingObjectClaim,
  looksLikeUniversalHelperClaim,
  type CleanFinding,
} from "./audit-findings.ts";

function f(overrides: Partial<CleanFinding> = {}): CleanFinding {
  return {
    seat: "inspector",
    severity: "P0",
    file_path: "src/routes/index.tsx",
    title: "Concrete title of the issue",
    description: "A concrete description of what is broken.",
    evidence:
      'QUOTE: const x = null; | WHY: null dereferenced later in the same block breaks build. IMPACT: build_failure',
    confidence: "high",
    line_start: 10,
    line_end: 12,
    ...overrides,
  };
}

Deno.test("marker helpers detect all four compact markers", () => {
  assert(hasImpactMarker("QUOTE: x | WHY: y IMPACT: build_failure"));
  assert(hasImpactMarker("IMPACT: auth_bypass here"));
  assert(!hasImpactMarker("IMPACT: something_else"));
  assert(hasCurrentMarker("CURRENT: GRANT SELECT ..."));
  assert(hasSchemaLedgerMarker("SCHEMA_LEDGER: no such table"));
  assert(hasRuntimeFailureMarker("RUNTIME_FAILURE: relation does not exist"));
  assert(hasCallerMarker("CALLER: src/foo.ts uses helper()"));
});

Deno.test("isMigrationPath recognises supabase/migrations/*", () => {
  assert(isMigrationPath("supabase/migrations/20260101_x.sql"));
  assert(isMigrationPath("./supabase/migrations/y.sql"));
  assert(!isMigrationPath("src/foo.ts"));
});

Deno.test("claim classifiers detect missing-object and universal-helper prose", () => {
  assert(looksLikeMissingObjectClaim("Column does not exist", "The column plan_versions.is_build_safe does not exist"));
  assert(!looksLikeMissingObjectClaim("Wrong copy", "Header text uses the wrong tone"));
  assert(looksLikeUniversalHelperClaim("All seats share the same prompt", "Every request uses one system prompt"));
  assert(!looksLikeUniversalHelperClaim("Specific helper bug", "helper() returns wrong value for input Y"));
});

Deno.test("Rule 1: P0 without IMPACT marker downgrades to P1", () => {
  const input = f({
    evidence: "QUOTE: const x = null; | WHY: dereferenced later.",
  });
  const { findings, downgrades } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P1");
  assertEquals(downgrades[0].from, "P0");
  assertEquals(downgrades[0].to, "P1");
});

Deno.test("Rule 2: P0/P1 under supabase/migrations/* without CURRENT downgrades to P2", () => {
  const input = f({
    severity: "P1",
    file_path: "supabase/migrations/20240101_init.sql",
    title: "Missing GRANT on public.notes",
    description: "The initial migration never grants SELECT on public.notes to authenticated.",
    evidence: "QUOTE: CREATE TABLE public.notes(...) | WHY: no GRANT follows. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("Rule 2 passes when CURRENT marker is present", () => {
  const input = f({
    severity: "P1",
    file_path: "supabase/migrations/20240101_init.sql",
    title: "Missing GRANT on public.notes",
    description: "No GRANT ever issued for public.notes.",
    evidence:
      "QUOTE: CREATE TABLE public.notes(...) | WHY: no GRANT. CURRENT: grep -n GRANT.*public.notes across all migrations returns zero matches. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P1");
});

Deno.test("Rule 3: missing-object claim without SCHEMA_LEDGER/RUNTIME_FAILURE downgrades to P2", () => {
  const input = f({
    severity: "P1",
    title: "Column plan_versions.is_build_safe does not exist",
    description: "Code queries plan_versions.is_build_safe but the column does not exist in the schema.",
    evidence: "QUOTE: .select('is_build_safe') | WHY: query references a nonexistent column. IMPACT: data_loss",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("Rule 4: universal-helper claim without CALLER downgrades to P2", () => {
  const input = f({
    severity: "P1",
    title: "Every seat call bypasses the constitution",
    description: "All seats send requests without the constitution prompt attached.",
    evidence: "QUOTE: fetch('/v1/chat/completions') | WHY: no constitution in payload. IMPACT: auth_bypass",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P2");
});

// ================ Regression fixtures for false claims from the prior audit ================

Deno.test("false claim: Round 2 steals schema is not truncated — cannot survive as P0/P1", () => {
  const input = f({
    severity: "P0",
    file_path: "supabase/functions/boardroom-orchestrator/queues.ts",
    title: "Round 2 steals schema is truncated at 8k tokens",
    description: "The steals schema truncation causes prompt corruption in every Round 2 debate.",
    evidence: "QUOTE: max_tokens: 8000 | WHY: appears too small. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([input]);
  assert(findings[0].severity === "P2" || findings[0].severity === "P1",
    "unsupported speculative claim must not remain P0");
});

Deno.test("false claim: human batches bypass skeletonError — universal claim requires CALLER", () => {
  const input = f({
    severity: "P1",
    file_path: "supabase/functions/batch-compiler/index.ts",
    title: "All human batches skip skeletonError before validation",
    description: "Every human batch is rejected before skeletonError could run.",
    evidence:
      "QUOTE: if (channel === 'human') return early; | WHY: skeletonError never fires. IMPACT: build_failure",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("false claim: plan_versions.is_build_safe missing — no SCHEMA_LEDGER marker", () => {
  const input = f({
    severity: "P1",
    file_path: "src/routes/_authenticated/plan.$projectId.tsx",
    title: "Column plan_versions.is_build_safe does not exist",
    description: "UI filters on is_build_safe but the column is missing.",
    evidence:
      "QUOTE: .eq('is_build_safe', true) | WHY: column is not in the schema. IMPACT: data_loss",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P2");
});

Deno.test("false claim: join_cohort ignores boardroom.allow_cohort_change — migration path w/o CURRENT", () => {
  const input = f({
    severity: "P1",
    file_path: "supabase/migrations/20250101_join_cohort.sql",
    title: "join_cohort guard ignores boardroom.allow_cohort_change setting",
    description: "The guard never honours the allow_cohort_change bypass.",
    evidence:
      "QUOTE: IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id THEN RAISE | WHY: no setting check. IMPACT: auth_bypass",
  });
  const { findings } = downgradeUnsupported([input]);
  assertEquals(findings[0].severity, "P2");
});
