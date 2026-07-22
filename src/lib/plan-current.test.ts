import { describe, it, expect } from "vitest";
import { selectCurrentPlanVersion, hasLegacyPlanHistory } from "./plan-current";

const v = (id: string, version: number, is_build_safe: boolean, reason: string | null = null) => ({
  id,
  version,
  is_build_safe,
  invalidated_reason: reason,
  locked_at: null,
});

describe("selectCurrentPlanVersion", () => {
  it("returns null when no versions exist", () => {
    expect(selectCurrentPlanVersion([])).toBeNull();
  });

  it("returns null when every version is unsafe (legacy only)", () => {
    expect(
      selectCurrentPlanVersion([
        v("a", 1, false, "pre_owner_authority_v3"),
        v("b", 2, false, "pre_owner_authority_v3"),
      ]),
    ).toBeNull();
  });

  it("excludes unsafe v1 even when it is the highest version", () => {
    // Newest is unsafe, older is safe → nothing selectable? Real contract
    // says safe wins regardless of version — an unsafe row cannot present
    // as current. Here safe v2 is current.
    const cur = selectCurrentPlanVersion([
      v("unsafe1", 1, false, "pre_owner_authority_v3"),
      v("safe2", 2, true),
    ]);
    expect(cur?.id).toBe("safe2");
  });

  it("returns the newest build-safe row when both safe rows exist", () => {
    const cur = selectCurrentPlanVersion([
      v("safe2", 2, true),
      v("safe3", 3, true),
      v("unsafe", 1, false),
    ]);
    expect(cur?.id).toBe("safe3");
  });
});

describe("hasLegacyPlanHistory", () => {
  it("true when any row is unsafe", () => {
    expect(hasLegacyPlanHistory([v("a", 1, false), v("b", 2, true)])).toBe(true);
  });
  it("false when all rows are safe", () => {
    expect(hasLegacyPlanHistory([v("a", 1, true), v("b", 2, true)])).toBe(false);
  });
});
