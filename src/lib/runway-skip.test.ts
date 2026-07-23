import { describe, expect, it } from "vitest";
import { computeSkipSuffixIds, type SkipBatchLite } from "./runway-skip";

const mk = (id: string, batch_no: number, status: SkipBatchLite["status"]): SkipBatchLite => ({
  id, batch_no, status,
});

describe("computeSkipSuffixIds — sequential skip rule", () => {
  it("skipping a middle batch also skips later unbuilt batches", () => {
    const batches = [
      mk("b1", 1, "passed"),
      mk("b2", 2, "pending"),
      mk("b3", 3, "pending"),
      mk("b4", 4, "fix_needed"),
    ];
    expect(computeSkipSuffixIds(batches, "b2").sort()).toEqual(["b2", "b3", "b4"].sort());
  });

  it("does not touch already terminal later batches", () => {
    const batches = [
      mk("b1", 1, "pending"),
      mk("b2", 2, "passed"),
      mk("b3", 3, "pending"),
      mk("b4", 4, "skipped"),
    ];
    expect(computeSkipSuffixIds(batches, "b1").sort()).toEqual(["b1", "b3"].sort());
  });

  it("returns empty when target is already terminal (no-op)", () => {
    const batches = [mk("b1", 1, "passed"), mk("b2", 2, "pending")];
    expect(computeSkipSuffixIds(batches, "b1")).toEqual([]);
  });

  it("returns empty when target id is unknown", () => {
    expect(computeSkipSuffixIds([mk("b1", 1, "pending")], "missing")).toEqual([]);
  });

  it("skipping the last unbuilt batch skips only itself", () => {
    const batches = [mk("b1", 1, "passed"), mk("b2", 2, "pending")];
    expect(computeSkipSuffixIds(batches, "b2")).toEqual(["b2"]);
  });
});
