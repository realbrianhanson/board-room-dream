// SUPPORTED-FINDINGS-R3 static regression: every model-authored fix / QA
// batch insertion path in the orchestrator must be gated by
// insertModelAuthoredBatchOrAlert, which loads owner-authority and runs
// preLockAuthorityError BEFORE any INSERT into batches. The one legitimate
// exception is finalizeBatches (which runs its own owner-authority gate
// upstream on the whole batch list) and the restore-from-archive path in
// action=regenerate_batches (verified-untouched, previously-validated data,
// not model-authored). This test reads the source file and asserts the
// pattern rather than running the whole orchestrator, so a future refactor
// that reintroduces a raw `.from("batches").insert(...)` for a model
// prompt is caught here.
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("finalizeAudit inserts fix/QA batches only through the authority-gated helper", () => {
  // Locate finalizeAudit body.
  const start = SRC.indexOf("async function finalizeAudit(");
  assert(start > 0, "finalizeAudit not found");
  const bodyEnd = SRC.indexOf("\nasync function ", start + 10);
  const body = SRC.slice(start, bodyEnd === -1 ? SRC.length : bodyEnd);

  // Any `.from("batches").insert(` in finalizeAudit is a bug — inserts must
  // go through insertModelAuthoredBatchOrAlert.
  const rawInsert = /\.from\(\s*"batches"\s*\)\s*\n?\s*\.insert\(/g;
  const matches = body.match(rawInsert) ?? [];
  assertEquals(
    matches.length,
    0,
    `finalizeAudit contains ${matches.length} raw .from("batches").insert(...) call(s); route them through insertModelAuthoredBatchOrAlert.`,
  );

  // And the helper itself must appear in finalizeAudit at least twice
  // (fix batch on failing per-batch audit + fix batch on failing final
  // audit; QA prompt uses it too, so >=3 is the current expected floor).
  const helperCalls = (body.match(/insertModelAuthoredBatchOrAlert\(/g) ?? []).length;
  assert(
    helperCalls >= 3,
    `finalizeAudit uses insertModelAuthoredBatchOrAlert ${helperCalls} time(s); expected at least 3.`,
  );
});

Deno.test("insertModelAuthoredBatchOrAlert loads owner-authority before inserting", () => {
  const idx = SRC.indexOf("async function insertModelAuthoredBatchOrAlert(");
  assert(idx > 0, "helper not found");
  const end = SRC.indexOf("\n}\n", idx);
  const body = SRC.slice(idx, end === -1 ? SRC.length : end);
  assert(body.includes("loadOwnerAuthority"), "helper must call loadOwnerAuthority");
  assert(
    body.includes("preLockAuthorityError") || body.includes("computeAuthorityViolationError"),
    "helper must run the owner-authority pre-lock check (preLockAuthorityError or the R6 computeAuthorityViolationError passthrough)",
  );
  assert(body.includes("owner_authority_violation"), "helper must emit an alert on gate failure");
});
