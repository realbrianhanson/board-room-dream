// TECH-HARDEN-R1: regression tests for the boardroom-orchestrator queues.
// Static source scan — proves the change-request tenant scoping on all three
// filters is present in createInitialSteps.
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./queues.ts", import.meta.url));

Deno.test("createInitialSteps CR fetch filters by id + project_id + user_id", () => {
  // Locate the createInitialSteps function body and assert all three filters
  // exist together in the CR fetch chain that seeds `activeCr`.
  const idx = src.indexOf("export async function createInitialSteps");
  if (idx < 0) throw new Error("createInitialSteps not found");
  const body = src.slice(idx);
  // The block that fetches `activeCr` must contain all three eq() filters.
  const activeIdx = body.indexOf("activeCr");
  if (activeIdx < 0) throw new Error("activeCr fetch not found");
  const window = body.slice(activeIdx, activeIdx + 800);
  assertStringIncludes(window, `.from("change_requests")`);
  assertStringIncludes(window, `.eq("id", crId)`);
  assertStringIncludes(window, `.eq("project_id", run.project_id)`);
  assertStringIncludes(window, `.eq("user_id", run.user_id)`);
});
