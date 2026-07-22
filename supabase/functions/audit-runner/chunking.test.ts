import { assertEquals, assertThrows } from "https://deno.land/std@0.203.0/assert/mod.ts";
import { CHUNK_BYTES, MAX_CHUNKS, MAX_TOTAL_BYTES, chunkFilesFor, assertChunkInvariants } from "./index.ts";

function f(path: string, bytes: number) {
  return { path, bytes, content: "x".repeat(bytes) };
}

Deno.test("ordinary chunks stay under 200 KiB", () => {
  const files = Array.from({ length: 20 }, (_, i) => f(`src/f${i}.ts`, 50 * 1024));
  const groups = chunkFilesFor(files);
  assertChunkInvariants(groups);
  for (const g of groups) {
    const size = g.reduce((n, x) => n + x.bytes, 0);
    if (!(g.length === 1 && g[0].bytes > CHUNK_BYTES)) {
      if (size > CHUNK_BYTES) throw new Error(`chunk too big: ${size}`);
    }
  }
});

Deno.test("total never exceeds 1.2 MiB ceiling", () => {
  assertEquals(MAX_TOTAL_BYTES, CHUNK_BYTES * MAX_CHUNKS);
  assertEquals(MAX_TOTAL_BYTES, 1228800);
});

Deno.test("indivisible large file allowed as its own oversize chunk", () => {
  const groups = [[f("huge.ts", CHUNK_BYTES + 10_000)]];
  assertChunkInvariants(groups); // must not throw
});

Deno.test("oversize multi-file chunk rejected", () => {
  const groups = [[f("a.ts", CHUNK_BYTES), f("b.ts", 1024)]];
  assertThrows(() => assertChunkInvariants(groups), Error, "exceeds");
});

Deno.test("total-over-ceiling rejected", () => {
  const groups = Array.from({ length: MAX_CHUNKS + 1 }, () => [f("x.ts", CHUNK_BYTES)]);
  assertThrows(() => assertChunkInvariants(groups), Error, "ceiling");
});

Deno.test("splits into up to MAX_CHUNKS", () => {
  const files = Array.from({ length: 40 }, (_, i) => f(`src/f${i}.ts`, 30 * 1024));
  const groups = chunkFilesFor(files);
  if (groups.length > MAX_CHUNKS) throw new Error(`too many chunks: ${groups.length}`);
});
