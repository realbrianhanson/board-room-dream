import { assertEquals, assert } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  AUDIT_MAP_MAX_TOKENS,
  AUDIT_MAP_REASONING_EFFORT,
  AUDIT_MAP_TEMPERATURE,
  buildMapStepRequest,
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

Deno.test("buildMapStepRequest carries temperature 0.2, reasoning low, max_tokens 2400", () => {
  for (const seat of ["inspector", "contrarian", "strategist"] as const) {
    const req = buildMapStepRequest(seat, false, "USER PROMPT");
    assertEquals(req.temperature, 0.2);
    assertEquals(req.reasoning_effort, "low");
    assertEquals(req.max_tokens, 2400);
    assertEquals(req.json_output, true);
    const msgs = req.messages as Array<{ role: string; content: string }>;
    assertEquals(msgs[0].role, "system");
    assertEquals(msgs[1].role, "user");
    assertEquals(msgs[1].content, "USER PROMPT");
  }
});

// The Chair merge request is queued in boardroom-orchestrator/queues.ts and
// is intentionally NOT constrained by the map caps. This test asserts the
// literal request-shape contract from queues.ts::queueAuditChairMerge stays
// out of the map-cap regime. If someone changes the Chair merge request to
// reuse buildMapStepRequest, this test fails.
Deno.test("chair merge request contract does NOT inherit map caps", async () => {
  const src = await Deno.readTextFile(
    new URL("../boardroom-orchestrator/queues.ts", import.meta.url),
  );
  const start = src.indexOf('step_key: "audit_chair_merge"');
  assert(start >= 0, "expected audit_chair_merge insert in queues.ts");
  const window = src.slice(start, start + 1200);
  // Must set higher reasoning + max_tokens than the map caps.
  assert(
    window.includes('reasoning_effort: "medium"'),
    "chair merge should stay at 'medium' reasoning, not map's 'low'",
  );
  assert(
    /max_tokens:\s*6500/.test(window),
    "chair merge should stay at 6500 tokens, not map's 2400",
  );
  // Chair merge deliberately does NOT set a temperature cap.
  assert(
    !/\btemperature\s*:\s*0\.2\b/.test(window),
    "chair merge must not inherit the map temperature cap",
  );
});
