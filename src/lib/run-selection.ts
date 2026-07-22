/**
 * Newest-run terminal selection for Runway.
 *
 * Contract:
 *  - Prefer an active run (queued/running/paused/paused_budget). Among active
 *    runs, prefer greatest spend (most progress), tie-break by oldest.
 *  - Otherwise return the most recently created terminal run. Callers pass
 *    runs pre-sorted by created_at DESC so the first terminal is the newest.
 *  - NEVER select by spend across terminal runs — an older, higher-spend run
 *    must not shadow a newer terminal outcome.
 */
export type RunLite = {
  id: string;
  status: string;
  created_at: string;
  spent_usd?: number | string | null;
};

const ACTIVE = new Set(["queued", "running", "paused", "paused_budget"]);

export function selectDisplayedRun<T extends RunLite>(
  runsCreatedDesc: readonly T[],
): T | null {
  const active = runsCreatedDesc.filter((r) => ACTIVE.has(r.status));
  if (active.length > 0) {
    const sorted = [...active].sort((a, b) => {
      const sa = Number(a.spent_usd ?? 0);
      const sb = Number(b.spent_usd ?? 0);
      if (sb !== sa) return sb - sa;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return sorted[0] ?? null;
  }
  return runsCreatedDesc.find((r) => !ACTIVE.has(r.status)) ?? null;
}
