import { describe, expect, it } from "vitest";
import {
  computeVoteSegments,
  segmentArcPath,
  SEAT_ORDER,
  type VoteStep,
} from "./vote-ring-segments";

const RUBRIC = ["clarity", "risk", "feasibility"] as const;

function mkVote(
  seat: VoteStep["seat"],
  loop: number,
  scores: Record<string, number> | null,
  status: VoteStep["status"] = "completed",
): VoteStep {
  return {
    seat,
    round: 4,
    status,
    step_key: `r4_vote_${seat}_loop${loop}`,
    response_json: scores === null ? {} : { scores },
  };
}

describe("computeVoteSegments", () => {
  it("emits rubricSize segments per voting seat in rubric order", () => {
    const steps: VoteStep[] = [
      mkVote("chair", 0, { clarity: 9, risk: 7, feasibility: 8 }),
      mkVote("strategist", 0, { clarity: 6, risk: 9, feasibility: 8 }),
      mkVote("contrarian", 0, { clarity: 8, risk: 5, feasibility: 8 }),
      mkVote("inspector", 0, { clarity: 9, risk: 9, feasibility: 9 }),
    ];
    const segs = computeVoteSegments(steps, [...RUBRIC]);
    expect(segs).toHaveLength(4 * RUBRIC.length);
    // Chair first (SEAT_ORDER order), rubric in declared order.
    expect(segs.slice(0, 3).map((s) => s.seat)).toEqual(["chair", "chair", "chair"]);
    expect(segs.slice(0, 3).map((s) => s.rubricIdx)).toEqual([0, 1, 2]);
    // Scores >= 8 map to brass, < 8 map to oxblood, missing maps to empty.
    expect(segs[0].result).toBe("brass");
    expect(segs[1].result).toBe("oxblood");
    expect(segs[2].result).toBe("brass");
  });

  it("drops Chair from the voting order when Chair has no vote this loop", () => {
    const steps: VoteStep[] = [
      mkVote("strategist", 1, { clarity: 9, risk: 9, feasibility: 9 }),
      mkVote("contrarian", 1, { clarity: 6, risk: 6, feasibility: 6 }),
      mkVote("inspector",  1, { clarity: 9, risk: 9, feasibility: 9 }),
    ];
    const segs = computeVoteSegments(steps, [...RUBRIC]);
    expect(segs).toHaveLength(3 * RUBRIC.length);
    // Voting order must skip Chair AND preserve SEAT_ORDER identity.
    const seatIdentity = Array.from(new Set(segs.map((s) => s.seat)));
    expect(seatIdentity).toEqual(["strategist", "contrarian", "inspector"]);
    // Regression: each seat's segments must be tagged with THAT seat, not
    // shifted onto the Chair's angle just because Chair was dropped.
    expect(segs.slice(0, 3).every((s) => s.seat === "strategist")).toBe(true);
  });

  it("picks the latest loop only", () => {
    const steps: VoteStep[] = [
      mkVote("strategist", 0, { clarity: 4, risk: 4, feasibility: 4 }),
      mkVote("contrarian", 0, { clarity: 4, risk: 4, feasibility: 4 }),
      mkVote("inspector",  0, { clarity: 4, risk: 4, feasibility: 4 }),
      mkVote("strategist", 2, { clarity: 9, risk: 9, feasibility: 9 }),
      mkVote("contrarian", 2, { clarity: 9, risk: 9, feasibility: 9 }),
      mkVote("inspector",  2, { clarity: 9, risk: 9, feasibility: 9 }),
    ];
    const segs = computeVoteSegments(steps, [...RUBRIC]);
    expect(segs.every((s) => s.result === "brass")).toBe(true);
  });

  it("marks missing rubric keys as empty", () => {
    const steps: VoteStep[] = [
      mkVote("strategist", 0, { clarity: 9 }),
      mkVote("contrarian", 0, { clarity: 9, risk: 9, feasibility: 9 }),
      mkVote("inspector",  0, { clarity: 9, risk: 9, feasibility: 9 }),
    ];
    const segs = computeVoteSegments(steps, [...RUBRIC]);
    const strat = segs.filter((s) => s.seat === "strategist");
    expect(strat.map((s) => s.result)).toEqual(["brass", "empty", "empty"]);
  });

  it("SEAT_ORDER matches the canonical seating around the table", () => {
    expect(SEAT_ORDER).toEqual(["chair", "strategist", "contrarian", "inspector"]);
  });
});

describe("segmentArcPath", () => {
  const geom = { cx: 360, cy: 180, ringRx: 326, ringRy: 166 };

  it("returns null for empty segments", () => {
    expect(segmentArcPath({ seat: "strategist", rubricIdx: 0, result: "empty" }, 3, geom)).toBeNull();
  });

  it("positions each seat around its actual angle, not by array index", () => {
    // Strategist (right, angle 0) must sit near cx+ringRx / cy.
    const s = segmentArcPath({ seat: "strategist", rubricIdx: 1, result: "brass" }, 3, geom)!;
    // Chair (top, angle 3π/2) must sit near cx / cy-ringRy.
    const c = segmentArcPath({ seat: "chair", rubricIdx: 1, result: "brass" }, 3, geom)!;
    // Parse the first coord out of "M x y A …" for a rough position check.
    const parse = (d: string) => {
      const m = /^M\s+([-\d.]+)\s+([-\d.]+)/.exec(d)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    const sp = parse(s.d), cp = parse(c.d);
    // Strategist sits to the right of the table.
    expect(sp.x).toBeGreaterThan(geom.cx + 200);
    // Chair sits above the table.
    expect(cp.y).toBeLessThan(geom.cy - 100);
  });

  it("Chair-abstain regression: Strategist segments do NOT land at Chair's top position", () => {
    // Before the fix, the first voting seat's segments were laid out at
    // angles[0] (the Chair angle, top of the table) whenever Chair abstained.
    const s = segmentArcPath({ seat: "strategist", rubricIdx: 1, result: "brass" }, 3, geom)!;
    const parse = (d: string) => {
      const m = /^M\s+([-\d.]+)\s+([-\d.]+)/.exec(d)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    const p = parse(s.d);
    // Must NOT be near the top-center (Chair's position).
    expect(p.y).toBeGreaterThan(geom.cy - 60);
  });

  it("stroke reflects the segment result", () => {
    const brass = segmentArcPath({ seat: "contrarian", rubricIdx: 0, result: "brass" }, 3, geom)!;
    const ox = segmentArcPath({ seat: "contrarian", rubricIdx: 0, result: "oxblood" }, 3, geom)!;
    expect(brass.stroke).toBe("brass");
    expect(ox.stroke).toBe("oxblood");
  });
});
