// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  archiveCoversBatch,
  buildArchivePayload,
  isBatchSupersedable,
  SUPERSEDE_REASON,
  supersedeOlderFinalAudits,
} from "./audit-supersession.ts";

// ---------- Pure helper tests ----------

Deno.test("isBatchSupersedable: only pending+unsent+unbuilt fix batches for same owner", () => {
  const base = {
    id: "b1", project_id: "p", user_id: "u",
    is_fix: true, status: "pending", sent_at: null, built_at: null,
  };
  const ctx = { projectId: "p", userId: "u", referencedByOlderFinalFinding: true };
  assert(isBatchSupersedable(base as any, ctx));
  assert(!isBatchSupersedable({ ...base, is_fix: false } as any, ctx), "non-fix batch preserved");
  assert(!isBatchSupersedable({ ...base, status: "sent" } as any, ctx), "sent preserved");
  assert(!isBatchSupersedable({ ...base, status: "built" } as any, ctx), "built preserved");
  assert(!isBatchSupersedable({ ...base, status: "auditing" } as any, ctx), "auditing preserved");
  assert(!isBatchSupersedable({ ...base, status: "passed" } as any, ctx), "passed preserved");
  assert(!isBatchSupersedable({ ...base, sent_at: "2026-07-01" } as any, ctx), "sent_at set preserved");
  assert(!isBatchSupersedable({ ...base, built_at: "2026-07-01" } as any, ctx), "built_at set preserved");
  assert(!isBatchSupersedable({ ...base, project_id: "other" } as any, ctx), "cross-project preserved");
  assert(!isBatchSupersedable({ ...base, user_id: "other" } as any, ctx), "cross-user preserved");
  assert(!isBatchSupersedable(base as any, { ...ctx, referencedByOlderFinalFinding: false }), "unreferenced preserved");
  assert(!isBatchSupersedable(null, ctx));
});

Deno.test("archiveCoversBatch recognizes both helper and manual shapes", () => {
  assert(archiveCoversBatch({ archived_batch_id: "b1" }, "b1"));
  assert(archiveCoversBatch({ archived_batch: { id: "b1" } }, "b1"));
  assert(!archiveCoversBatch({ archived_batch_id: "b2" }, "b1"));
  assert(!archiveCoversBatch({ archived_batch: { id: "b2" } }, "b1"));
  assert(!archiveCoversBatch(null, "b1"));
  assert(!archiveCoversBatch("nope", "b1"));
});

Deno.test("buildArchivePayload stamps reason + audit context + full batch", () => {
  const batch: any = { id: "b1", project_id: "p", user_id: "u", title: "Fix" };
  const payload = buildArchivePayload(batch, { auditId: "a1", projectId: "p", userId: "u", runId: "r1" });
  assertEquals(payload.reason, SUPERSEDE_REASON);
  assertEquals(payload.source_audit_id, "a1");
  assertEquals(payload.source_run_id, "r1");
  assertEquals(payload.archived_batch_id, "b1");
  assertEquals((payload.archived_batch as any).title, "Fix");
});

// ---------- Fake admin client ----------

type Row = Record<string, any>;
function makeAdmin(seed: {
  audits: Row[]; findings: Row[]; batches: Row[]; archives: Row[];
}) {
  const state = {
    audits: [...seed.audits],
    findings: [...seed.findings],
    batches: [...seed.batches],
    archives: [...seed.archives],
  };
  function from(table: keyof typeof state) {
    const filters: Array<(r: Row) => boolean> = [];
    const q: any = {
      _table: table,
      select(_cols?: string) { return q; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return q; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return q; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return q; },
      maybeSingle() {
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: any, reject: any) {
        // Bare await on the chain returns filtered rows.
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
      update(patch: Row) {
        return {
          eq(col: string, val: any) { filters.push((r) => r[col] === val); return this; },
          in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return this; },
          select(_c?: string) {
            const changed: Row[] = [];
            for (const r of state[table]) {
              if (filters.every((f) => f(r))) { Object.assign(r, patch); changed.push({ ...r }); }
            }
            return Promise.resolve({ data: changed, error: null });
          },
        };
      },
      insert(rowOrRows: Row | Row[]) {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        for (const r of rows) state[table].push({ id: r.id ?? `${table}-${state[table].length + 1}`, ...r });
        return Promise.resolve({ data: null, error: null });
      },
      delete() {
        return {
          eq(col: string, val: any) {
            state[table] = state[table].filter((r) => r[col] !== val);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    return q;
  }
  return { from, _state: state };
}

// ---------- Scenario tests ----------

const CTX = { auditId: "aNew", projectId: "p1", userId: "u1", runId: "run1" };

Deno.test("scope: no older final audits → no-op", async () => {
  const admin = makeAdmin({ audits: [], findings: [], batches: [], archives: [] });
  const res = await supersedeOlderFinalAudits(admin as any, CTX);
  assertEquals(res.older_audit_ids.length, 0);
  assertEquals(res.resolved_finding_count, 0);
  assertEquals(res.deleted_batch_ids.length, 0);
});

Deno.test("scope: excludes current audit id and per-batch audits", async () => {
  const admin = makeAdmin({
    audits: [
      { id: "aNew", project_id: "p1", user_id: "u1", kind: "final_az" },
      { id: "aOld", project_id: "p1", user_id: "u1", kind: "final_az" },
      { id: "aBatch", project_id: "p1", user_id: "u1", kind: "batch" },
      { id: "aOther", project_id: "p2", user_id: "u1", kind: "final_az" },
    ],
    findings: [
      { id: "f-batch", audit_id: "aBatch", status: "open", severity: "P0", fix_batch_id: "bx" },
    ],
    batches: [{ id: "bx", project_id: "p1", user_id: "u1", is_fix: true, status: "pending", sent_at: null, built_at: null }],
    archives: [],
  });
  const res = await supersedeOlderFinalAudits(admin as any, CTX);
  assertEquals(res.older_audit_ids, ["aOld"]);
  // per-batch audit finding stays open; per-batch fix batch is NOT touched.
  const bx = admin._state.batches.find((b) => b.id === "bx");
  assert(bx, "per-batch fix batch must be preserved");
  const fBatch = admin._state.findings.find((f) => f.id === "f-batch");
  assertEquals(fBatch?.status, "open");
});

Deno.test("findings verdict entry: resolves older findings + archives + deletes pending fix batch", async () => {
  const admin = makeAdmin({
    audits: [
      { id: "aNew", project_id: "p1", user_id: "u1", kind: "final_az" },
      { id: "aOld", project_id: "p1", user_id: "u1", kind: "final_az" },
    ],
    findings: [
      { id: "f1", audit_id: "aOld", status: "fix_drafted", severity: "P0", fix_batch_id: "bOld" },
      { id: "f2", audit_id: "aOld", status: "open", severity: "P1", fix_batch_id: "bOld" },
    ],
    batches: [
      { id: "bOld", project_id: "p1", user_id: "u1", is_fix: true, status: "pending", sent_at: null, built_at: null, batch_no: 1, title: "Stale fix" },
    ],
    archives: [],
  });
  const res = await supersedeOlderFinalAudits(admin as any, CTX);
  assertEquals(res.resolved_finding_count, 2);
  assertEquals(res.archived_batch_ids, ["bOld"]);
  assertEquals(res.deleted_batch_ids, ["bOld"]);
  assertEquals(admin._state.batches.length, 0);
  assertEquals(admin._state.archives.length, 1);
  const arch = admin._state.archives[0];
  assertEquals(arch.batches_json.reason, SUPERSEDE_REASON);
  assertEquals(arch.batches_json.archived_batch_id, "bOld");
  assertEquals(admin._state.findings.every((f) => f.status === "resolved"), true);
});

Deno.test("clean verdict entry: still runs supersession", async () => {
  // finalizeAudit calls the helper the same way regardless of verdict.
  const admin = makeAdmin({
    audits: [
      { id: "aOld", project_id: "p1", user_id: "u1", kind: "final_az" },
    ],
    findings: [{ id: "f1", audit_id: "aOld", status: "open", severity: "P0", fix_batch_id: null }],
    batches: [],
    archives: [],
  });
  const res = await supersedeOlderFinalAudits(admin as any, CTX);
  assertEquals(res.resolved_finding_count, 1);
  assertEquals(res.archived_batch_ids.length, 0);
});

Deno.test("preserves progressed batches (sent/built/passed/auditing)", async () => {
  const admin = makeAdmin({
    audits: [{ id: "aOld", project_id: "p1", user_id: "u1", kind: "final_az" }],
    findings: [
      { id: "f1", audit_id: "aOld", status: "fix_drafted", severity: "P0", fix_batch_id: "bSent" },
      { id: "f2", audit_id: "aOld", status: "open", severity: "P1", fix_batch_id: "bBuilt" },
      { id: "f3", audit_id: "aOld", status: "open", severity: "P1", fix_batch_id: "bPassed" },
    ],
    batches: [
      { id: "bSent", project_id: "p1", user_id: "u1", is_fix: true, status: "pending", sent_at: "2026-07-01", built_at: null },
      { id: "bBuilt", project_id: "p1", user_id: "u1", is_fix: true, status: "pending", sent_at: null, built_at: "2026-07-01" },
      { id: "bPassed", project_id: "p1", user_id: "u1", is_fix: true, status: "passed", sent_at: null, built_at: null },
    ],
    archives: [],
  });
  const res = await supersedeOlderFinalAudits(admin as any, CTX);
  assertEquals(res.skipped_batch_ids.sort(), ["bBuilt", "bPassed", "bSent"]);
  assertEquals(res.deleted_batch_ids.length, 0);
  assertEquals(admin._state.batches.length, 3);
});

Deno.test("idempotent retry: existing archive marker skips duplicate insert; missing batch is a no-op", async () => {
  const admin = makeAdmin({
    audits: [{ id: "aOld", project_id: "p1", user_id: "u1", kind: "final_az" }],
    findings: [
      { id: "f1", audit_id: "aOld", status: "fix_drafted", severity: "P0", fix_batch_id: "bOld" },
      { id: "f2", audit_id: "aOld", status: "open", severity: "P1", fix_batch_id: "bGone" },
    ],
    batches: [
      { id: "bOld", project_id: "p1", user_id: "u1", is_fix: true, status: "pending", sent_at: null, built_at: null },
      // bGone: absent, simulating already-deleted prior run.
    ],
    archives: [
      // Manual archive using nested-shape marker: helper must recognize it.
      { id: "arch-manual", project_id: "p1", user_id: "u1",
        batches_json: { reason: "manual", archived_batch: { id: "bOld" } } },
    ],
  });
  const res = await supersedeOlderFinalAudits(admin as any, CTX);
  assertEquals(res.preexisting_archive_batch_ids, ["bOld"]);
  assertEquals(res.archived_batch_ids.length, 0);
  assertEquals(res.deleted_batch_ids.sort(), ["bGone", "bOld"]);
  assertEquals(admin._state.batches.length, 0);
  assertEquals(admin._state.archives.length, 1, "no duplicate archive inserted");
});
