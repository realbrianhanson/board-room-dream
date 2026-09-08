// RC-6: the Chair merge's CODE COVERAGE line must name what was NOT read.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { auditCoverageExtras } from "./queues.ts";

const threeSeats = [{ step_key: "audit_inspector_c1" }, { step_key: "audit_contrarian_c1" }, { step_key: "audit_strategist_c2" }];
const twoSeats = [{ step_key: "audit_inspector_c1" }, { step_key: "audit_contrarian_c1" }];

Deno.test("auditCoverageExtras: nothing skipped, strategist present, full read -> empty", () => {
  assertEquals(auditCoverageExtras({ files_analyzed: 12 }, threeSeats), "");
});

Deno.test("auditCoverageExtras: UNREAD names the count and the persisted paths, with an overflow tail", () => {
  const out = auditCoverageExtras({ files_skipped: 3, skipped_paths: ["a.test.ts", "b.md"] }, threeSeats);
  assertEquals(out, "; UNREAD: 3 files (a.test.ts, b.md, +1 more)");
  assertEquals(auditCoverageExtras({ files_skipped: 2, skipped_paths: ["a.test.ts", "b.md"] }, threeSeats), "; UNREAD: 2 files (a.test.ts, b.md)");
});

Deno.test("auditCoverageExtras: incremental audits and a strategist-less run are stated", () => {
  const out = auditCoverageExtras({ incremental: { base_sha: "abc1234def", prior_audit_id: "x" } }, twoSeats);
  assert(out.includes("INCREMENTAL: only files changed since commit abc1234"), out);
  assert(out.includes("the Strategist reviewed no chunk"), out);
  // A smoke audit already says the inspector ran alone.
  assertEquals(auditCoverageExtras({ smoke: true }, [{ step_key: "audit_inspector" }]), "");
});
