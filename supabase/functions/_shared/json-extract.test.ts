// Batch 4 (RC-3) — tolerant JSON extraction and last-resort truncation
// repair. Fixtures mirror live failures: the c15 redundant closer, fenced
// output, prose after a complete object, a batches_chair draft cut mid-
// string at ~12,900 chars, and a reasoning-eaten batches_review cut at 300
// chars (which must be REFUSED — reviews are single judgments).
// Run: cd supabase/functions && deno test _shared/json-extract.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractJsonCandidate,
  repairTruncatedJson,
  repairTruncatedStepJson,
  stripJsonFences,
  truncationRepairPolicy,
} from "./json-extract.ts";
import { validateStepJson } from "../boardroom-orchestrator/protocol.ts";

// ---------------------------------------------------------------- extract

Deno.test("extractJsonCandidate — plain object parses in strict mode", () => {
  const r = extractJsonCandidate('  {"a":1}  ');
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.mode, "strict");
    assertEquals(r.value, { a: 1 });
  }
});

Deno.test("extractJsonCandidate — exact c15 shape ({findings:[]} plus a stray }) is recovered", () => {
  const live = '{\n  "findings": []\n}\n}';
  const r = extractJsonCandidate(live);
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value, { findings: [] });
    assertEquals(r.mode, "embedded");
  }
});

Deno.test("extractJsonCandidate — ```json fence is stripped (mode fenced)", () => {
  const r = extractJsonCandidate('```json\n{"verdict":"approve","issues":[]}\n```');
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.mode, "fenced");
    assertEquals(r.value, { verdict: "approve", issues: [] });
  }
  const bare = extractJsonCandidate('```\n{"a":[1,2]}\n```');
  assert(bare.ok && bare.mode === "fenced");
});

Deno.test("extractJsonCandidate — object followed by prose is embedded, trailer ignored", () => {
  const r = extractJsonCandidate('{"a":1}\nNote: done');
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.mode, "embedded");
    assertEquals(r.value, { a: 1 });
  }
});

Deno.test("extractJsonCandidate — preamble with a non-JSON brace is skipped to the real value", () => {
  const r = extractJsonCandidate('Here is the {vote} you asked for:\n{"scores":{"x":8}}\nThanks.');
  assert(r.ok);
  if (r.ok) assertEquals(r.value, { scores: { x: 8 } });
});

Deno.test("extractJsonCandidate — refuses truncated, bare-scalar and empty input", () => {
  assertEquals(extractJsonCandidate('{"a":[1,2').ok, false);
  assertEquals(extractJsonCandidate('```json\n{"a":"cut').ok, false);
  assertEquals(extractJsonCandidate("42").ok, false);
  assertEquals(extractJsonCandidate('"hello"').ok, false);
  assertEquals(extractJsonCandidate("").ok, false);
});

Deno.test("stripJsonFences — strips each side independently", () => {
  assertEquals(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  assertEquals(stripJsonFences('```json\n{"a":1'), '{"a":1');
  assertEquals(stripJsonFences('{"a":1}'), '{"a":1}');
});

// ----------------------------------------------------------------- repair

const finding = (i: number) => ({
  severity: i === 0 ? "P0" : "P2",
  file_path: `src/file_${i}.ts`,
  title: `Finding ${i}`,
  description: "Something concrete is broken here and this is why it matters.",
  evidence: i === 0 ? "QUOTE: const x = secret | WHY: the key is committed" : "a concrete construct",
  confidence: "high",
  line_start: 1,
  line_end: 2,
});

Deno.test("repairTruncatedJson — audit map cut mid-string keeps the complete findings", () => {
  const full = JSON.stringify({ findings: [finding(0), finding(1), finding(2)] });
  // Cut inside finding 2's description.
  const cutAt = full.lastIndexOf("Something concrete") + 12;
  const cut = full.slice(0, cutAt);
  const r = repairTruncatedJson(cut, { maxDepth: 6 });
  assert(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    const v = r.value as { findings: unknown[] };
    assertEquals(v.findings.length, 2);
    assertEquals(r.dropped_chars, cut.length - (cut.lastIndexOf("}") + 1));
    assert(r.dropped_chars > 0);
  }
});

Deno.test("repairTruncatedJson — live merge fixture (ddf72827) cut inside the second finding", () => {
  const truncated =
    '{"verdict":"findings","summary":"ok","findings":[{"severity":"P0","file_path":"src/routes/_authenticated/plan.$projectId.tsx","title":"RLS bypass","description":"..","evidence":"..","confidence":"high","line_start":1,"line_end":2},{"severity":"P1","file_path":"src/rou';
  const r = repairTruncatedJson(truncated);
  assert(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    const v = r.value as { verdict: string; findings: unknown[] };
    assertEquals(v.verdict, "findings");
    assertEquals(v.findings.length, 1);
  }
});

Deno.test("repairTruncatedJson — no complete element boundary is refused", () => {
  assertEquals(repairTruncatedJson('{"findings":[{"severity":"P0","title":"abc').ok, false);
  // A closer nested deeper than 2 (files array inside a batch) is not a boundary.
  assertEquals(repairTruncatedJson('{"batches":[{"files":["a","b"],"title":"cut').ok, false);
  assertEquals(repairTruncatedJson("").ok, false);
  assertEquals(repairTruncatedJson("no json here").ok, false);
});

Deno.test("repairTruncatedJson — nesting deeper than maxDepth is refused; a closed root only drops the trailer", () => {
  assertEquals(repairTruncatedJson('{"a":{"b":{"c":{"d":{"e":{"f":{"g":1', { maxDepth: 6 }).ok, false);
  const r = repairTruncatedJson('{"a":[1]} trailing');
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value, { a: [1] });
    assertEquals(r.dropped_chars, " trailing".length);
  }
});

Deno.test("repairTruncatedJson — mismatched delimiter is refused", () => {
  assertEquals(repairTruncatedJson('{"a":[1,2}').ok, false);
});

// ------------------------------------------------------------ step policy

// Human-channel batches pass validateStepJson (300-2,400 chars, no
// acceptance-check / typecheck lines) so a repaired plan can be validated
// end-to-end exactly as executeStep does.
function makeBatches(n: number, promptLen = 1500) {
  return Array.from({ length: n }, (_, i) => {
    const head = `Batch ${i + 1} — human step.\n\n1. Step one is a plain-language action the student takes in an external console. `;
    return {
      batch_no: i + 1,
      title: `Batch ${i + 1}`,
      channel: "human",
      prompt_md: head + "x".repeat(Math.max(0, promptLen - head.length)),
    };
  });
}

Deno.test("truncationRepairPolicy — allow-list and minimum counts", () => {
  assertEquals(truncationRepairPolicy("batches_chair"), { allowed: true, listKey: "batches", minCount: 6 });
  assertEquals(truncationRepairPolicy("batches_chair", { isImport: true }), { allowed: true, listKey: "batches", minCount: 3 });
  assertEquals(truncationRepairPolicy("batches_revise_chair", { isImport: false }), { allowed: true, listKey: "batches", minCount: 6 });
  assertEquals(truncationRepairPolicy("audit_chair_merge"), { allowed: true, listKey: "findings", minCount: 1 });
  assertEquals(truncationRepairPolicy("audit_inspector_c15"), { allowed: true, listKey: "findings", minCount: 1 });
  assertEquals(truncationRepairPolicy("audit_reserve"), { allowed: true, listKey: "findings", minCount: 1 });
  for (const k of ["batches_review_inspector", "batches_review_contrarian", "r4_vote_inspector_loop0", "cr_exam_chair", "cr_review_inspector", "cr_verdict_chair", "r2_exam_strategist", "r3_extract_chair_loop0", "r5_blueprint_extract_chair", ""]) {
    assertEquals(truncationRepairPolicy(k), { allowed: false }, `must not repair ${k}`);
  }
});

Deno.test("repairTruncatedStepJson — ~12,900-char batches_chair draft cut mid-string keeps 7 complete batches", () => {
  const full = JSON.stringify({ batches: makeBatches(8, 1580) });
  assert(full.length > 12_900, `fixture must exceed 12,900 chars (got ${full.length})`);
  const cut = full.slice(0, 12_900);
  // Sanity: the cut lands inside a prompt_md string.
  assert(!cut.endsWith("}"));
  const r = repairTruncatedStepJson("batches_chair", cut, { isImport: false });
  assert(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    const v = r.value as { batches: Array<{ batch_no: number }> };
    assertEquals(v.batches.length, 7);
    assertEquals(v.batches.map((b) => b.batch_no), [1, 2, 3, 4, 5, 6, 7]);
    assert(r.dropped_chars > 0);
    // The repaired value must still satisfy the step contract.
    assertEquals(validateStepJson("batches_chair", v), null);
  }
});

Deno.test("repairTruncatedStepJson — batches cut with only 5 complete batches is refused for greenfield, accepted for import", () => {
  const full = JSON.stringify({ batches: makeBatches(6, 1500) });
  const cut = full.slice(0, full.lastIndexOf("Batch 6 — human") + 5);
  const green = repairTruncatedStepJson("batches_chair", cut, { isImport: false });
  assertEquals(green.ok, false);
  if (!green.ok) assert(/minimum 6/.test(green.reason), green.reason);
  const unknown = repairTruncatedStepJson("batches_chair", cut);
  assertEquals(unknown.ok, false, "unknown import flag must use the stricter greenfield minimum");
  const imp = repairTruncatedStepJson("batches_chair", cut, { isImport: true });
  assert(imp.ok, imp.ok ? "" : imp.reason);
  if (imp.ok) {
    assertEquals((imp.value as { batches: unknown[] }).batches.length, 5);
    assertEquals(validateStepJson("batches_chair", imp.value), null);
  }
});

Deno.test("repairTruncatedStepJson — batches_review cut at 300 chars is refused (not allow-listed)", () => {
  const full = JSON.stringify({
    verdict: "revise",
    issues: [
      { batch_no: 1, severity: "blocking", text: "Batch 1 references src/nope.tsx which is not in the repo — use src/routes/index.tsx instead of inventing a path." },
      { batch_no: 2, severity: "major", text: "Batch 2 duplicates the migration already shipped in batch 1; drop the second CREATE TABLE." },
      { batch_no: 3, severity: "minor", text: "Batch 3 acceptance checks do not name the route being verified." },
    ],
  });
  const cut = full.slice(0, 300);
  const r = repairTruncatedStepJson("batches_review_inspector", cut);
  assertEquals(r.ok, false);
  if (!r.ok) assert(/not allowed/.test(r.reason), r.reason);
  // Same input, a vote key: also refused.
  assertEquals(repairTruncatedStepJson("r4_vote_inspector_loop1", cut).ok, false);
});

Deno.test("repairTruncatedStepJson — audit map cut before the first complete finding is refused", () => {
  const cut = '{"findings":[{"severity":"P0","file_path":"src/a.ts","title":"Leaked key","description":"the ser';
  const r = repairTruncatedStepJson("audit_inspector_c3", cut);
  assertEquals(r.ok, false);
  const okCut = JSON.stringify({ findings: [finding(0), finding(1)] }).slice(0, -20);
  const r2 = repairTruncatedStepJson("audit_inspector_c3", okCut);
  assert(r2.ok, r2.ok ? "" : r2.reason);
  if (r2.ok) assertEquals((r2.value as { findings: unknown[] }).findings.length, 1);
});

Deno.test("repairTruncatedStepJson — repaired merge passes validateStepJson(audit_chair_merge)", () => {
  const full = JSON.stringify({ verdict: "findings", summary: "two findings", findings: [finding(0), finding(1)], fix_prompt_md: "Batch 1.1 — fix" });
  const cut = full.slice(0, full.indexOf('"fix_prompt_md"') - 1);
  const r = repairTruncatedStepJson("audit_chair_merge", cut);
  assert(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    assertEquals(validateStepJson("audit_chair_merge", r.value), null);
    assertEquals((r.value as { findings: unknown[] }).findings.length, 2);
  }
});
