import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextStatusAfterZeroBatchFailure } from "./zero-batch-recovery.ts";

Deno.test("safe plan → locked (import or greenfield)", () => {
  assertEquals(nextStatusAfterZeroBatchFailure({ hasSafePlan: true, isImport: true }), "locked");
  assertEquals(nextStatusAfterZeroBatchFailure({ hasSafePlan: true, isImport: false }), "locked");
});

Deno.test("no safe plan, import → imported", () => {
  assertEquals(nextStatusAfterZeroBatchFailure({ hasSafePlan: false, isImport: true }), "imported");
});

Deno.test("no safe plan, greenfield → validated", () => {
  assertEquals(nextStatusAfterZeroBatchFailure({ hasSafePlan: false, isImport: false }), "validated");
});
