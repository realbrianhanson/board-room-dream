// AUDIT-TRUTHFULNESS: lock the anti-false-positive instructions into the map
// schema doc, the merge schema doc, the merge-step system prompt, and the
// Strategist seat prompt. If any of these strings drift, the audit regresses
// toward the same false-positive shape (invented mojibake, cross-file claims
// of absence, historical-migration P0s, client-side auth "exploits").
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FINDING_SCHEMA_DOC,
  MAP_FINDING_SCHEMA_DOC,
} from "./audit-findings.ts";

function assertContainsAll(haystack: string, needles: string[], label: string) {
  for (const n of needles) {
    assert(haystack.includes(n), `${label} missing marker: ${JSON.stringify(n)}`);
  }
}

Deno.test("MAP_FINDING_SCHEMA_DOC locks QUOTE/WHY + cumulative + client-role + cross-file markers", () => {
  assertContainsAll(MAP_FINDING_SCHEMA_DOC, [
    "QUOTE:",
    "WHY:",
    "Cumulative-ledger",
    "Client-side vs server-side authorization",
    "Cross-file composition",
    "callSeat",
    "model_registry.role_prompt",
  ], "MAP_FINDING_SCHEMA_DOC");
});

Deno.test("FINDING_SCHEMA_DOC locks the same anti-false-positive markers", () => {
  assertContainsAll(FINDING_SCHEMA_DOC, [
    "QUOTE:",
    "WHY:",
    "Cumulative-ledger",
    "Client-side vs server-side authorization",
    "Cross-file composition",
    "user_roles table is one architecture",
  ], "FINDING_SCHEMA_DOC");
});

Deno.test("Strategist audit seat prompt covers buyer/offer/activation/wow/positioning", async () => {
  const src = await Deno.readTextFile(
    new URL("../audit-runner/index.ts", import.meta.url),
  );
  // The Strategist branch is the final `return` inside seatPrompt.
  const start = src.indexOf("You are the Strategist.");
  assert(start > 0, "Strategist branch not found in audit-runner seatPrompt");
  const window = src.slice(start, start + 1200);
  assertContainsAll(window, [
    "buyer reachability",
    "paid offer",
    "price anchor",
    "upgrade trigger",
    "first-90-second activation",
    "wow moment",
    "Unlike X",
  ], "Strategist seatPrompt");
});

Deno.test("Chair merge system prompt locks QUOTE/WHY, cumulative, cross-file, client-role", async () => {
  const src = await Deno.readTextFile(
    new URL("../boardroom-orchestrator/queues.ts", import.meta.url),
  );
  const start = src.indexOf('step_key: "audit_chair_merge"');
  assert(start >= 0, "queueAuditChairMerge not found");
  const window = src.slice(Math.max(0, start - 6000), start + 200);
  assertContainsAll(window, [
    "QUOTE:",
    "WHY:",
    "Cumulative-ledger",
    "Client-side route/UI role checks",
    "callSeat",
    "openrouter-proxy.ts",
  ], "queueAuditChairMerge system prompt");
});

