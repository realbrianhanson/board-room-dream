// AUDIT-JSON-RECOVERY-R5 — bounded deterministic trailing-redundant-closer
// recovery. Run: cd supabase/functions && deno test _shared/audit-json-recovery-r5.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tryRecoverTrailingRedundantCloser } from "./audit-findings.ts";

Deno.test("R5 — exact c15 shape recovers to {findings:[]}", () => {
  const live = '{\n  "findings": []\n}\n}';
  const r = tryRecoverTrailingRedundantCloser(live);
  assert(r.ok, `expected ok, got: ${JSON.stringify(r)}`);
  if (r.ok) assertEquals(r.value, { findings: [] });
});

Deno.test("R5 — multiple trailing object closers with whitespace recover", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1}\n}\n }  }');
  assert(r.ok);
  if (r.ok) assertEquals(r.value, { a: 1 });
});

Deno.test("R5 — array top-level with trailing extra ]", () => {
  const r = tryRecoverTrailingRedundantCloser('[1,2,3]\n]');
  assert(r.ok);
  if (r.ok) assertEquals(r.value, [1, 2, 3]);
});

Deno.test("R5 — object followed by ] (mismatched closer kind) is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1}\n]');
  assertEquals(r.ok, false);
});

Deno.test("R5 — array followed by } (mismatched closer kind) is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('[1,2]\n}');
  assertEquals(r.ok, false);
});

Deno.test("R5 — object followed by prose is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1}\nhere is some prose');
  assertEquals(r.ok, false);
});

Deno.test("R5 — object followed by comma is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1},');
  assertEquals(r.ok, false);
});

Deno.test("R5 — object followed by second object is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1}{"b":2}');
  assertEquals(r.ok, false);
});

Deno.test("R5 — object followed by fenced code is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1}\n```json\n{}\n```');
  assertEquals(r.ok, false);
});

Deno.test("R5 — unterminated string is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":"oops');
  assertEquals(r.ok, false);
});

Deno.test("R5 — unterminated object is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":1');
  assertEquals(r.ok, false);
});

Deno.test("R5 — braces inside strings do not confuse balancing", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":"} } {","b":[1]}\n}');
  assert(r.ok);
  if (r.ok) assertEquals(r.value, { a: "} } {", b: [1] });
});

Deno.test("R5 — escaped quote inside string does not end the string", () => {
  const r = tryRecoverTrailingRedundantCloser('{"a":"he said \\"hi\\" }"}\n}');
  assert(r.ok);
  if (r.ok) assertEquals((r.value as any).a, 'he said "hi" }');
});

Deno.test("R5 — valid strict JSON with only whitespace tail returns unchanged value", () => {
  // Strict-valid input is technically parseable, but this helper only decides
  // "can I recover"; caller runs it AFTER strict parse fails. Still, invoking
  // it directly on already-valid JSON must return the same value and never
  // corrupt it.
  const r = tryRecoverTrailingRedundantCloser('{"a":1}\n');
  assert(r.ok);
  if (r.ok) assertEquals(r.value, { a: 1 });
});

Deno.test("R5 — non-object/array root (bare string/number) is rejected", () => {
  assertEquals(tryRecoverTrailingRedundantCloser('"hi"').ok, false);
  assertEquals(tryRecoverTrailingRedundantCloser('42').ok, false);
  assertEquals(tryRecoverTrailingRedundantCloser('null').ok, false);
});

Deno.test("R5 — leading prose before root is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('here is json: {"a":1}');
  assertEquals(r.ok, false);
});

Deno.test("R5 — empty string is rejected", () => {
  const r = tryRecoverTrailingRedundantCloser('');
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.reason, "empty");
});
