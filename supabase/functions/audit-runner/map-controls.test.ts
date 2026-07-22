import { assertEquals } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  AUDIT_MAP_MAX_TOKENS,
  AUDIT_MAP_REASONING_EFFORT,
  AUDIT_MAP_TEMPERATURE,
  CHUNK_BYTES,
  MAX_CHUNKS,
} from "./index.ts";

// Map/extraction seats are evidence gatherers running against up to 20
// chunks × 3 seats = 60 model calls per final audit; the bounded controls
// keep each call fast and cheap and are locked deliberately.
Deno.test("audit map controls are the locked bounded values", () => {
  assertEquals(AUDIT_MAP_TEMPERATURE, 0.2);
  assertEquals(AUDIT_MAP_REASONING_EFFORT, "low");
  assertEquals(AUDIT_MAP_MAX_TOKENS, 2400);
});

Deno.test("chunk shape stays at 64 KiB × 20 (bounded audit map payload)", () => {
  assertEquals(CHUNK_BYTES, 64 * 1024);
  assertEquals(MAX_CHUNKS, 20);
});
