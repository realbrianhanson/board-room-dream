// Pure selectors for the Audit Center's final-audit retry UX.
// Kept free of React/Supabase so it can be unit-tested in isolation.

export type AuditStatus = "running" | "clean" | "findings" | "failed";

export type AuditRow = {
  id: string;
  kind: "batch" | "final_az";
  status: AuditStatus;
  created_at: string;
  run_id?: string | null;
};

export function finalAudits<T extends AuditRow>(audits: T[]): T[] {
  return audits
    .filter((a) => a.kind === "final_az")
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function latestFinal<T extends AuditRow>(audits: T[]): T | null {
  return finalAudits(audits)[0] ?? null;
}

export function previousFinals<T extends AuditRow>(audits: T[]): T[] {
  return finalAudits(audits).slice(1);
}

export function hasActiveFinal<T extends AuditRow>(audits: T[]): boolean {
  // Duplicate-final guard: if ANY retained final_az audit is still running,
  // block a new start — never just the newest row. An older still-running
  // audit + a newer failed/findings row must still be treated as active.
  return finalAudits(audits).some((a) => a.status === "running");
}

/**
 * When true, the owner may open the start controls (initial or retry).
 * Read-only viewers (isOwner=false) can never start or retry.
 * A running latest final blocks new starts to prevent duplicates.
 */
export function canStartFinal(params: {
  isOwner: boolean;
  audits: AuditRow[];
  starting: boolean;
}): boolean {
  if (!params.isOwner) return false;
  if (params.starting) return false;
  if (hasActiveFinal(params.audits)) return false;
  return true;
}

/**
 * Label for the primary start CTA. "again" after a failure, "new" after a
 * completed audit, "Run the A-Z audit" for the first time.
 */
export function startCtaLabel(latest: AuditRow | null): string {
  if (!latest) return "Run the A–Z audit";
  if (latest.status === "failed") return "Run final audit again";
  return "Run a new final audit";
}
