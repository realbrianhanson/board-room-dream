/**
 * Pure classifier for splitting successful final_az audits into the two
 * DISTINCT signals the project journey depends on. Extracted so the hook
 * and the dashboard cannot drift from one another and so every edge case
 * (missing plan lock, still-pending batches, invalid timestamps) is
 * covered by a single test suite.
 *
 * Contract:
 *   • has_import_audit = a successful final_az whose created_at predates
 *     the build-safe plan lock, OR any successful final_az when no plan
 *     is locked yet. This is the pre-plan A–Z evidence for the Audit
 *     stage on the imported journey.
 *   • has_final_audit  = the post-build ship gate. FALSE unless
 *       (a) at least one batch exists,
 *       (b) EVERY current batch (including fix batches) is passed or
 *           skipped,
 *       (c) a plan is locked,
 *       (d) a successful final_az ran AFTER the plan lock AND AFTER
 *           the latest terminal batch evidence timestamp.
 *   • Any invalid / missing timestamp on a required field fails CLOSED —
 *     it never becomes epoch / NaN "truth" that flips a stage to done.
 *   • Timestamp precedence for terminal batches:
 *       passed   → built_at (required; missing/invalid ⇒ fail closed)
 *       skipped  → first valid of built_at, sent_at, created_at
 */

export type AuditRow = {
  status?: string | null;
  created_at?: string | null;
};

export type BatchRow = {
  status?: string | null;
  built_at?: string | null;
  sent_at?: string | null;
  created_at?: string | null;
};

export type AuditClassification = {
  has_import_audit: boolean;
  has_final_audit: boolean;
};

const TERMINAL_AUDIT_STATUSES = new Set(["clean", "findings"]);
const TERMINAL_BATCH_STATUSES = new Set(["passed", "skipped"]);

/**
 * Parse an ISO timestamp string and return epoch ms, or `null` when the
 * value is missing, non-string, or unparsable. Never returns 0/NaN — the
 * caller can safely treat `null` as "no valid evidence".
 */
export function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return t;
}

function terminalBatchTimestamp(b: BatchRow): number | null {
  if (b.status === "passed") {
    // Passed batches must have a real built_at. Falling back to sent_at
    // here would let a still-in-flight batch (marked passed by client
    // race) count as post-build evidence.
    return parseTimestamp(b.built_at ?? null);
  }
  if (b.status === "skipped") {
    const built = parseTimestamp(b.built_at ?? null);
    if (built != null) return built;
    const sent = parseTimestamp(b.sent_at ?? null);
    if (sent != null) return sent;
    return parseTimestamp(b.created_at ?? null);
  }
  return null;
}

export function classifyAudits(input: {
  audits: readonly AuditRow[];
  planLockedAt: number | null;
  batches: readonly BatchRow[];
}): AuditClassification {
  const terminalAudits: number[] = [];
  for (const a of input.audits) {
    if (!a || !TERMINAL_AUDIT_STATUSES.has(String(a.status))) continue;
    const t = parseTimestamp(a.created_at ?? null);
    if (t == null) continue; // fail closed: no timestamp ⇒ no evidence
    terminalAudits.push(t);
  }

  const planLockedAt =
    input.planLockedAt != null && Number.isFinite(input.planLockedAt)
      ? input.planLockedAt
      : null;

  // Pre-plan audit: successful final_az before the plan lock, or ANY
  // successful final_az when no plan is locked yet. That second clause
  // is deliberately narrow — it only matches while the project has no
  // build-safe plan at all.
  const has_import_audit = terminalAudits.some((t) =>
    planLockedAt == null ? true : t < planLockedAt,
  );

  // Post-build final audit: every gate must hold.
  let has_final_audit = false;
  do {
    if (input.batches.length === 0) break;
    if (!input.batches.every((b) => TERMINAL_BATCH_STATUSES.has(String(b.status)))) break;
    if (planLockedAt == null) break;
    // Latest terminal batch evidence. Fail closed if any batch cannot
    // yield a valid timestamp — we refuse to guess.
    let latestBatchTs: number | null = null;
    let anyMissing = false;
    for (const b of input.batches) {
      const t = terminalBatchTimestamp(b);
      if (t == null) {
        anyMissing = true;
        break;
      }
      if (latestBatchTs == null || t > latestBatchTs) latestBatchTs = t;
    }
    if (anyMissing || latestBatchTs == null) break;
    has_final_audit = terminalAudits.some(
      (t) => t >= planLockedAt && t >= (latestBatchTs as number),
    );
  } while (false);

  return { has_import_audit, has_final_audit };
}
