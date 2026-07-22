// Deno tests for the audit-runner chunk packer + invariants. Every test also
// checks the RENDERED (formatFiles) chunk stays under CHUNK_BYTES — the map
// step ships the rendered CODE block, not the raw file bytes.
// Run: cd supabase/functions && deno test audit-runner/chunking.test.ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  assertChunkInvariants,
  CHUNK_BYTES,
  chunkFilesFor,
  FORMAT_DIGIT_RESERVE,
  FORMAT_JOIN_SEP,
  FORMAT_STATIC_WRAPPER,
  MAX_CHUNKS,
  MAX_TOTAL_BYTES,
  safeUtf8Cut,
} from "./index.ts";
import { formatFiles } from "../_shared/github-payload.ts";

function f(path: string, bytes: number, char = "x") {
  return { path, bytes, content: char.repeat(bytes) };
}

const encoder = new TextEncoder();

function renderedBytes(group: { path: string; content: string; bytes: number }[]): number {
  return encoder.encode(formatFiles(group)).length;
}

function checkAll(groups: { path: string; content: string; bytes: number }[][]) {
  assertChunkInvariants(groups);
  if (groups.length > MAX_CHUNKS) throw new Error(`too many chunks: ${groups.length}`);
  for (const g of groups) {
    const size = g.reduce((n, x) => n + x.bytes, 0);
    if (size > CHUNK_BYTES) throw new Error(`chunk source too big: ${size}`);
    const r = renderedBytes(g);
    if (r > CHUNK_BYTES) {
      throw new Error(`rendered chunk too big: ${r} bytes across ${g.length} files`);
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

Deno.test("shape constants: 64 KiB × 20 rendered budget UNCHANGED; SOURCE ceiling raised to 1,572,864 (1.5 MiB), decoupled", () => {
  // Rendered/request/chunk-count controls must remain frozen — those bound every model call.
  assertEquals(CHUNK_BYTES, 64 * 1024);
  assertEquals(MAX_CHUNKS, 20);
  // Only the source-ingest ceiling grew, and only to accommodate the current
  // GitHub snapshot (~1,231,172 bytes) plus reasonable near-term growth.
  assertEquals(MAX_TOTAL_BYTES, 1_572_864);
  // Deliberately not equal — wrapper overhead must never expand the source budget.
  if (MAX_TOTAL_BYTES === CHUNK_BYTES * MAX_CHUNKS) {
    throw new Error("MAX_TOTAL_BYTES must be decoupled from CHUNK_BYTES * MAX_CHUNKS");
  }
});

Deno.test("wrapper accounting constants match formatFiles() emission", () => {
  // Confirm the static wrapper: "\n=== FILE:  ( bytes) ===\n" (no path, no digits)
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
  // 200 × 512 bytes = 100 KiB of source. Wrapper overhead dominates for small
  // files; the packer must still keep every rendered chunk within 64 KiB.
  const files = Array.from({ length: 200 }, (_, i) => f(`src/components/nested/dir-${i}/module.ts`, 512, String.fromCharCode(97 + (i % 26))));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("long multibyte paths respect rendered ceiling", () => {
  // Path bytes dominate wrapper cost. Each path here is ~180 UTF-8 bytes.
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
  // Precisely MAX_TOTAL_BYTES + 1 source bytes must trigger the source-ceiling guard.
  const oneKB = 1024;
  const overCount = Math.ceil((MAX_TOTAL_BYTES + 1) / oneKB);
  const files = Array.from({ length: overCount }, (_, i) => f(`x${i}.ts`, oneKB));
  assertThrows(() => chunkFilesFor(files), Error, "exceeds ceiling");
});

Deno.test("boundary: current GitHub snapshot size (1,231,172 bytes) is accepted", () => {
  // Reproduces the exact size that failed under the old 1,228,800 ceiling.
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
  const groups = chunkFilesFor(files); // must not throw
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("boundary: exact MAX_TOTAL_BYTES source passes the source-ceiling guard", () => {
  // At the ceiling the SOURCE-ceiling assertion in chunkFilesFor must NOT fire.
  // Packing 1.5 MiB into the unchanged 20 × 64 KiB rendered budget is not
  // guaranteed — the rendered-capacity guard (MAX_CHUNKS) is the deliberate
  // loud-failure path for that pathological case, and it's covered separately.
  const size = 1024;
  const count = MAX_TOTAL_BYTES / size; // 1536 files × 1 KiB = 1,572,864 bytes
  const files = Array.from({ length: count }, (_, i) => f(`c${i}.ts`, size, String.fromCharCode(97 + (i % 26))));
  const total = files.reduce((n, x) => n + x.bytes, 0);
  assertEquals(total, MAX_TOTAL_BYTES);
  try {
    chunkFilesFor(files);
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes("exceeds ceiling")) {
      throw new Error(`source-ceiling guard fired at exact MAX_TOTAL_BYTES: ${msg}`);
    }
    // Any other loud failure (e.g. MAX_CHUNKS) is acceptable — those paths
    // stay unchanged intentionally and remain the loud-failure gate for
    // genuinely rendered-oversized packings.
  }
});

Deno.test("boundary: one byte above MAX_TOTAL_BYTES is rejected with source-ceiling error", () => {
  const size = 1024;
  const count = MAX_TOTAL_BYTES / size; // exactly at ceiling
  const files = [
    ...Array.from({ length: count }, (_, i) => f(`c${i}.ts`, size)),
    f("one-byte-over.ts", 1),
  ];
  assertThrows(() => chunkFilesFor(files), Error, "exceeds ceiling");
});

Deno.test("21st-chunk rejection: assertChunkInvariants refuses handcrafted 21 groups", () => {
  // With the SOURCE ceiling of 1,228,800 bytes and greedy packing wasting
  // at most ~40 bytes/chunk in wrapper overhead, chunkFilesFor cannot both
  // stay under the source ceiling AND emit >20 groups from ordinary files.
  // The last-line-of-defense is assertChunkInvariants, which is called on
  // every rendered chunk set — prove it rejects a 21-group input directly.
  const groups = Array.from({ length: MAX_CHUNKS + 1 }, () => [f("x.ts", 4096)]);
  assertChunkInvariants; // reference kept so import stays used above
  try {
    // Re-import to avoid TDZ concerns with hoisted assertion helpers.
    // deno-lint-ignore no-explicit-any
    (assertChunkInvariants as any)(groups);
    throw new Error("expected assertChunkInvariants to throw for 21 groups");
  } catch (e) {
    if (!String((e as Error).message).includes("MAX_CHUNKS")) throw e;
  }
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
  // Handcraft a group whose SOURCE fits but whose formatFiles() wrapper
  // pushes rendered above 64 KiB — the invariant must catch it.
  const fragBytes = CHUNK_BYTES; // 64 KiB source in a single fragment
  const group = [f("a".repeat(200), fragBytes)]; // 200-char path adds wrapper
  assertThrows(() => assertChunkInvariants([group]), Error, "RENDERED");
});

Deno.test("assertChunkInvariants rejects oversize single-file fragment (strict)", () => {
  const groups = [[f("huge.ts", CHUNK_BYTES + 10_000)]];
  assertThrows(() => assertChunkInvariants(groups), Error, "exceeds");
});

Deno.test("assertChunkInvariants rejects >MAX_CHUNKS groups", () => {
  const groups = Array.from({ length: MAX_CHUNKS + 1 }, () => [f("x.ts", 1024)]);
  assertThrows(() => assertChunkInvariants(groups), Error, "MAX_CHUNKS");
});

Deno.test("safeUtf8Cut returns codepoint boundary and never splits continuation bytes", () => {
  const bytes = encoder.encode("a€漢🙂"); // 11 bytes: 1+3+3+4
  assertEquals(safeUtf8Cut(bytes, 2), 1);
  assertEquals(safeUtf8Cut(bytes, 4), 4);
  assertEquals(safeUtf8Cut(bytes, 999), bytes.length);
});
