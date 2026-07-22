import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkFinalAuditEligibility } from "./audit-eligibility.ts";

Deno.test("import with pending batches is allowed", () => {
  const r = checkFinalAuditEligibility({
    isImport: true,
    batches: [{ status: "proposed" }, { status: "built" }],
    source: "github",
    githubRepo: "owner/repo",
  });
  assertEquals(r, { ok: true });
});

Deno.test("import with no batches allowed", () => {
  const r = checkFinalAuditEligibility({
    isImport: true,
    batches: [],
    source: "paste",
    githubRepo: null,
  });
  assertEquals(r, { ok: true });
});

Deno.test("import via github without linked repo is rejected", () => {
  const r = checkFinalAuditEligibility({
    isImport: true,
    batches: [],
    source: "github",
    githubRepo: null,
  });
  assertEquals(r, { ok: false, error: "Link your repo or paste your code first." });
});

Deno.test("non-import with pending batches rejected", () => {
  const r = checkFinalAuditEligibility({
    isImport: false,
    batches: [{ status: "passed" }, { status: "built" }],
    source: "github",
    githubRepo: "owner/repo",
  });
  assertEquals(r.ok, false);
});

Deno.test("non-import with all passed/skipped allowed", () => {
  const r = checkFinalAuditEligibility({
    isImport: false,
    batches: [{ status: "passed" }, { status: "skipped" }],
    source: "github",
    githubRepo: "owner/repo",
  });
  assertEquals(r, { ok: true });
});

Deno.test("non-import with no batches rejected", () => {
  const r = checkFinalAuditEligibility({
    isImport: false,
    batches: [],
    source: "github",
    githubRepo: "owner/repo",
  });
  assertEquals(r, { ok: false, error: "No batches to audit" });
});
