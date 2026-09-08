// Smoke mode (RC-9): the $1 rehearsal every later fix is validated with.
// Pins the budget, the single chunk, the single seat, the loop cap, the
// three-batch policy, the one-reviewer review, the consensus marker carry-over
// and the smoke-seat resolution order.
// Run: cd supabase/functions && deno test boardroom-orchestrator/smoke-mode.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  auditBudgetUsd,
  auditChunksForRun,
  auditMapSeats,
  batchesReviewSeats,
  FULL_LOOP_CAP,
  isSmokeRun,
  keepSmoke,
  loopCap,
  resolveSmokeSource,
  runBudgetUsd,
  SMOKE_BUDGET_USD,
  SMOKE_LOOP_CAP,
  smokeAuditChunks,
  smokeBatchPromptPolicy,
  smokeCoverageNote,
} from "../_shared/smoke-mode.ts";
import { batchPromptPolicy } from "../_shared/batch-count-policy.ts";
import { applySmokeSource, type SeatRow } from "../_shared/openrouter-proxy.ts";
import { validateStepJson } from "./protocol.ts";

// -------- budget --------

Deno.test("runBudgetUsd — full budgets are unchanged per kind", () => {
  assertEquals(runBudgetUsd("test", false), 0.25);
  assertEquals(runBudgetUsd("change_request", false), 3.0);
  assertEquals(runBudgetUsd("batches", false), 3.0);
  assertEquals(runBudgetUsd("plan", false), 10.0);
  assertEquals(runBudgetUsd("design", false), 10.0);
  assertEquals(runBudgetUsd("audit", false), 10.0);
});

Deno.test("runBudgetUsd — every smoke run is capped at $1", () => {
  assertEquals(SMOKE_BUDGET_USD, 1.0);
  for (const kind of ["test", "plan", "design", "batches", "change_request", "audit"]) {
    assertEquals(runBudgetUsd(kind, true), 1.0, kind);
  }
});

Deno.test("auditBudgetUsd — 5 / 12 normally, $1 in smoke mode", () => {
  assertEquals(auditBudgetUsd("batch", false), 5.0);
  assertEquals(auditBudgetUsd("final_az", false), 12.0);
  assertEquals(auditBudgetUsd("batch", true), 1.0);
  assertEquals(auditBudgetUsd("final_az", true), 1.0);
});

// -------- audit: one chunk, one seat --------

Deno.test("auditChunksForRun — smoke keeps only the first chunk", () => {
  const chunks = ["c1", "c2", "c3"];
  assertEquals(auditChunksForRun(chunks, true), ["c1"]);
  assertEquals(auditChunksForRun(chunks, false), chunks);
  assertEquals(auditChunksForRun([], true), []);
});

Deno.test("auditMapSeats — smoke queues the inspector alone; full keeps all three", () => {
  assertEquals([...auditMapSeats(true)], ["inspector"]);
  assertEquals([...auditMapSeats(false)], ["inspector", "contrarian", "strategist"]);
});

Deno.test("smokeAuditChunks — one chunk of N is mapped; zero of zero on an empty repo", () => {
  assertEquals(smokeAuditChunks(7), { mapped: 1, total: 7 });
  assertEquals(smokeAuditChunks(1), { mapped: 1, total: 1 });
  assertEquals(smokeAuditChunks(0), { mapped: 0, total: 0 });
  assertEquals(smokeAuditChunks(Number.NaN), { mapped: 0, total: 0 });
});

Deno.test("smokeCoverageNote — empty on a full audit, honest on a smoke audit", () => {
  assertEquals(smokeCoverageNote({ audit_id: "a", files_analyzed: 200 }), "");
  assertEquals(smokeCoverageNote(null), "");
  assertEquals(smokeCoverageNote({ smoke: "true", smoke_chunks: { mapped: 1, total: 7 } }), "");
  const note = smokeCoverageNote({ smoke: true, smoke_chunks: { mapped: 1, total: 7 } });
  assertStringIncludes(note, "SMOKE REHEARSAL");
  assertStringIncludes(note, "only 1 of 7 code chunks");
  assertStringIncludes(note, "Inspector alone");
  assert(note.startsWith("; "), "appends to the CODE COVERAGE line");
  // Legacy/missing smoke_chunks still says the coverage was one chunk.
  assertStringIncludes(smokeCoverageNote({ smoke: true }), "only the first code chunk");
});

Deno.test("audit-runner / queues.ts — smoke_chunks is stored at seed time and the merge coverage line carries the note", async () => {
  const auditSrc = await Deno.readTextFile(new URL("../audit-runner/index.ts", import.meta.url));
  assertStringIncludes(auditSrc, "consensus.smoke_chunks = smokeAuditChunks(chunks.length)");
  // files_analyzed must count the files in the one chunk a smoke maps, not the repo.
  assertStringIncludes(auditSrc, "filesAnalyzed = smoke ? (chunkFilesFor(res.files)[0]?.length ?? 0) : res.files.length");
  const queuesSrc = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));
  assertStringIncludes(queuesSrc, "+ smokeCoverageNote(run.consensus)");
});

// -------- plan / design: loop cap --------

Deno.test("loopCap — three revision loops normally, none in smoke mode", () => {
  assertEquals(FULL_LOOP_CAP, 3);
  assertEquals(SMOKE_LOOP_CAP, 1);
  assertEquals(loopCap(false), 3);
  assertEquals(loopCap(true), 1);
  // afterStepComplete re-queues Round 3 while nextLoop < loopCap.
  const nextLoopAfterFirstVote = 1;
  assert(nextLoopAfterFirstVote < loopCap(false), "full run loops again");
  assert(!(nextLoopAfterFirstVote < loopCap(true)), "smoke run goes to the ruling");
});

// -------- batches: three batches, one reviewer --------

Deno.test("smokeBatchPromptPolicy — exactly three batches, built on the import floor", () => {
  const p = smokeBatchPromptPolicy();
  assertEquals(p.minBatches, batchPromptPolicy(true).minBatches);
  assertEquals(p.minBatches, 3);
  assertEquals(p.maxBatches, 3);
  assertEquals(p.rangeText, "3");
  assertStringIncludes(p.rangePrompt, "exactly 3");
  assertStringIncludes(p.countRule, "Exactly 3 batches");
  assert(!/6-8|Exactly 6/i.test(p.rangePrompt + p.countRule), "smoke must not ask for six");
});

Deno.test("queues.ts — smoke policy is wired in front of the import/greenfield split for draft and revise", async () => {
  const queuesSrc = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));
  const wired = queuesSrc.match(/isSmokeRun\(run\) \? smokeBatchPromptPolicy\(\) : batchPromptPolicy\(isImport\)/g) ?? [];
  assertEquals(wired.length, 2, "batches_chair and batches_revise_chair both pick the smoke policy");
  assertStringIncludes(queuesSrc, "batchesReviewSeats(isSmokeRun(run)).map");
});

Deno.test("a three-batch smoke draft passes the batches validator", () => {
  const prompt = (n: number) =>
    `Batch ${n} — Smoke slice ${n}. Numbered items only, no scope creep.\n\n` +
    Array.from({ length: 6 }, (_, i) =>
      `${i + 1}. Implement item ${i + 1} of batch ${n}: add the route /smoke-${n}-${i + 1}, the SmokeCard${n}${i + 1} component under src/components, and the smoke_${n}_${i + 1} table with id, user_id and created_at columns exactly as listed in the PRD.`
    ).join("\n") +
    `\n\nAcceptance checks:\n1. Open the preview, navigate to the new route and confirm the screen renders with its heading copy.\n2. Submit the form on that screen and confirm the new row appears in the table view without a console error.\n\nKeep everything else identical.\nTypecheck when done.`;
  const draft = {
    batches: [1, 2, 3].map((n) => ({ batch_no: n, title: `Smoke ${n}`, channel: "lovable", prompt_md: prompt(n) })),
  };
  assertEquals(validateStepJson("batches_chair", draft), null);
});

Deno.test("batchesReviewSeats — smoke reviews with the inspector only", () => {
  assertEquals([...batchesReviewSeats(true)], ["inspector"]);
  assertEquals([...batchesReviewSeats(false)], ["inspector", "contrarian"]);
});

// -------- run marker --------

Deno.test("isSmokeRun — only a literal true on run.consensus.smoke counts", () => {
  assert(isSmokeRun({ consensus: { smoke: true } }));
  assert(!isSmokeRun({ consensus: { smoke: "true" } }));
  assert(!isSmokeRun({ consensus: {} }));
  assert(!isSmokeRun({ consensus: null }));
  assert(!isSmokeRun(null));
});

Deno.test("keepSmoke — carries the marker across a consensus overwrite, never adds it", () => {
  assertEquals(keepSmoke({ consensus: { smoke: true } }, { scores: { a: 1 } }), { scores: { a: 1 }, smoke: true });
  assertEquals(keepSmoke({ consensus: { audit_id: "x" } }, { scores: { a: 1 } }), { scores: { a: 1 } });
});

// -------- smoke seat resolution --------

const row = (seat: string, model_id: string, enabled = true, fallback_model_id: string | null = null): SeatRow => ({
  seat,
  model_id,
  role_prompt: `You are the ${seat}.`,
  enabled,
  fallback_model_id,
  max_cost_per_run: seat === "chair" ? 10 : 5,
});

Deno.test("resolveSmokeSource — an enabled smoke row wins", () => {
  const rows = [row("chair", "m/chair"), row("inspector", "m/inspector"), row("smoke", "m/cheap", true, null)];
  const r = resolveSmokeSource(rows);
  assertEquals(r?.source, "smoke");
  assertEquals(r?.row.model_id, "m/cheap");
});

Deno.test("resolveSmokeSource — no (or disabled, or blank) smoke row falls back to the inspector", () => {
  assertEquals(resolveSmokeSource([row("chair", "m/chair"), row("inspector", "m/inspector")])?.source, "inspector");
  assertEquals(resolveSmokeSource([row("inspector", "m/inspector"), row("smoke", "m/cheap", false)])?.source, "inspector");
  assertEquals(resolveSmokeSource([row("inspector", "m/inspector"), row("smoke", "   ")])?.source, "inspector");
});

Deno.test("resolveSmokeSource — null when neither smoke nor inspector is usable", () => {
  assertEquals(resolveSmokeSource([row("chair", "m/chair"), row("inspector", "m/inspector", false)]), null);
  assertEquals(resolveSmokeSource([]), null);
});

Deno.test("applySmokeSource — borrows model + fallback, keeps the seat's prompt, cap and label", () => {
  const chair = row("chair", "m/chair", true, "m/reserve");
  const rows = [chair, row("inspector", "m/inspector", true, "m/reserve"), row("smoke", "m/cheap", true, null)];
  const applied = applySmokeSource(chair, rows);
  assertEquals(applied.source, "smoke");
  assertEquals(applied.row.seat, "chair");
  assertEquals(applied.row.model_id, "m/cheap");
  assertEquals(applied.row.fallback_model_id, null);
  assertEquals(applied.row.role_prompt, "You are the chair.");
  assertEquals(applied.row.max_cost_per_run, 10);
});

Deno.test("applySmokeSource — inspector when no smoke row; the seat itself when nothing is usable", () => {
  const chair = row("chair", "m/chair", true, "m/reserve");
  const viaInspector = applySmokeSource(chair, [chair, row("inspector", "m/inspector", true, "m/ifb")]);
  assertEquals(viaInspector.source, "inspector");
  assertEquals(viaInspector.row.model_id, "m/inspector");
  assertEquals(viaInspector.row.fallback_model_id, "m/ifb");
  const alone = applySmokeSource(chair, [chair]);
  assertEquals(alone.source, "seat");
  assertEquals(alone.row, chair);
});
