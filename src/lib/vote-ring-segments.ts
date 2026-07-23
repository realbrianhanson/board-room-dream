// Pure helpers for the Boardroom vote-ring visualization.
//
// The Chair may abstain on its own synthesis in current runs. The previous
// implementation collapsed voting seats into a dense array [strategist,
// contrarian, inspector] and then indexed them into the 4-seat angle array
// as if they were positions 0/1/2 — mapping the Strategist's votes onto the
// Chair's angle at the top of the table. The fix keeps each segment
// tagged with the actual voting seat so geometry looks up the correct
// angle by SEAT_ORDER identity, not by dense array index.

export type Seat = "chair" | "strategist" | "contrarian" | "inspector";
export const SEAT_ORDER: Seat[] = ["chair", "strategist", "contrarian", "inspector"];

export type VoteResult = "empty" | "brass" | "oxblood";

/** One rubric cell for one voting seat. */
export type VoteSegment = {
  seat: Seat;
  rubricIdx: number;
  result: VoteResult;
};

export type VoteStep = {
  seat: Seat;
  round: number;
  status: string;
  step_key: string;
  response_json: unknown;
};

/**
 * Compute the ordered vote segments for the current voting loop.
 *
 * Rules:
 *   - Only round 4, `completed` steps whose key starts with `r4_vote_` count.
 *   - The latest loop wins (`…_loop<n>` suffix).
 *   - Voting seats = SEAT_ORDER minus Chair when Chair has no vote in this loop.
 *   - Emit exactly `rubric.length` segments per voting seat, in rubric order.
 *   - Each segment carries the seat identity so downstream geometry can
 *     look up the correct angle without depending on array position.
 */
export function computeVoteSegments(
  steps: readonly VoteStep[],
  rubric: readonly string[],
): VoteSegment[] {
  const voteSteps = steps.filter(
    (s) => s.round === 4 && s.status === "completed" && s.step_key.startsWith("r4_vote_"),
  );
  let latestLoop = -1;
  for (const v of voteSteps) {
    const m = /_loop(\d+)$/.exec(v.step_key);
    if (m) latestLoop = Math.max(latestLoop, Number(m[1]));
  }
  const latest = voteSteps.filter((v) => v.step_key.endsWith(`_loop${latestLoop}`));
  const bySeat = new Map<Seat, VoteStep>();
  for (const v of latest) if (SEAT_ORDER.includes(v.seat)) bySeat.set(v.seat, v);
  const votingOrder = SEAT_ORDER.filter((s) => s !== "chair" || bySeat.has("chair"));
  const out: VoteSegment[] = [];
  for (const seat of votingOrder) {
    const v = bySeat.get(seat);
    const scores = (v?.response_json as { scores?: Record<string, number> } | undefined)?.scores;
    for (let i = 0; i < rubric.length; i++) {
      const key = rubric[i];
      const raw = scores ? scores[key] : undefined;
      const result: VoteResult =
        typeof raw !== "number" ? "empty" : raw >= 8 ? "brass" : "oxblood";
      out.push({ seat, rubricIdx: i, result });
    }
  }
  return out;
}

export type SegmentArc = {
  d: string;
  stroke: "brass" | "oxblood";
};

/**
 * Compute the SVG arc path for one non-empty segment, positioning it by
 * the seat's actual angle around the table (Chair top / Strategist right /
 * Contrarian bottom / Inspector left) — never by dense array index.
 * Returns null for empty segments so callers can skip rendering them.
 */
export function segmentArcPath(
  seg: VoteSegment,
  rubricSize: number,
  geom: { cx: number; cy: number; ringRx: number; ringRy: number },
): SegmentArc | null {
  if (seg.result === "empty") return null;
  const angles: Record<Seat, number> = {
    chair: Math.PI * 1.5,
    strategist: 0,
    contrarian: Math.PI * 0.5,
    inspector: Math.PI,
  };
  const seatAngle = angles[seg.seat];
  const arcSpan = Math.PI / 3.2; // ~56° per seat cluster
  const segStep = arcSpan / Math.max(1, rubricSize);
  const segLen = segStep * 0.72;
  const center = seatAngle - arcSpan / 2 + segStep * (seg.rubricIdx + 0.5);
  const t0 = center - segLen / 2;
  const t1 = center + segLen / 2;
  const { cx, cy, ringRx, ringRy } = geom;
  const x0 = cx + ringRx * Math.cos(t0);
  const y0 = cy + ringRy * Math.sin(t0);
  const x1 = cx + ringRx * Math.cos(t1);
  const y1 = cy + ringRy * Math.sin(t1);
  return {
    d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${ringRx} ${ringRy} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    stroke: seg.result,
  };
}
