// Incremental final audits (RC-6). beginAudit maps only the files changed
// since the prior successful final audit and records that base on
// run.consensus.incremental; finalizeAudit then carries the prior audit's
// still-open findings on UNTOUCHED files forward into the new audit as
// fresh rows (new id, new audit_id — the old rows stay where supersession
// leaves them). A finding on a changed or deleted file is never carried:
// the seats re-read changed files, and a deleted file has nothing to fix.
//
// Pure helpers only — no I/O — so the selection is unit-testable.

export type IncrementalAuditMeta = {
  prior_audit_id: string;
  base_sha: string;
  changed_paths: string[];
  removed_paths: string[];
};

export function incrementalMetaFromConsensus(consensus: unknown): IncrementalAuditMeta | null {
  const c = consensus as { incremental?: Partial<IncrementalAuditMeta> | null } | null | undefined;
  const m = c?.incremental;
  if (!m || typeof m !== "object") return null;
  if (typeof m.prior_audit_id !== "string" || !m.prior_audit_id) return null;
  if (typeof m.base_sha !== "string" || !m.base_sha) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    prior_audit_id: m.prior_audit_id,
    base_sha: m.base_sha,
    changed_paths: list(m.changed_paths),
    removed_paths: list(m.removed_paths),
  };
}

/** Only unresolved findings travel; resolved / dismissed ones are history. */
export const CARRY_FORWARD_STATUSES: readonly string[] = ["open", "fix_drafted"];

export type PriorFinding = {
  id?: string;
  seat: string | null;
  severity: string;
  file_path: string | null;
  title: string;
  description: string | null;
  evidence: string | null;
  confidence: string;
  line_start: number | null;
  line_end: number | null;
  fix_batch_id: string | null;
  status: string;
};

export function selectCarryForward<T extends PriorFinding>(prior: readonly T[], meta: IncrementalAuditMeta): T[] {
  const touched = new Set<string>([...meta.changed_paths, ...meta.removed_paths]);
  return prior.filter((f) => {
    if (!CARRY_FORWARD_STATUSES.includes(f.status)) return false;
    const path = (f.file_path ?? "").trim();
    // No path = no way to prove the file was untouched; do not carry it.
    if (!path) return false;
    return !touched.has(path);
  });
}

export type CarriedFindingRow = {
  audit_id: string;
  user_id: string;
  seat: string | null;
  severity: string;
  file_path: string;
  title: string;
  description: string | null;
  evidence: string | null;
  confidence: string;
  line_start: number | null;
  line_end: number | null;
  fix_batch_id: string | null;
  status: string;
};

// A copy under the new audit. The prior fix batch link survives only when
// that batch still exists (supersession deletes pending unsent ones); a
// finding whose fix batch is gone reopens as plain 'open'.
export function carryForwardRow(
  f: PriorFinding,
  newAuditId: string,
  userId: string,
  liveFixBatchIds: ReadonlySet<string>,
): CarriedFindingRow {
  const keepBatch = !!f.fix_batch_id && liveFixBatchIds.has(f.fix_batch_id);
  return {
    audit_id: newAuditId,
    user_id: userId,
    seat: f.seat ?? null,
    severity: f.severity,
    file_path: String(f.file_path ?? ""),
    title: f.title,
    description: f.description ?? null,
    evidence: f.evidence ?? null,
    confidence: f.confidence,
    line_start: f.line_start ?? null,
    line_end: f.line_end ?? null,
    fix_batch_id: keepBatch ? f.fix_batch_id : null,
    status: keepBatch && f.status === "fix_drafted" ? "fix_drafted" : "open",
  };
}

export function carryForwardNote(count: number, baseSha: string): string {
  if (count <= 0) return "";
  return ` ${count} finding${count === 1 ? "" : "s"} on files unchanged since commit ${baseSha.slice(0, 7)} ${count === 1 ? "was" : "were"} carried forward from the previous final audit without re-reading them.`;
}
