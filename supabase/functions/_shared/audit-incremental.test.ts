import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  carryForwardNote,
  carryForwardRow,
  incrementalMetaFromConsensus,
  type PriorFinding,
  selectCarryForward,
} from "./audit-incremental.ts";

const meta = {
  prior_audit_id: "audit-old",
  base_sha: "abc1234def5678",
  changed_paths: ["src/routes/index.tsx", "supabase/migrations/EFFECTIVE_SCHEMA.inventory"],
  removed_paths: ["src/lib/old.ts"],
};

const f = (over: Partial<PriorFinding>): PriorFinding => ({
  id: over.id ?? crypto.randomUUID(),
  seat: "contrarian",
  severity: "P1",
  file_path: "supabase/functions/_shared/openrouter-proxy.ts",
  title: "t",
  description: "d",
  evidence: "QUOTE: x | WHY: y",
  confidence: "high",
  line_start: null,
  line_end: null,
  fix_batch_id: null,
  status: "open",
  ...over,
});

Deno.test("incrementalMetaFromConsensus: only a complete marker counts", () => {
  assertEquals(incrementalMetaFromConsensus({ incremental: meta }), meta);
  assertEquals(incrementalMetaFromConsensus({ incremental: { prior_audit_id: "x" } }), null);
  assertEquals(incrementalMetaFromConsensus({}), null);
  assertEquals(incrementalMetaFromConsensus(null), null);
  assertEquals(incrementalMetaFromConsensus({ incremental: { prior_audit_id: "a", base_sha: "b" } })?.changed_paths, []);
});

Deno.test("selectCarryForward: untouched-file findings travel; changed, deleted, pathless and resolved ones do not", () => {
  const keep = f({ id: "keep" });
  const drafted = f({ id: "drafted", status: "fix_drafted", fix_batch_id: "batch-1" });
  const changed = f({ id: "changed", file_path: "src/routes/index.tsx" });
  const inventory = f({ id: "inv", file_path: "supabase/migrations/EFFECTIVE_SCHEMA.inventory" });
  const deleted = f({ id: "deleted", file_path: "src/lib/old.ts" });
  const pathless = f({ id: "pathless", file_path: null });
  const resolved = f({ id: "resolved", status: "resolved" });
  const dismissed = f({ id: "dismissed", status: "dismissed" });
  const out = selectCarryForward([keep, drafted, changed, inventory, deleted, pathless, resolved, dismissed], meta);
  assertEquals(out.map((x) => x.id), ["keep", "drafted"]);
});

Deno.test("selectCarryForward: a changed migration retires every schema finding; paths are matched after ./ trimming", () => {
  const rawMigration = f({ id: "raw-mig", file_path: "supabase/migrations/20260101_a.sql" });
  const dotted = f({ id: "dotted", file_path: "./src/routes/index.tsx" });
  const keep = f({ id: "keep" });
  assertEquals(selectCarryForward([rawMigration, dotted, keep], meta).map((x) => x.id), ["keep"]);
  // No migration changed: a raw-migration finding on an untouched file travels.
  const noSchema = { ...meta, changed_paths: ["src/routes/index.tsx"] };
  assertEquals(selectCarryForward([rawMigration, dotted, keep], noSchema).map((x) => x.id), ["raw-mig", "keep"]);
});

Deno.test("carryForwardRow copies under the new audit; the fix batch link survives only when the batch still exists", () => {
  const live = new Set(["batch-1"]);
  const kept = carryForwardRow(f({ status: "fix_drafted", fix_batch_id: "batch-1", line_start: 3, line_end: 4 }), "audit-new", "user-1", live);
  assertEquals(kept.audit_id, "audit-new");
  assertEquals(kept.user_id, "user-1");
  assertEquals(kept.fix_batch_id, "batch-1");
  assertEquals(kept.status, "fix_drafted");
  assertEquals(kept.line_start, 3);
  assert(!("id" in kept), "a copy never reuses the prior row id");

  const gone = carryForwardRow(f({ status: "fix_drafted", fix_batch_id: "batch-deleted" }), "audit-new", "user-1", live);
  assertEquals(gone.fix_batch_id, null);
  assertEquals(gone.status, "open");
});

Deno.test("carryForwardNote names the count and the base commit", () => {
  assertEquals(carryForwardNote(0, "abc1234def"), "");
  assert(carryForwardNote(1, "abc1234def").includes("1 finding on files unchanged since commit abc1234 was carried forward"));
  assert(carryForwardNote(3, "abc1234def").includes("3 findings on files unchanged since commit abc1234 were carried forward"));
});
