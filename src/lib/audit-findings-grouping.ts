/**
 * Group open/fix_drafted audit findings by their originating audit so the
 * Audit Center can label each source truthfully rather than dumping them
 * into a single flat list.
 *
 * Ordering: the current final audit (latest kind === "final_az") first,
 * then remaining audits newest-first by created_at.
 *
 * Labels:
 *   - "Current final audit" — for the latest final_az
 *   - "Previous final audit · <date> · <short SHA>" — for older finals
 *   - "Batch <n> · <date>" — for batch audits with a resolvable batch_no
 *   - "Batch audit · <date>" — fallback when no batch_no is available
 */

export type GroupingAuditStatus = "running" | "clean" | "findings" | "failed" | string;

export type GroupingAudit = {
  id: string;
  batch_id: string | null;
  kind: "batch" | "final_az";
  /**
   * Terminal status of the audit. "Current final audit" must only be
   * chosen from a successful terminal final ("clean" | "findings"); a
   * running/queued/failed/cancelled final never displaces the latest
   * successful one. Optional so legacy callers that omit status still
   * behave sanely (treated as non-terminal for the "current" choice).
   */
  status?: GroupingAuditStatus | null;
  created_at: string;
  head_sha?: string | null;
};

export type GroupingBatch = { id: string; batch_no: number };

export type GroupingFinding = { id: string; audit_id: string; status: string };

export type AuditGroup<F extends GroupingFinding> = {
  auditId: string;
  label: string;
  audit: GroupingAudit;
  findings: F[];
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  const trimmed = sha.trim();
  return trimmed.length >= 7 ? trimmed.slice(0, 7) : trimmed || null;
}

/** A final audit that actually produced published results. */
function isSuccessfulFinal(a: GroupingAudit): boolean {
  return a.kind === "final_az" && (a.status === "clean" || a.status === "findings");
}

export function labelForAudit(
  audit: GroupingAudit,
  isCurrentFinal: boolean,
  batches: GroupingBatch[],
): string {
  if (audit.kind === "final_az") {
    if (isCurrentFinal) return "Current final audit";
    const sha = shortSha(audit.head_sha);
    return sha
      ? `Previous final audit · ${fmtDate(audit.created_at)} · ${sha}`
      : `Previous final audit · ${fmtDate(audit.created_at)}`;
  }
  const b = audit.batch_id ? batches.find((x) => x.id === audit.batch_id) : null;
  if (b) return `Batch ${b.batch_no} · ${fmtDate(audit.created_at)}`;
  return `Batch audit · ${fmtDate(audit.created_at)}`;
}

export function groupOpenFindingsByAudit<F extends GroupingFinding>(
  audits: GroupingAudit[],
  findings: F[],
  batches: GroupingBatch[],
): AuditGroup<F>[] {
  const openable = findings.filter((f) => f.status === "open" || f.status === "fix_drafted");
  if (openable.length === 0) return [];

  const byId = new Map<string, GroupingAudit>();
  for (const a of audits) byId.set(a.id, a);

  // Current final = latest by created_at among SUCCESSFUL terminal final
  // audits only. A newer running/queued/failed/cancelled final must not
  // displace the latest successful one.
  let currentFinal: GroupingAudit | null = null;
  for (const a of audits) {
    if (!isSuccessfulFinal(a)) continue;
    if (!currentFinal || a.created_at > currentFinal.created_at) currentFinal = a;
  }

  const groupsMap = new Map<string, F[]>();
  for (const f of openable) {
    const list = groupsMap.get(f.audit_id) ?? [];
    list.push(f);
    groupsMap.set(f.audit_id, list);
  }

  const groups: AuditGroup<F>[] = [];
  for (const [auditId, fs] of groupsMap) {
    const audit = byId.get(auditId);
    if (!audit) {
      // Orphaned finding — surface it under a truthful fallback rather than
      // silently dropping it.
      groups.push({
        auditId,
        label: "Unknown audit",
        audit: {
          id: auditId,
          batch_id: null,
          kind: "batch",
          created_at: new Date(0).toISOString(),
        },
        findings: fs,
      });
      continue;
    }
    const isCurrent = !!currentFinal && audit.id === currentFinal.id;
    groups.push({
      auditId,
      label: labelForAudit(audit, isCurrent, batches),
      audit,
      findings: fs,
    });
  }

  // Sort: current final first, then remaining by created_at desc.
  groups.sort((a, b) => {
    const aCurrent = currentFinal && a.audit.id === currentFinal.id ? 1 : 0;
    const bCurrent = currentFinal && b.audit.id === currentFinal.id ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return b.audit.created_at.localeCompare(a.audit.created_at);
  });

  return groups;
}
