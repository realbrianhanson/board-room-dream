// Pure helpers for the vote scorecard the orchestrator stores on
// run.consensus.scorecard when a plan/design locks, and for loop-aware
// transcript copy. Kept free of React so both can be unit-tested.

export const VOTING_SEATS = ["strategist", "contrarian", "inspector"] as const;
export type VotingSeat = (typeof VOTING_SEATS)[number];

export type SeatScorecard = { mean: number | null; min: number | null; blocking: number };
export type RunScorecard = {
  threshold: number;
  passed: boolean;
  seats: Partial<Record<VotingSeat, SeatScorecard>>;
};

/** The scorecard on a run's consensus blob, or null when absent / malformed. */
export function readScorecard(consensus: unknown): RunScorecard | null {
  const sc = (consensus as { scorecard?: unknown } | null | undefined)?.scorecard as
    | { threshold?: unknown; passed?: unknown; seats?: unknown }
    | null
    | undefined;
  if (!sc || typeof sc !== "object" || !sc.seats || typeof sc.seats !== "object") return null;
  const threshold = Number(sc.threshold);
  if (!Number.isFinite(threshold)) return null;
  const seats: Partial<Record<VotingSeat, SeatScorecard>> = {};
  for (const seat of VOTING_SEATS) {
    const raw = (sc.seats as Record<string, unknown>)[seat] as Partial<SeatScorecard> | undefined;
    if (!raw || typeof raw !== "object") continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    seats[seat] = { mean: num(raw.mean), min: num(raw.min), blocking: num(raw.blocking) ?? 0 };
  }
  return { threshold, passed: sc.passed === true, seats };
}

export function scorecardVerdictLabel(sc: RunScorecard): "Consensus" | "Chair ruled" {
  return sc.passed ? "Consensus" : "Chair ruled";
}

/** Display strings for one seat's row; a seat with no vote reads as a dash. */
export function formatSeatScore(s: SeatScorecard | undefined): { mean: string; min: string; blocking: string } {
  if (!s || s.mean == null) return { mean: "—", min: "—", blocking: s ? String(s.blocking) : "—" };
  return { mean: s.mean.toFixed(1), min: String(s.min ?? "—"), blocking: String(s.blocking) };
}

/** How many synthesis loops a run has started, read from its step keys (at least 1). */
export function synthesisLoopCount(steps: ReadonlyArray<{ step_key: string }>): number {
  let max = 0;
  for (const s of steps) {
    const m = /_loop(\d+)$/.exec(s.step_key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Suffix for a Round 3 / Round 4 transcript label. Silent while the run has
 * a single loop (the default), "loop 2 of 3" style once a raised cap has
 * actually revised the candidate.
 */
export function loopLabel(loop: number, loopCount: number): string {
  if (loopCount <= 1) return "";
  return ` (loop ${loop + 1} of ${loopCount})`;
}
