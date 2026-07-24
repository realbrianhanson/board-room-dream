import { assertEquals, assertObjectMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  deriveImportWorkflow,
  nextImportRoute,
  normalizeImportGoals,
  type ImportStageFlags,
} from "./import-workflow.ts";

const stage = (over: Partial<ImportStageFlags> = {}): ImportStageFlags => ({
  projectId: "p1",
  hasRepo: false,
  auditComplete: false,
  planComplete: false,
  designComplete: false,
  ...over,
});

Deno.test("normalizeImportGoals keeps supported, dedupes, canonical order", () => {
  assertEquals(normalizeImportGoals(["improvements", "code_audit", "improvements"]), [
    "code_audit",
    "improvements",
  ]);
});

Deno.test("normalizeImportGoals drops unknown values", () => {
  assertEquals(normalizeImportGoals(["code_audit", "bogus", 42, null]), ["code_audit"]);
});

Deno.test("normalizeImportGoals legacy fallback: empty/missing => all three", () => {
  const full = ["code_audit", "design_review", "improvements"] as const;
  assertEquals(normalizeImportGoals([]), full);
  assertEquals(normalizeImportGoals(undefined), full);
  assertEquals(normalizeImportGoals(null), full);
  assertEquals(normalizeImportGoals({}), full);
});

Deno.test("deriveImportWorkflow: audit only", () => {
  const w = deriveImportWorkflow(["code_audit"]);
  assertObjectMatch(w, {
    requiresAudit: true,
    requiresPlan: false,
    requiresDesign: false,
    generatesPrompts: false,
    auditOnly: true,
    scopeLabel: "Code audit",
  });
});

Deno.test("deriveImportWorkflow: design only", () => {
  const w = deriveImportWorkflow(["design_review"]);
  assertObjectMatch(w, {
    requiresAudit: false,
    requiresDesign: true,
    requiresPlan: false,
    generatesPrompts: true,
    auditOnly: false,
  });
});

Deno.test("deriveImportWorkflow: improvements only", () => {
  const w = deriveImportWorkflow(["improvements"]);
  assertObjectMatch(w, {
    requiresPlan: true,
    generatesPrompts: true,
    auditOnly: false,
  });
});

Deno.test("deriveImportWorkflow: two-goal custom (audit + design)", () => {
  const w = deriveImportWorkflow(["design_review", "code_audit"]);
  assertEquals(w.goals, ["code_audit", "design_review"]);
  assertEquals(w.auditOnly, false);
  assertEquals(w.generatesPrompts, true);
  assertEquals(w.scopeLabel, "Code audit + Design review");
});

Deno.test("deriveImportWorkflow: all three (legacy default)", () => {
  const w = deriveImportWorkflow(undefined);
  assertEquals(w.goals, ["code_audit", "design_review", "improvements"]);
  assertEquals(w.auditOnly, false);
  assertEquals(w.scopeLabel, "Code audit, Design review + Improvements");
});

Deno.test("nextImportRoute: audit-only ends at audit, never boardroom", () => {
  const w = deriveImportWorkflow(["code_audit"]);
  assertEquals(nextImportRoute(w, stage({ hasRepo: true })), {
    kind: "audit",
    path: "/audits/p1",
  });
  assertEquals(nextImportRoute(w, stage({ hasRepo: true, auditComplete: true })), {
    kind: "done",
    path: "/audits/p1",
  });
});

Deno.test("nextImportRoute: routes to repo setup when scope needs live code", () => {
  const w = deriveImportWorkflow(["improvements"]);
  assertEquals(nextImportRoute(w, stage()), { kind: "repo_setup", path: "/runway/p1" });
});

Deno.test("nextImportRoute: full path repo → audit → plan → design → runway", () => {
  const w = deriveImportWorkflow(undefined);
  assertEquals(nextImportRoute(w, stage()).kind, "repo_setup");
  assertEquals(nextImportRoute(w, stage({ hasRepo: true })).kind, "audit");
  assertEquals(
    nextImportRoute(w, stage({ hasRepo: true, auditComplete: true })).kind,
    "plan",
  );
  assertEquals(
    nextImportRoute(
      w,
      stage({ hasRepo: true, auditComplete: true, planComplete: true }),
    ).kind,
    "design",
  );
  assertEquals(
    nextImportRoute(
      w,
      stage({
        hasRepo: true,
        auditComplete: true,
        planComplete: true,
        designComplete: true,
      }),
    ),
    { kind: "runway", path: "/runway/p1" },
  );
});

Deno.test("nextImportRoute: design-only skips plan", () => {
  const w = deriveImportWorkflow(["design_review"]);
  assertEquals(nextImportRoute(w, stage({ hasRepo: true })).kind, "design");
  assertEquals(
    nextImportRoute(w, stage({ hasRepo: true, designComplete: true })).kind,
    "runway",
  );
});
