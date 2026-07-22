// R3 — pure test for collectAllowedModelIds. Ensures both primary and
// fallback model ids from ENABLED seats are authorized, disabled seats
// contribute nothing, and null/blank/duplicates are handled deterministically.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { collectAllowedModelIds, type SeatRow } from "./openrouter-proxy.ts";

function row(over: Partial<SeatRow>): SeatRow {
  return {
    seat: "chair",
    model_id: "openai/gpt-x",
    role_prompt: "",
    enabled: true,
    fallback_model_id: null,
    max_cost_per_run: null,
    ...over,
  } as SeatRow;
}

Deno.test("collectAllowedModelIds — fallback-only id is accepted", () => {
  const ids = collectAllowedModelIds([
    row({ seat: "chair", model_id: "a/1", fallback_model_id: "b/2" }),
  ]);
  assertEquals(new Set(ids), new Set(["a/1", "b/2"]));
});

Deno.test("collectAllowedModelIds — duplicates across seats are deduped", () => {
  const ids = collectAllowedModelIds([
    row({ seat: "chair", model_id: "a/1", fallback_model_id: "shared/f" }),
    row({ seat: "strategist", model_id: "b/2", fallback_model_id: "shared/f" }),
    row({ seat: "contrarian", model_id: "shared/f" }),
  ]);
  assertEquals(new Set(ids), new Set(["a/1", "b/2", "shared/f"]));
  assertEquals(ids.length, 3);
});

Deno.test("collectAllowedModelIds — null/blank/whitespace excluded", () => {
  const ids = collectAllowedModelIds([
    row({ model_id: "  ", fallback_model_id: null }),
    row({ model_id: "real/one", fallback_model_id: "   " }),
    row({ model_id: "real/two", fallback_model_id: "" as any }),
  ]);
  assertEquals(new Set(ids), new Set(["real/one", "real/two"]));
});

Deno.test("collectAllowedModelIds — disabled seat contributes nothing", () => {
  const ids = collectAllowedModelIds([
    row({ seat: "chair", model_id: "keep/1", fallback_model_id: "keep/1f" }),
    row({ seat: "inspector", model_id: "drop/1", fallback_model_id: "drop/1f", enabled: false }),
  ]);
  assertEquals(new Set(ids), new Set(["keep/1", "keep/1f"]));
});
