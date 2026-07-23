// SERVER_AUTH regression: the flywheel miner MUST reject non-admin callers
// before touching workspace-wide audit findings or batch outcomes. This is
// an intentionally SYSTEM-ADMIN-ONLY endpoint; instructors and ordinary
// users never mine cross-workspace data. Guards live at the top of the
// handler, so we assert their presence in source rather than spinning up
// the whole edge runtime.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("flywheel-miner is SYSTEM-ADMIN-ONLY at the handler entry gate", () => {
  // Admin-role gate exists.
  assertStringIncludes(src, `if (profile?.role !== "admin") return j(403`);
  // SERVER_AUTH comment is co-located so future edits can't quietly widen
  // scope without touching the audited marker.
  assertStringIncludes(src, "SERVER_AUTH:");
  // The gate MUST run before the audit_findings / batches reads.
  const gateIdx = src.indexOf(`if (profile?.role !== "admin"`);
  const findingsIdx = src.indexOf(`from("audit_findings")`);
  const outcomesIdx = src.indexOf(`from("batches")`);
  assert(gateIdx > 0, "admin gate not found");
  assert(findingsIdx > gateIdx, "audit_findings read must be after admin gate");
  assert(outcomesIdx > gateIdx, "batches read must be after admin gate");
});

Deno.test("flywheel-miner never widens the role check to instructor/user", () => {
  assert(!/role\s*[!=]==?\s*['\"]instructor['\"]/i.test(src), "instructor role must not gate the miner");
  assert(!/role\s*IN\s*\(['\"]admin['\"]\s*,\s*['\"]instructor['\"]\)/i.test(src));
});
