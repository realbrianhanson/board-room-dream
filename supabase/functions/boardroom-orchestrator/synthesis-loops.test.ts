// Three-round council: one synthesis loop by default, the vote persisted as
// a scorecard. Pins the loop cap (default, admin setting, clamp, smoke), the
// scorecard derivation from the stored vote steps, the ruling copy, and the
// orchestrator / queues wiring.
// Run: cd supabase/functions && deno test boardroom-orchestrator/synthesis-loops.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_SYNTHESIS_LOOPS,
  deferredDecisionEntries,
  MAX_SYNTHESIS_LOOPS,
  scorecardDecisionEntry,
  synthesisLoopCap,
  synthesisLoopsPhrase,
  voteScorecard,
  VOTING_SEATS,
} from "./protocol.ts";
import { FULL_LOOP_CAP, SMOKE_LOOP_CAP } from "../_shared/smoke-mode.ts";

const full = { consensus: null };
const smoke = { consensus: { smoke: true } };

// -------- loop cap --------

Deno.test("synthesisLoopCap — one loop by default, whatever the run carries", () => {
  assertEquals(DEFAULT_SYNTHESIS_LOOPS, 1);
  assertEquals(synthesisLoopCap(full, null), 1);
  assertEquals(synthesisLoopCap(full, undefined), 1);
  assertEquals(synthesisLoopCap(full, {}), 1);
  assertEquals(synthesisLoopCap(full, { loops: "many" }), 1);
  assertEquals(synthesisLoopCap({ consensus: { scores: {} } }, null), 1);
  assertEquals(synthesisLoopCap(null, null), 1);
  // afterStepComplete re-queues Round 3 while nextLoop < cap: after the
  // first vote nextLoop is 1, so a default run goes straight to the ruling.
  assert(!(1 < synthesisLoopCap(full, null)), "default run rules after the first vote");
});

Deno.test("synthesisLoopCap — the admin setting is honoured and clamped to 1..3", () => {
  assertEquals(MAX_SYNTHESIS_LOOPS, FULL_LOOP_CAP);
  assertEquals(synthesisLoopCap(full, { loops: 2 }), 2);
  assertEquals(synthesisLoopCap(full, { loops: 3 }), 3);
  assertEquals(synthesisLoopCap(full, { loops: "2" }), 2);
  assertEquals(synthesisLoopCap(full, { loops: 2.9 }), 2);
  assertEquals(synthesisLoopCap(full, { loops: 0 }), 1);
  assertEquals(synthesisLoopCap(full, { loops: -4 }), 1);
  assertEquals(synthesisLoopCap(full, { loops: 7 }), 3);
  assert(1 < synthesisLoopCap(full, { loops: 3 }), "a raised cap loops again after the first vote");
});

Deno.test("synthesisLoopCap — a smoke run is always one loop", () => {
  assertEquals(SMOKE_LOOP_CAP, 1);
  assertEquals(synthesisLoopCap(smoke, null), 1);
  assertEquals(synthesisLoopCap(smoke, { loops: 3 }), 1);
});

Deno.test("synthesisLoopsPhrase — derives the ruling copy from the loops actually run", () => {
  assertEquals(synthesisLoopsPhrase(1), "the synthesis loop");
  assertEquals(synthesisLoopsPhrase(0), "the synthesis loop");
  assertEquals(synthesisLoopsPhrase(2), "two synthesis loops");
  assertEquals(synthesisLoopsPhrase(3), "three synthesis loops");
  assertEquals(synthesisLoopsPhrase(4), "4 synthesis loops");
});

// -------- scorecard --------

const PLAN = ["painful_problem", "reachable_buyer", "monetization_path", "buildable_scope", "differentiation", "wow_factor"];

function vote(seat: string, values: number[] | null, blocking: string[] = [], loop = 0) {
  const scores = values ? Object.fromEntries(PLAN.map((k, i) => [k, values[i]])) : null;
  return {
    seat,
    step_key: `r4_vote_${seat}_loop${loop}`,
    status: "completed",
    response_json: { scores, blocking_objections: blocking },
  };
}

Deno.test("voteScorecard — mean, min and blocking count per voting seat", () => {
  const votes = [
    vote("strategist", [9, 8, 8, 9, 8, 9]),
    vote("contrarian", [7, 8, 6, 8, 8, 8], ["No pricing page"]),
    vote("inspector", [8, 8, 8, 8, 8, 8]),
  ];
  const sc = voteScorecard(votes, "plan", 8, false);
  assertEquals(sc.threshold, 8);
  assertEquals(sc.passed, false);
  assertEquals(Object.keys(sc.seats), [...VOTING_SEATS]);
  assertEquals(sc.seats.strategist, { mean: 8.5, min: 8, blocking: 0 });
  assertEquals(sc.seats.contrarian, { mean: 7.5, min: 6, blocking: 1 });
  assertEquals(sc.seats.inspector, { mean: 8, min: 8, blocking: 0 });
});

Deno.test("voteScorecard — a missing seat is tolerated; an unparseable vote reads as no score", () => {
  const votes = [
    vote("strategist", [9, 9, 9, 9, 9, 9]),
    vote("inspector", null, ["vote_unparseable"]),
  ];
  const sc = voteScorecard(votes, "plan", 8, false);
  assertEquals(sc.seats.strategist, { mean: 9, min: 9, blocking: 0 });
  assertEquals(sc.seats.contrarian, { mean: null, min: null, blocking: 0 });
  assertEquals(sc.seats.inspector, { mean: null, min: null, blocking: 1 });
});

Deno.test("voteScorecard — scores the rubric of the run kind and ignores the Chair", () => {
  const design = ["distinctiveness", "premium_feel", "usability", "buildable_in_lovable", "coherence", "signature_element"];
  const dv = (seat: string, n: number) => ({
    seat,
    step_key: `r4_vote_${seat}_loop0`,
    status: "completed",
    response_json: { scores: Object.fromEntries(design.map((k) => [k, n])), blocking_objections: [] },
  });
  const sc = voteScorecard([dv("chair", 10), dv("strategist", 8), dv("contrarian", 9), dv("inspector", 8)], "design", 8, true);
  assertEquals(sc.passed, true);
  assertEquals(sc.seats.strategist.mean, 8);
  assertEquals(sc.seats.contrarian.mean, 9);
  assert(!("chair" in sc.seats));
});

Deno.test("scorecardDecisionEntry — a decision_log entry the plan page can render", () => {
  const sc = voteScorecard([vote("strategist", [8, 8, 8, 8, 8, 8]), vote("contrarian", [7, 7, 7, 7, 7, 7], ["x"])], "plan", 8, false);
  const entry = scorecardDecisionEntry(sc);
  assertEquals(entry.from_seat, "board");
  assertEquals(entry.decision, "scorecard");
  assertEquals(entry.scorecard, sc);
  assertStringIncludes(String(entry.reason), "Chair ruled at threshold 8");
  assertStringIncludes(String(entry.reason), "strategist 8 (min 8), 0 blocking");
  assertStringIncludes(String(entry.reason), "contrarian 7 (min 7), 1 blocking");
  assertStringIncludes(String(entry.reason), "inspector no score, 0 blocking");
  assertStringIncludes(String(scorecardDecisionEntry({ ...sc, passed: true }).reason), "Consensus at threshold 8");
});

Deno.test("deferredDecisionEntries — the scorecard entry never rides into the batches harvest block", () => {
  const sc = voteScorecard([vote("strategist", [8, 8, 8, 8, 8, 8])], "plan", 8, false);
  const debated = { from_seat: "contrarian", objection: "No pricing page", decision: "rejected", reason: "later" };
  const ruled = { from_seat: "chair", decision: "ruled", reason: "Shipping without pricing." };
  assertEquals(deferredDecisionEntries([debated, ruled, scorecardDecisionEntry(sc)]), [debated, ruled]);
  assertEquals(deferredDecisionEntries([scorecardDecisionEntry(sc)]), []);
  assertEquals(deferredDecisionEntries([]), []);
  assertEquals(deferredDecisionEntries(null), null);
  assertEquals(deferredDecisionEntries(undefined), undefined);
});

// -------- wiring --------

Deno.test("index.ts — the Round-4 advance asks the loop cap, and the lock persists the scorecard", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(src, "if (nextLoop < await resolveSynthesisLoopCap(admin, run))");
  assert(!src.includes("loopCap("), "the fixed smoke/full cap no longer decides");
  assertEquals(src.match(/voteScorecard\(latestVotes, run\.kind, threshold, mode === "consensus"\)/g)?.length, 1);
  assertStringIncludes(src, "decisionLog.push(scorecardDecisionEntry(scorecard))");
  // Both the design lock and the plan lock carry it on run.consensus, and
  // the blueprint finalization does not drop it.
  assertEquals(src.match(/scores, scorecard, plan_version_id/g)?.length, 1);
  assertEquals(src.match(/\n\s+scores,\n\s+scorecard,\n\s+plan_version_id/g)?.length, 1);
  assertStringIncludes(src, "scorecard: meta.scorecard");
});

Deno.test("queues.ts — the final ruling names the loops actually run, never a fixed three", async () => {
  const src = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));
  assertStringIncludes(src, "after ${synthesisLoopsPhrase(lastLoop)}");
  assert(!src.includes("three synthesis loops"));
});

Deno.test("queues.ts — the batches deferred-value block reads the decision log through deferredDecisionEntries", async () => {
  const src = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));
  assertStringIncludes(src, "decision_log: deferredDecisionEntries((plan as any)?.decision_log ?? null)");
});
