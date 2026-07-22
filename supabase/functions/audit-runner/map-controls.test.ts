import { assertEquals, assert } from "https://deno.land/std@0.203.0/assert/mod.ts";
import {
  AUDIT_MAP_MAX_TOKENS,
  AUDIT_MAP_REASONING_EFFORT,
  AUDIT_MAP_TEMPERATURE,
  buildMapStepRequest,
  CHUNK_BYTES,
  MAX_CHUNKS,
} from "./index.ts";
import { CAPS } from "../_shared/audit-findings.ts";

// Map/extraction seats are evidence gatherers running against up to 20
// chunks × 3 seats = 60 model calls per final audit. Every bounded control
// below is locked deliberately — see AUDIT-JSON-FRAGMENT-R2.
Deno.test("audit map controls are the locked bounded values (temperature/reasoning unchanged; max_tokens 4000)", () => {
  assertEquals(AUDIT_MAP_TEMPERATURE, 0.2);
  assertEquals(AUDIT_MAP_REASONING_EFFORT, "low");
  // Increased from 2400 → 4000 in AUDIT-JSON-FRAGMENT-R2. The prior 2400 was
  // too tight for the schema+reasoning and truncated one token short of "]}"
  // in production (run e2c5faf3). Every other bound stays locked.
  assertEquals(AUDIT_MAP_MAX_TOKENS, 4000);
});

Deno.test("chunk shape stays at 64 KiB × 25 (bounded audit map payload, R4)", () => {
  assertEquals(CHUNK_BYTES, 64 * 1024);
  assertEquals(MAX_CHUNKS, 25);
});

Deno.test("map-schema caps are the tightened AUDIT-JSON-FRAGMENT-R2 values", () => {
  assertEquals(CAPS.mapFindingsMax, 6);
  assertEquals(CAPS.mapSerializedMax, 4_000);
  assertEquals(CAPS.mapTitleMax, 120);
  assertEquals(CAPS.mapDescriptionMax, 400);
  assertEquals(CAPS.mapEvidenceMax, 240);
});

Deno.test("correction caps forbid the 12/8000 shape that caused truncation", () => {
  assertEquals(CAPS.correctionFindingsMax, 3);
  assert(CAPS.correctionSerializedMax <= CAPS.mapSerializedMax);
  assertEquals(CAPS.correctionDescriptionMax, 240);
  assertEquals(CAPS.correctionEvidenceMax, 160);
});

Deno.test("buildMapStepRequest carries temperature 0.2, reasoning low, max_tokens 4000", () => {
  for (const seat of ["inspector", "contrarian", "strategist"] as const) {
    const req = buildMapStepRequest(seat, false, "USER PROMPT");
    assertEquals(req.temperature, 0.2);
    assertEquals(req.reasoning_effort, "low");
    assertEquals(req.max_tokens, 4000);
    assertEquals(req.json_output, true);
    const msgs = req.messages as Array<{ role: string; content: string }>;
    assertEquals(msgs[0].role, "system");
    assertEquals(msgs[1].role, "user");
    assertEquals(msgs[1].content, "USER PROMPT");
    // System prompt must embed the new map caps and the fragment-boundary rule.
    assert(msgs[0].content.includes("max 6 objects"));
    assert(msgs[0].content.includes("<= 4000 characters"));
    assert(/fragment/i.test(msgs[0].content));
  }
});

// AUDIT-MERGE-BOUNDED-R3: Chair merge now uses reasoning_effort "low"
// (same as map) but keeps max_tokens=6500 and does NOT inherit the map
// temperature cap or the map per-field limits. Any regression here must
// fail loudly.
Deno.test("chair merge request contract — low reasoning, 6500 tokens, no map temperature", async () => {
  const src = await Deno.readTextFile(
    new URL("../boardroom-orchestrator/queues.ts", import.meta.url),
  );
  const start = src.indexOf('step_key: "audit_chair_merge"');
  assert(start >= 0, "expected audit_chair_merge insert in queues.ts");
  const window = src.slice(start - 800, start + 1200);
  assert(
    /reasoning_effort:\s*"low"/.test(window),
    "chair merge must be reasoning_effort: 'low' after R3",
  );
  assert(
    /max_tokens:\s*6500/.test(window),
    "chair merge must stay at 6500 tokens (do not raise)",
  );
  assert(
    !/\btemperature\s*:\s*0\.2\b/.test(window),
    "chair merge must not inherit the map temperature cap",
  );
});

Deno.test("R4: audit final_az budget remains $12 (locked)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const m = src.match(/kind:\s*"final_az"[^}]*budget:\s*([0-9.]+)/);
  if (!m) throw new Error("could not find final_az budget in audit-runner");
  if (m[1] !== "12.0") throw new Error(`expected 12.0 budget, got ${m[1]}`);
});
