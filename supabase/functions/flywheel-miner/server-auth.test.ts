// SERVER_AUTH regression: the flywheel miner MUST reject non-admin callers
// before touching workspace-wide audit findings or batch outcomes. This is
// an intentionally SYSTEM-ADMIN-ONLY endpoint; instructors and ordinary
// users never mine cross-workspace data. Guards live at the top of the
// handler, so we assert their presence in source rather than spinning up
// the whole edge runtime.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("flywheel-miner uses canonical has_role authority, not profiles.role", () => {
  // Legacy profile-role check must be gone — it was the privilege-escalation
  // vector the user_roles / has_role pattern replaces.
  assert(
    !/from\(["']profiles["']\)\s*\.select\(["']role["']\)/.test(src),
    "profiles.role must no longer gate the miner",
  );
  // Canonical RPC call with admin role.
  assertStringIncludes(src, `.rpc("has_role"`);
  assertStringIncludes(src, `_role: "admin"`);
  // Reject on truthy-only isAdmin (not `!== "admin"` string compare).
  assertStringIncludes(src, `if (isAdmin !== true) return j(403`);
});

Deno.test("flywheel-miner runs the role gate BEFORE workspace-wide reads", () => {
  const gateIdx = src.indexOf(`if (isAdmin !== true) return j(403`);
  const findingsIdx = src.indexOf(`from("audit_findings")`);
  const outcomesIdx = src.indexOf(`from("batches")`);
  assert(gateIdx > 0, "admin gate not found");
  assert(findingsIdx > gateIdx, "audit_findings read must be after admin gate");
  assert(outcomesIdx > gateIdx, "batches read must be after admin gate");
  // Marker stays co-located so future edits can't quietly widen scope.
  assertStringIncludes(src, "SERVER_AUTH:");
});

Deno.test("flywheel-miner never widens the role check to instructor/user", () => {
  assert(!/_role:\s*["']instructor["']/i.test(src), "instructor role must not gate the miner");
  assert(!/_role:\s*["']user["']/i.test(src), "user role must not gate the miner");
});
