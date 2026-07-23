// VOTE-JSON-EOF-RECOVERY — conservative EOF-closer recovery for non-audit
// JSON steps (Round-4 vote, cr_exam_*, batches_*, etc.). Reproduces the live
// run 125ab4c0 failure where a complete vote object was emitted missing only
// the final top-level "}".
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tryCloseJsonTail } from "./audit-findings.ts";

const goodVote = () => ({
  scores: { painful_problem: 8, reachable_buyer: 8, monetization_path: 8, buildable_scope: 9, differentiation: 8, wow_factor: 8 },
  objection_resolutions: [
    { objection: "unclear buyer", status: "resolved", evidence_quote: "verbatim" },
  ],
  blocking_objections: [],
  comment: "Solid pass.",
});

Deno.test("generic — recovers exact live vote shape missing final top-level }", () => {
  const full = JSON.stringify(goodVote());
  const truncated = full.slice(0, -1); // drop final "}"
  const r = tryCloseJsonTail(truncated, { shape: "generic" });
  assert(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    assertEquals(r.closed, "}");
    assertEquals((r.value as { comment: string }).comment, "Solid pass.");
  }
});

Deno.test("generic — recovers missing outer ]}", () => {
  // Exact minimal valid prefix missing only "]}" at the tail.
  const truncated = '{"a":[1,2';
  const r = tryCloseJsonTail(truncated, { shape: "generic" });
  assert(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    assertEquals(r.closed, "]}");
    assertEquals(r.value, { a: [1, 2] });
  }
});

Deno.test("generic — rejects dangling empty container", () => {
  const r = tryCloseJsonTail('{"a":[', { shape: "generic" });
  // A dangling "[" with no value is ambiguous; recovery should refuse.
  assertEquals(r.ok, false);
});

Deno.test("generic — braces inside escaped strings are ignored", () => {
  const doc = { comment: "he said \"}\" and left", scores: { a: 1 } };
  const full = JSON.stringify(doc);
  const truncated = full.slice(0, -1);
  const r = tryCloseJsonTail(truncated, { shape: "generic" });
  assert(r.ok);
  if (r.ok) assertEquals((r.value as { comment: string }).comment, 'he said "}" and left');
});

Deno.test("generic — rejects unterminated string", () => {
  const r = tryCloseJsonTail('{"comment":"oops', { shape: "generic" });
  assertEquals(r.ok, false);
});

Deno.test("generic — rejects mismatched closer", () => {
  const r = tryCloseJsonTail('{"a":[1,2}', { shape: "generic" });
  assertEquals(r.ok, false);
});

Deno.test("generic — rejects trailing garbage / second value", () => {
  const r = tryCloseJsonTail('{"a":1} garbage', { shape: "generic" });
  assertEquals(r.ok, false);
});

Deno.test("generic — refuses >2 missing closers", () => {
  // Three unclosed containers.
  const r = tryCloseJsonTail('{"a":{"b":{"c":[1', { shape: "generic" });
  assertEquals(r.ok, false);
  if (!r.ok) assert(/max 2|refusing to append/.test(r.reason));
});

Deno.test("generic — ordinary valid JSON returns unchanged (closed = \"\")", () => {
  const full = JSON.stringify(goodVote());
  const r = tryCloseJsonTail(full, { shape: "generic" });
  assert(r.ok);
  if (r.ok) assertEquals(r.closed, "");
});

Deno.test("generic — rejects bare string/number as root", () => {
  assertEquals(tryCloseJsonTail('"hello"', { shape: "generic" }).ok, false);
  assertEquals(tryCloseJsonTail('42', { shape: "generic" }).ok, false);
});

Deno.test("map shape — >2 missing closers still rejected (regression guard)", () => {
  const r = tryCloseJsonTail('{"findings":[{"a":{"b":[1');
  assertEquals(r.ok, false);
});
