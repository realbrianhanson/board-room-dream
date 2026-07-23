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
 *  - `spent_usd` may arrive as null/undefined, a numeric string, or an
 *    unparseable value (NaN). Coerce with `safeSpend` so ordering stays
 *    deterministic — a NaN spend must not silently reorder runs or throw
 *    off the tie-breaker, and the sort comparator must never return NaN.
 */
export type RunLite = {
  id: string;
  status: string;
  created_at: string;
  spent_usd?: number | string | null;
};

const ACTIVE = new Set(["queued", "running", "paused", "paused_budget"]);

// Any spend that can't be coerced to a finite number (null, undefined,
// empty string, malformed string, NaN, Infinity) is treated as 0.
// Comparator arithmetic on NaN yields NaN which is neither <0 nor >0,
// so Array.sort silently degrades to insertion order and the "greatest
// spend wins" invariant breaks.
export function safeSpend(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Parse a timestamp defensively: an unparseable created_at should never
// crash the comparator either. Fall back to 0 (epoch) so such a row sorts
// deterministically to the oldest bucket.
function safeTime(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function selectDisplayedRun<T extends RunLite>(
  runsCreatedDesc: readonly T[],
): T | null {
  const active = runsCreatedDesc.filter((r) => ACTIVE.has(r.status));
  if (active.length > 0) {
    const sorted = [...active].sort((a, b) => {
      const sa = safeSpend(a.spent_usd);
      const sb = safeSpend(b.spent_usd);
      if (sb !== sa) return sb - sa;
      return safeTime(a.created_at) - safeTime(b.created_at);
    });
    return sorted[0] ?? null;
  }
  return runsCreatedDesc.find((r) => !ACTIVE.has(r.status)) ?? null;
}
