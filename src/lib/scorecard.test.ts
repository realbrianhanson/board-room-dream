import { describe, expect, it } from "vitest";
import {
  formatSeatScore,
  loopLabel,
  readScorecard,
  scorecardVerdictLabel,
  synthesisLoopCount,
} from "./scorecard";

const sc = {
  threshold: 8,
  passed: false,
  seats: {
    strategist: { mean: 8.5, min: 8, blocking: 0 },
    contrarian: { mean: 7.2, min: 6, blocking: 2 },
    inspector: { mean: null, min: null, blocking: 1 },
  },
};

describe("readScorecard", () => {
  it("reads a persisted scorecard off run.consensus", () => {
    const out = readScorecard({ scores: {}, scorecard: sc });
    expect(out).toEqual(sc);
  });
  it("returns null when absent or malformed", () => {
    expect(readScorecard(null)).toBeNull();
    expect(readScorecard({ awaiting: "future_batch" })).toBeNull();
    expect(readScorecard({ scorecard: { passed: true } })).toBeNull();
    expect(readScorecard({ scorecard: { threshold: "x", seats: {} } })).toBeNull();
  });
  it("tolerates a missing seat and coerces bad numbers to null", () => {
    const out = readScorecard({ scorecard: { threshold: 8, passed: "yes", seats: { strategist: { mean: "9", min: 9 } } } });
    expect(out).toEqual({ threshold: 8, passed: false, seats: { strategist: { mean: null, min: 9, blocking: 0 } } });
  });
});

describe("scorecardVerdictLabel / formatSeatScore", () => {
  it("labels the outcome", () => {
    expect(scorecardVerdictLabel(sc)).toBe("Chair ruled");
    expect(scorecardVerdictLabel({ ...sc, passed: true })).toBe("Consensus");
  });
  it("formats a seat row, dashes for a seat with no vote", () => {
    expect(formatSeatScore(sc.seats.strategist)).toEqual({ mean: "8.5", min: "8", blocking: "0" });
    expect(formatSeatScore(sc.seats.contrarian)).toEqual({ mean: "7.2", min: "6", blocking: "2" });
    expect(formatSeatScore(sc.seats.inspector)).toEqual({ mean: "—", min: "—", blocking: "1" });
    expect(formatSeatScore(undefined)).toEqual({ mean: "—", min: "—", blocking: "—" });
  });
});

describe("synthesisLoopCount / loopLabel", () => {
  const step = (k: string) => ({ step_key: k });
  it("counts the loops a run has started from its step keys", () => {
    expect(synthesisLoopCount([])).toBe(1);
    expect(synthesisLoopCount([step("r1_draft_chair"), step("r3_draft_chair_loop0"), step("r4_vote_inspector_loop0")])).toBe(1);
    expect(synthesisLoopCount([step("r4_vote_inspector_loop0"), step("r3_draft_chair_loop2")])).toBe(3);
  });
  it("stays silent on a single-loop run and counts 1-based once loops exist", () => {
    expect(loopLabel(0, 1)).toBe("");
    expect(loopLabel(0, 2)).toBe(" (loop 1 of 2)");
    expect(loopLabel(2, 3)).toBe(" (loop 3 of 3)");
  });
});
