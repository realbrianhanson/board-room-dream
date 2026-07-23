import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RESUME_ADD_MAX_USD,
  RUN_TOTAL_MAX_USD,
  validateResumeBudget,
} from "./resume-budget.ts";

Deno.test("resume budget: allowed values pass through", () => {
  assertEquals(validateResumeBudget(0, 5).ok, true);
  assertEquals(validateResumeBudget(0.5, 5).ok, true);
  assertEquals(validateResumeBudget(10, 5).ok, true);
  const r = validateResumeBudget(5, 5);
  if (r.ok) assertEquals(r.newTotal, 10);
});

Deno.test("resume budget: NaN and non-finite are rejected 400", () => {
  const r1 = validateResumeBudget("nope", 5);
  assertEquals(r1.ok, false);
  const r2 = validateResumeBudget(Number.POSITIVE_INFINITY, 5);
  assertEquals(r2.ok, false);
  const r3 = validateResumeBudget(NaN, 5);
  assertEquals(r3.ok, false);
});

Deno.test("resume budget: negative extra rejected 400", () => {
  const r = validateResumeBudget(-0.01, 5);
  assertEquals(r.ok, false);
});

Deno.test(`resume budget: > $${RESUME_ADD_MAX_USD} per resume rejected 400`, () => {
  const r = validateResumeBudget(10.01, 5);
  assertEquals(r.ok, false);
});

Deno.test(`resume budget: cumulative > $${RUN_TOTAL_MAX_USD} rejected 400`, () => {
  // First hop: current 25 + 5 = 30 (allowed).
  const first = validateResumeBudget(5, 25);
  assertEquals(first.ok, true);
  // Repeat hop that would push us to $31 total is rejected.
  const second = validateResumeBudget(1, 30);
  assertEquals(second.ok, false);
});

Deno.test("resume budget: exactly $30 total is allowed, silent clamp is NOT applied", () => {
  const r = validateResumeBudget(10, 20);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.newTotal, 30);
});

Deno.test("resume budget: missing extra treated as 0 (plain resume path)", () => {
  const r = validateResumeBudget(undefined, 5);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.extra, 0);
});
