// deno-lint-ignore-file no-explicit-any
// FINAL-AUDIT-SUPERSESSION-R1
// Service-role-only helper. When a NEW final_az audit finalizes successfully
// (Chair merge validated; verdict clean OR findings), resolve open/fix_drafted
// findings from OLDER final_az audits for the same (project, user), and
// archive+delete any pending/unsent fix batches those older findings drafted.
//
// Design goals:
// - Scope: only kind='final_az' for the same project_id + user_id, excluding
//   the currently-finalizing audit id. Never touches per-batch audits.
// - Safe deletion window: is_fix=true, status='pending', sent_at IS NULL,
//   built_at IS NULL, project_id/user_id match, and referenced by a
//   finding in the older-final-audit set. A sent/built/auditing/passed batch
//   is preserved untouched.
// - Recoverable: archive full batch row into batch_generation_archives with a
//   deterministic marker before delete. The audits table has FK
//   audit_findings.fix_batch_id ON DELETE SET NULL, so old finding rows keep
//   their history sans the dangling reference.
// - Idempotent: identify prior archive of the same batch by marker and skip
//   duplicate insert; delete of an already-deleted batch is a no-op.
// - Fail loud: any archive-insert error rejects the whole cleanup so
//   finalizeAudit refuses to publish, rather than leaving a batch_no collision.

export const SUPERSEDE_REASON = "superseded_by_successful_final_reaudit";

export type BatchRow = {
  id: string;
  project_id: string;
  user_id: string;
  is_fix?: boolean | null;
  status?: string | null;
  sent_at?: string | null;
  built_at?: string | null;
  [k: string]: any;
};

export type SupersessionContext = {
  auditId: string;
  projectId: string;
  userId: string;
  runId?: string | null;
};

// Pure — decide whether a batch row is safely obsolete for supersession.
export function isBatchSupersedable(
  batch: BatchRow | null | undefined,
  ctx: { projectId: string; userId: string; referencedByOlderFinalFinding: boolean },
): boolean {
  if (!batch) return false;
  if (batch.project_id !== ctx.projectId) return false;
  if (batch.user_id !== ctx.userId) return false;
  if (batch.is_fix !== true) return false;
  if ((batch.status ?? "") !== "pending") return false;
  if (batch.sent_at != null) return false;
  if (batch.built_at != null) return false;
  if (!ctx.referencedByOlderFinalFinding) return false;
  return true;
}

// Pure — build the archive JSON wrapper with a deterministic marker so a retry
// can recognize its own prior archive (and the pre-existing manual archive
// that already recorded `archived_batch.id`).
export function buildArchivePayload(
  batch: BatchRow,
  ctx: SupersessionContext,
): Record<string, unknown> {
  return {
    reason: SUPERSEDE_REASON,
    source_audit_id: ctx.auditId,
    source_run_id: ctx.runId ?? null,
    archived_batch_id: batch.id,
    archived_batch: batch,
  };
}

// Pure — recognize an existing archive row (manual OR prior automated) that
// already covers this batch id. Matches both shapes:
//   { archived_batch_id: "<id>", ... }             (helper-written)
//   { archived_batch: { id: "<id>", ... }, ... }   (manual + helper)
export function archiveCoversBatch(archiveJson: any, batchId: string): boolean {
  if (!archiveJson || typeof archiveJson !== "object") return false;
  if (archiveJson.archived_batch_id === batchId) return true;
  const nested = archiveJson.archived_batch;
  if (nested && typeof nested === "object" && nested.id === batchId) return true;
  return false;
}

export type SupersessionResult = {
  ran: boolean;
  older_audit_ids: string[];
  resolved_finding_count: number;
  archived_batch_ids: string[];
  skipped_batch_ids: string[]; // present but not safely supersedable
  deleted_batch_ids: string[];
  preexisting_archive_batch_ids: string[]; // duplicate archive avoided
};

// Runtime — orchestrated cleanup. Uses admin (service-role) client so the
// audit_findings guard permits P0/P1 → resolved transitions on the older
// audits. Order: (1) list older audits, (2) resolve their open findings,
// (3) collect distinct fix_batch_ids and inspect each batch, (4) for every
// safely-obsolete one: archive (if not already covered) then delete.
export async function supersedeOlderFinalAudits(
  admin: any,
  ctx: SupersessionContext,
): Promise<SupersessionResult> {
  const result: SupersessionResult = {
    ran: true,
    older_audit_ids: [],
    resolved_finding_count: 0,
    archived_batch_ids: [],
    skipped_batch_ids: [],
    deleted_batch_ids: [],
    preexisting_archive_batch_ids: [],
  };

  // 1) Older final_az audits for same project/user, excluding current id.
  const { data: olderAudits, error: olderErr } = await admin
    .from("audits")
    .select("id")
    .eq("project_id", ctx.projectId)
    .eq("user_id", ctx.userId)
    .eq("kind", "final_az")
    .neq("id", ctx.auditId);
  if (olderErr) throw new Error(`supersession: list older final audits failed: ${olderErr.message ?? olderErr}`);
  const olderIds = (olderAudits ?? []).map((r: any) => String(r.id));
  result.older_audit_ids = olderIds;
  if (olderIds.length === 0) return result;

  // 2) Snapshot findings BEFORE resolving so we can enumerate distinct
  // fix_batch_ids that were previously drafted for those older audits.
  const { data: openFindings, error: fErr } = await admin
    .from("audit_findings")
    .select("id, fix_batch_id, status, severity")
    .in("audit_id", olderIds)
    .in("status", ["open", "fix_drafted"]);
  if (fErr) throw new Error(`supersession: list older findings failed: ${fErr.message ?? fErr}`);
  const distinctBatchIds: string[] = Array.from(
    new Set<string>(
      (openFindings ?? [])
        .map((f: any) => (f.fix_batch_id ? String(f.fix_batch_id) : null))
        .filter((x: string | null): x is string => !!x),
    ),
  );

  // 3) Resolve older findings via admin (guard permits P0/P1 for service_role).
  const { data: resolved, error: rErr } = await admin
    .from("audit_findings")
    .update({ status: "resolved" })
    .in("audit_id", olderIds)
    .in("status", ["open", "fix_drafted"])
    .select("id");
  if (rErr) throw new Error(`supersession: resolve older findings failed: ${rErr.message ?? rErr}`);
  result.resolved_finding_count = (resolved ?? []).length;

  if (distinctBatchIds.length === 0) return result;

  // 4) Inspect each batch and, when safely obsolete, archive + delete.
  for (const batchId of distinctBatchIds) {
    const { data: batch, error: bErr } = await admin
      .from("batches")
      .select("*")
      .eq("id", batchId)
      .maybeSingle();
    if (bErr) throw new Error(`supersession: read batch ${batchId} failed: ${bErr.message ?? bErr}`);
    if (!batch) {
      // Already deleted in a prior retry — idempotent skip.
      result.deleted_batch_ids.push(batchId);
      continue;
    }
    const eligible = isBatchSupersedable(batch as BatchRow, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      referencedByOlderFinalFinding: true,
    });
    if (!eligible) {
      result.skipped_batch_ids.push(batchId);
      continue;
    }

    // 4a) Skip archive insert when a prior archive (manual or automated)
    // already covers this batch id.
    const { data: existing, error: exErr } = await admin
      .from("batch_generation_archives")
      .select("id, batches_json")
      .eq("project_id", ctx.projectId);
    if (exErr) throw new Error(`supersession: read archives failed: ${exErr.message ?? exErr}`);
    const alreadyArchived = (existing ?? []).some((row: any) =>
      archiveCoversBatch(row.batches_json, batchId),
    );

    if (!alreadyArchived) {
      const payload = buildArchivePayload(batch as BatchRow, ctx);
      const { error: aErr } = await admin.from("batch_generation_archives").insert({
        project_id: ctx.projectId,
        user_id: ctx.userId,
        source_run_id: ctx.runId ?? null,
        batches_json: payload,
      });
      if (aErr) throw new Error(`supersession: archive insert for batch ${batchId} failed: ${aErr.message ?? aErr}`);
      result.archived_batch_ids.push(batchId);
    } else {
      result.preexisting_archive_batch_ids.push(batchId);
    }

    // 4b) Delete the pending obsolete batch. FK ON DELETE SET NULL on
    // audit_findings.fix_batch_id clears old references safely.
    const { error: dErr } = await admin.from("batches").delete().eq("id", batchId);
    if (dErr) throw new Error(`supersession: delete batch ${batchId} failed: ${dErr.message ?? dErr}`);
    result.deleted_batch_ids.push(batchId);
  }

  return result;
}
