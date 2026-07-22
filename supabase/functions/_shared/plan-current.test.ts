import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { selectCurrentPlanVersion } from "./plan-current.ts";

Deno.test("selectCurrentPlanVersion: unsafe v1 excluded, safe v2 becomes current", () => {
  const cur = selectCurrentPlanVersion([
    { id: "unsafe1", version: 1, is_build_safe: false },
    { id: "safe2", version: 2, is_build_safe: true },
  ]);
  assertEquals(cur?.id, "safe2");
});

Deno.test("selectCurrentPlanVersion: all unsafe returns null (legacy-only history)", () => {
  const cur = selectCurrentPlanVersion([
    { id: "a", version: 1, is_build_safe: false },
    { id: "b", version: 2, is_build_safe: false },
  ]);
  assertEquals(cur, null);
});

Deno.test("selectCurrentPlanVersion: newest safe version wins across multiple safe rows", () => {
  const cur = selectCurrentPlanVersion([
    { id: "safe3", version: 3, is_build_safe: true },
    { id: "safe2", version: 2, is_build_safe: true },
    { id: "unsafe1", version: 1, is_build_safe: false },
  ]);
  assertEquals(cur?.id, "safe3");
});
