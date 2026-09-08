import { assertEquals, assertThrows } from "https://deno.land/std@0.203.0/assert/mod.ts";
import { assertStepInsertOk, isTolerableInsertError, UNIQUE_VIOLATION } from "./step-insert.ts";

Deno.test("assertStepInsertOk: a clean result passes through unchanged", () => {
  const res = { data: null, error: null };
  assertEquals(assertStepInsertOk(res), res);
});

Deno.test("assertStepInsertOk: undefined / null results (test doubles) are tolerated", () => {
  assertEquals(assertStepInsertOk(undefined), undefined);
  assertEquals(assertStepInsertOk(null), null);
});

Deno.test("assertStepInsertOk: a unique violation (23505) is tolerated", () => {
  const res = { data: null, error: { code: UNIQUE_VIOLATION, message: "duplicate key value" } };
  assertEquals(assertStepInsertOk(res), res);
  assertEquals(isTolerableInsertError(res.error), true);
});

Deno.test("assertStepInsertOk: any other error throws with the message", () => {
  const res = { data: null, error: { code: "42501", message: "permission denied for table run_steps" } };
  const err = assertThrows(() => assertStepInsertOk(res), Error);
  assertEquals(err.message, "run_steps insert failed: permission denied for table run_steps");
  assertEquals(isTolerableInsertError(res.error), false);
});

Deno.test("assertStepInsertOk: custom label and message-less error", () => {
  const err = assertThrows(() => assertStepInsertOk({ error: { code: "XX000" } }, "audit map insert"), Error);
  assertEquals(err.message.startsWith("audit map insert failed: "), true);
});
