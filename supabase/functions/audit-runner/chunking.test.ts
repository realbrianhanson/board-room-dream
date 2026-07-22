import { assertEquals, assertThrows } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  CHUNK_BYTES,
  MAX_CHUNKS,
  MAX_TOTAL_BYTES,
  chunkFilesFor,
  assertChunkInvariants,
  safeUtf8Cut,
} from "./index.ts";

function f(path: string, bytes: number, char = "x") {
  return { path, bytes, content: char.repeat(bytes) };
}

function checkAll(groups: { path: string; content: string; bytes: number }[][]) {
  assertChunkInvariants(groups);
  if (groups.length > MAX_CHUNKS) throw new Error(`too many chunks: ${groups.length}`);
  for (const g of groups) {
    const size = g.reduce((n, x) => n + x.bytes, 0);
    if (size > CHUNK_BYTES) throw new Error(`chunk too big: ${size}`);
    for (const frag of g) {
      if (frag.bytes > CHUNK_BYTES) throw new Error(`fragment too big: ${frag.path} ${frag.bytes}`);
      const enc = new TextEncoder().encode(frag.content);
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
    (n, o) => n + new TextEncoder().encode(o.content).length,
    0,
  );
  const emitted = new Map<string, Uint8Array[]>();
  let emittedBytes = 0;
  for (const g of groups) {
    for (const frag of g) {
      const arr = emitted.get(frag.path) ?? [];
      const enc = new TextEncoder().encode(frag.content);
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

Deno.test("MAX_TOTAL_BYTES = CHUNK_BYTES * MAX_CHUNKS = 1.2 MiB", () => {
  assertEquals(MAX_TOTAL_BYTES, CHUNK_BYTES * MAX_CHUNKS);
  assertEquals(MAX_TOTAL_BYTES, 1228800);
});

Deno.test("seven 150 KiB files -> <=6 chunks, all <=200 KiB, exact reassembly", () => {
  const files = Array.from({ length: 7 }, (_, i) => f(`src/f${i}.ts`, 150 * 1024, String.fromCharCode(65 + i)));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("forty 30 KiB files -> <=6 chunks, all <=200 KiB, exact reassembly", () => {
  const files = Array.from({ length: 40 }, (_, i) => f(`src/f${i}.ts`, 30 * 1024, String.fromCharCode(48 + (i % 10))));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("single source >200 KiB is safely fragmented into ordinary chunks", () => {
  const files = [f("huge.ts", 350 * 1024, "z")];
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
  // Every fragment must carry the original path.
  for (const g of groups) for (const frag of g) assertEquals(frag.path, "huge.ts");
});

Deno.test("Unicode split boundaries reconstruct exactly (no split codepoints)", () => {
  // Mix of 1/2/3/4-byte codepoints. Long enough to force multiple splits.
  const unit = "a€漢🙂"; // 1+3+3+4 = 11 bytes
  const content = unit.repeat(40_000); // ~440 KB
  const files = [{ path: "unicode.md", content, bytes: new TextEncoder().encode(content).length }];
  const groups = chunkFilesFor(files);
  checkAll(groups);
  // Each fragment must itself decode to valid UTF-8 without replacement chars.
  for (const g of groups) {
    for (const frag of g) {
      if (frag.content.includes("\uFFFD")) {
        throw new Error(`fragment ${frag.path} contains replacement char (split mid-codepoint)`);
      }
    }
  }
  reassemble(files, groups);
});

Deno.test("total-over-ceiling fails closed in chunkFilesFor", () => {
  const files = Array.from({ length: 7 }, (_, i) => f(`x${i}.ts`, CHUNK_BYTES));
  assertThrows(() => chunkFilesFor(files), Error, "exceeds ceiling");
});

Deno.test("no byte omission or duplication across many mixed sizes", () => {
  const sizes = [10, 50, 199, 200, 201, 300, 77, 128, 64, 33, 400].map((k) => k * 1024);
  const total = sizes.reduce((n, s) => n + s, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`test invalid: ${total} > ceiling`);
  const files = sizes.map((s, i) => f(`m${i}.ts`, s, String.fromCharCode(97 + i)));
  const groups = chunkFilesFor(files);
  checkAll(groups);
  reassemble(files, groups);
});

Deno.test("assertChunkInvariants rejects oversize single-file fragment (strict)", () => {
  const groups = [[f("huge.ts", CHUNK_BYTES + 10_000)]];
  assertThrows(() => assertChunkInvariants(groups), Error, "exceeds");
});

Deno.test("assertChunkInvariants rejects oversize multi-file chunk", () => {
  const groups = [[f("a.ts", CHUNK_BYTES), f("b.ts", 1024)]];
  assertThrows(() => assertChunkInvariants(groups), Error, "exceeds");
});

Deno.test("assertChunkInvariants rejects >MAX_CHUNKS groups", () => {
  const groups = Array.from({ length: MAX_CHUNKS + 1 }, () => [f("x.ts", 1024)]);
  assertThrows(() => assertChunkInvariants(groups), Error, "MAX_CHUNKS");
});

Deno.test("safeUtf8Cut returns codepoint boundary and never splits continuation bytes", () => {
  const bytes = new TextEncoder().encode("a€漢🙂"); // 11 bytes: 1+3+3+4
  // maxBytes=2 lands inside €; walk back to end of 'a' at cut=1
  assertEquals(safeUtf8Cut(bytes, 2), 1);
  // maxBytes=4 is exactly on the boundary after € — accept it
  assertEquals(safeUtf8Cut(bytes, 4), 4);
  // maxBytes >= length returns full length
  assertEquals(safeUtf8Cut(bytes, 999), bytes.length);
});

