// Deno tests for the audit-runner chunk packer + invariants. Every test also
// checks the RENDERED chunk (renderAuditChunkGroup) stays under CHUNK_BYTES —
// the map step ships the rendered CODE block, not the raw file bytes.
// Run: cd supabase/functions && deno test audit-runner/chunking.test.ts
import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  annotateFragments,
  assertChunkInvariants,
  AUDIT_FRAGMENT_HEADER_RESERVE,
  CHUNK_BYTES,
  chunkFilesFor,
  FORMAT_DIGIT_RESERVE,
  FORMAT_JOIN_SEP,
  FORMAT_STATIC_WRAPPER,
  MAX_CHUNKS,
  MAX_TOTAL_BYTES,
  renderAuditChunkGroup,
  safeUtf8Cut,
} from "./index.ts";

function f(path: string, bytes: number, char = "x") {
  return { path, bytes, content: char.repeat(bytes) };
}

const encoder = new TextEncoder();

function renderedBytesForAll(groups: { path: string; content: string; bytes: number }[][]): number[] {
  const annotated = annotateFragments(groups);
  return annotated.map((g) => encoder.encode(renderAuditChunkGroup(g)).length);
}

function checkAll(groups: { path: string; content: string; bytes: number }[][]) {
  assertChunkInvariants(groups);
  if (groups.length > MAX_CHUNKS) throw new Error(`too many chunks: ${groups.length}`);
  const rendered = renderedBytesForAll(groups);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const size = g.reduce((n, x) => n + x.bytes, 0);
    if (size > CHUNK_BYTES) throw new Error(`chunk source too big: ${size}`);
    if (rendered[i] > CHUNK_BYTES) {
      throw new Error(`rendered chunk too big: ${rendered[i]} bytes across ${g.length} files`);
    }
    for (const frag of g) {
      if (frag.bytes > CHUNK_BYTES) throw new Error(`fragment too big: ${frag.path} ${frag.bytes}`);
      const enc = encoder.encode(frag.content);
      if (enc.length !== frag.bytes) {
        throw new Error(`fragment .bytes mismatch: ${frag.path} declared ${frag.bytes} vs encoded ${enc.length}`);
      }
    }
  }
}

function reassemble(
  original: { path: string; content: string }[],
  groups: { path: string; content: string; bytes: number }[][],
) {
  const totalOriginal = original.reduce(
    (n, o) => n + encoder.encode(o.content).length,
    0,
  );
  const emitted = new Map<string, Uint8Array[]>();
  let emittedBytes = 0;
  for (const g of groups) {
    for (const frag of g) {
      const arr = emitted.get(frag.path) ?? [];
      const enc = encoder.encode(frag.content);
      arr.push(enc);
      emittedBytes += enc.length;
      emitted.set(frag.path, arr);
    }
  }
  if (emittedBytes !== totalOriginal) {
    throw new Error(`byte omission/duplication: original=${totalOriginal} emitted=${emittedBytes}`);
  }
  for (const o of original) {
    const parts = emitted.get(o.path) ?? [];
    const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    const decoded = new TextDecoder().decode(merged);
    if (decoded !== o.content) {
      throw new Error(`reassembly mismatch for ${o.path}`);
    }
  }
}

Deno.test("shape constants: 64 KiB × 25 rendered budget (R4); SOURCE ceiling 1.5 MiB; fragment header reserve 22", () => {
  assertEquals(CHUNK_BYTES, 64 * 1024);
  assertEquals(MAX_CHUNKS, 25);
  assertEquals(MAX_TOTAL_BYTES, 1_572_864);
  // Fragment marker reserve is new in AUDIT-JSON-FRAGMENT-R2. Worst-case
  // " (fragment 25 of 25)" is 20 bytes; 22 gives a small safety margin.
  assertEquals(AUDIT_FRAGMENT_HEADER_RESERVE, 22);
  if (MAX_TOTAL_BYTES === CHUNK_BYTES * MAX_CHUNKS) {
    throw new Error("MAX_TOTAL_BYTES must be decoupled from CHUNK_BYTES * MAX_CHUNKS");
  }
});

Deno.test("wrapper accounting constants match rendered emission", () => {
  const staticLen = encoder.encode("\n=== FILE:  ( bytes) ===\n").length;
  assertEquals(FORMAT_STATIC_WRAPPER, staticLen);
  assertEquals(FORMAT_STATIC_WRAPPER, 25);
  assertEquals(FORMAT_DIGIT_RESERVE, 6);
  assertEquals(FORMAT_JOIN_SEP, 1);
});

Deno.test("seven 150 KiB files -> <=20 chunks, rendered <=64 KiB, exact reassembly", () => {
  const files = Array.from({ length: 7 }, (_, i) => f(`src/f${i}.ts`, 150 * 1024, String.fromCharCode(65 + i)));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("200 small files -> rendered <=64 KiB per chunk, exact reassembly", () => {
  const files = Array.from({ length: 200 }, (_, i) => f(`src/components/nested/dir-${i}/module.ts`, 512, String.fromCharCode(97 + (i % 26))));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("long multibyte paths respect rendered ceiling", () => {
  const longPath = (i: number) => `src/components/★★★★★/very-long-path-with-emojis-🚀🎉🌟🔥⚡/nested/deep/module-${i}.ts`;
  const files = Array.from({ length: 40 }, (_, i) => f(longPath(i), 4 * 1024, String.fromCharCode(97 + (i % 26))));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("forty 30 KiB files -> rendered <=64 KiB per chunk", () => {
  const files = Array.from({ length: 40 }, (_, i) => f(`src/f${i}.ts`, 30 * 1024, String.fromCharCode(48 + (i % 10))));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("single source >CHUNK_BYTES is safely fragmented; paths preserved", () => {
  const files = [f("huge.ts", 200 * 1024, "z")];
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
  for (const g of groups) for (const frag of g) assertEquals(frag.path, "huge.ts");
});

Deno.test("Unicode split boundaries reconstruct exactly (no split codepoints)", () => {
  const unit = "a€漢🙂"; // 1+3+3+4 = 11 bytes
  const content = unit.repeat(40_000); // ~440 KB
  const files = [{ path: "unicode.md", content, bytes: encoder.encode(content).length }];
  const groups = chunkFilesFor(files);
  checkAll(groups);
  for (const g of groups) {
    for (const frag of g) {
      if (frag.content.includes("\uFFFD")) {
        throw new Error(`fragment ${frag.path} contains replacement char (split mid-codepoint)`);
      }
    }
  }
  reassemble(files, groups);
});

Deno.test("total-over-SOURCE-ceiling fails closed in chunkFilesFor (one byte above rejected)", () => {
  const oneKB = 1024;
  const overCount = Math.ceil((MAX_TOTAL_BYTES + 1) / oneKB);
  const files = Array.from({ length: overCount }, (_, i) => f(`x${i}.ts`, oneKB));
  assertThrows(() => chunkFilesFor(files), Error, "exceeds ceiling");
});

Deno.test("boundary: current GitHub snapshot size (1,231,172 bytes) is accepted", () => {
  const CURRENT_SNAPSHOT_BYTES = 1_231_172;
  const size = 48 * 1024;
  const count = Math.floor(CURRENT_SNAPSHOT_BYTES / size);
  const remainder = CURRENT_SNAPSHOT_BYTES - count * size;
  const files = [
    ...Array.from({ length: count }, (_, i) => f(`snap${i}.ts`, size, String.fromCharCode(65 + (i % 26)))),
    f("snap-tail.ts", remainder, "z"),
  ];
  const total = files.reduce((n, x) => n + x.bytes, 0);
  assertEquals(total, CURRENT_SNAPSHOT_BYTES);
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("boundary: one byte above MAX_TOTAL_BYTES is rejected with source-ceiling error", () => {
  const size = 1024;
  const count = MAX_TOTAL_BYTES / size;
  const files = [
    ...Array.from({ length: count }, (_, i) => f(`c${i}.ts`, size)),
    f("one-byte-over.ts", 1),
  ];
  assertThrows(() => chunkFilesFor(files), Error, "exceeds ceiling");
});

Deno.test("26th-chunk rejection: assertChunkInvariants refuses handcrafted 26 groups", () => {
  const groups = Array.from({ length: MAX_CHUNKS + 1 }, () => [f("x.ts", 4096)]);
  assertThrows(() => assertChunkInvariants(groups), Error, "MAX_CHUNKS");
});

Deno.test("R4: current GitHub snapshot with fragment labels packs within <=25 chunks", () => {
  // 1,231,172 bytes snapshot that triggered the R4 report — with fragment
  // headers and per-file overhead this now needs >20 chunks; must fit in 25.
  const CURRENT_SNAPSHOT_BYTES = 1_231_172;
  const size = 48 * 1024;
  const count = Math.floor(CURRENT_SNAPSHOT_BYTES / size);
  const remainder = CURRENT_SNAPSHOT_BYTES - count * size;
  const files = [
    ...Array.from({ length: count }, (_, i) => f(`src/dir${i}/snap${i}.tsx`, size, String.fromCharCode(65 + (i % 26)))),
    f("src/dir-tail/snap-tail.tsx", remainder, "z"),
  ];
  const groups = chunkFilesFor(files);
  checkAll(groups);
  if (groups.length > MAX_CHUNKS) throw new Error(`snapshot needed ${groups.length} chunks`);
});

Deno.test("R4: realistic 200-file payload at MAX_TOTAL_BYTES packs within <=25 chunks", () => {
  // GitHub intake is capped at 200 files. Distribute the full 1.5 MiB source
  // ceiling across 200 files with long realistic paths.
  const perFile = Math.floor(MAX_TOTAL_BYTES / 200);
  const files = Array.from({ length: 200 }, (_, i) =>
    f(`src/components/nested/dir-${i}/module-with-long-name-${i}.tsx`, perFile, String.fromCharCode(97 + (i % 26))),
  );
  const total = files.reduce((n, x) => n + x.bytes, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`test invalid: ${total} > ceiling`);
  const groups = chunkFilesFor(files);
  checkAll(groups);
  if (groups.length > MAX_CHUNKS) throw new Error(`200-file payload needed ${groups.length} chunks`);
});

Deno.test("no byte omission or duplication across many mixed sizes", () => {
  const sizes = [10, 50, 199, 33, 77, 128, 64, 33, 400].map((k) => k * 1024);
  const total = sizes.reduce((n, s) => n + s, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`test invalid: ${total} > ceiling`);
  const files = sizes.map((s, i) => f(`m${i}.ts`, s, String.fromCharCode(97 + i)));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("assertChunkInvariants rejects RENDERED chunk over CHUNK_BYTES", () => {
  const fragBytes = CHUNK_BYTES;
  const group = [f("a".repeat(200), fragBytes)];
  assertThrows(() => assertChunkInvariants([group]), Error, "RENDERED");
});

Deno.test("assertChunkInvariants rejects oversize single-file fragment (strict)", () => {
  const groups = [[f("huge.ts", CHUNK_BYTES + 10_000)]];
  assertThrows(() => assertChunkInvariants(groups), Error, "exceeds");
});

Deno.test("safeUtf8Cut returns codepoint boundary and never splits continuation bytes", () => {
  const bytes = encoder.encode("a€漢🙂");
  assertEquals(safeUtf8Cut(bytes, 2), 1);
  assertEquals(safeUtf8Cut(bytes, 4), 4);
  assertEquals(safeUtf8Cut(bytes, 999), bytes.length);
});

// ============================== Fragment marker tests ==============================

Deno.test("annotateFragments — non-fragmented files carry idx=1/total=1", () => {
  const groups = [[f("src/a.ts", 100), f("src/b.ts", 200)]];
  const annotated = annotateFragments(groups);
  assertEquals(annotated[0][0].fragmentIndex, 1);
  assertEquals(annotated[0][0].fragmentTotal, 1);
  assertEquals(annotated[0][1].fragmentIndex, 1);
  assertEquals(annotated[0][1].fragmentTotal, 1);
});

Deno.test("annotateFragments — split file carries sequential idx and correct total", () => {
  const files = [f("huge.ts", 200 * 1024, "z")];
  const groups = chunkFilesFor(files);
  const annotated = annotateFragments(groups);
  const frags = annotated.flat().filter((g) => g.path === "huge.ts");
  const total = frags.length;
  assert(total >= 2, "huge.ts should split into multiple fragments");
  for (let i = 0; i < frags.length; i++) {
    assertEquals(frags[i].fragmentIndex, i + 1);
    assertEquals(frags[i].fragmentTotal, total);
  }
});

Deno.test("renderAuditChunkGroup — non-fragmented file emits legacy header only", () => {
  const g = annotateFragments([[f("src/x.ts", 5)]])[0];
  const out = renderAuditChunkGroup(g);
  assert(out.includes("=== FILE: src/x.ts (5 bytes) ==="));
  assert(!/fragment/.test(out), "non-fragmented file must NOT emit a fragment marker");
});

Deno.test("renderAuditChunkGroup — first/middle/final fragments emit unambiguous markers", () => {
  const files = [f("huge.ts", 200 * 1024, "y")];
  const groups = chunkFilesFor(files);
  const annotated = annotateFragments(groups);
  const rendered = annotated.map((g) => renderAuditChunkGroup(g));
  const total = annotated.flat().filter((g) => g.path === "huge.ts").length;
  // Every rendered chunk that contains huge.ts must have "(fragment N of M)".
  const chunksWithHuge = rendered.filter((r) => r.includes("huge.ts"));
  assertEquals(chunksWithHuge.length, total);
  const firstMarker = `(fragment 1 of ${total})`;
  const lastMarker = `(fragment ${total} of ${total})`;
  assert(rendered.some((r) => r.includes(firstMarker)), `expected marker "${firstMarker}"`);
  assert(rendered.some((r) => r.includes(lastMarker)), `expected marker "${lastMarker}"`);
  if (total >= 3) {
    const midMarker = `(fragment 2 of ${total})`;
    assert(rendered.some((r) => r.includes(midMarker)), `expected marker "${midMarker}"`);
  }
});

Deno.test("system prompt embeds anti-false-positive fragment rule", async () => {
  const src = await Deno.readTextFile(new URL("../_shared/audit-findings.ts", import.meta.url));
  assert(/Fragment-boundary rule/i.test(src));
  assert(/mid-token|mid-statement/i.test(src));
  assert(/Never report a file as truncated/i.test(src));
});
