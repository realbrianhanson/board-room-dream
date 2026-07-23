import { describe, it, expect } from "vitest";
import { selectDisplayedRun, safeSpend, type RunLite } from "./run-selection";

const t = (iso: string) => new Date(iso).toISOString();

describe("selectDisplayedRun", () => {
  it("returns null for empty input", () => {
    expect(selectDisplayedRun([])).toBeNull();
  });

  it("prefers active over terminal, regardless of created_at ordering", () => {
    const runs: RunLite[] = [
      { id: "newest-terminal", status: "failed", created_at: t("2026-07-27T10:00:00Z") },
      { id: "active", status: "running", created_at: t("2026-07-27T08:00:00Z") },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("active");
  });

  it("among active runs, prefers greatest spend then oldest", () => {
    const runs: RunLite[] = [
      { id: "a", status: "running", created_at: t("2026-07-27T09:00:00Z"), spent_usd: 0.5 },
      { id: "b", status: "queued", created_at: t("2026-07-27T08:00:00Z"), spent_usd: 1.2 },
      { id: "c", status: "paused", created_at: t("2026-07-27T07:00:00Z"), spent_usd: 1.2 },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("c"); // tied spend → oldest
  });

  it("picks newest terminal when input is created_at DESC", () => {
    const runs: RunLite[] = [
      { id: "newest", status: "consensus", created_at: t("2026-07-27T10:00:00Z"), spent_usd: 0.1 },
      { id: "older-big-spend", status: "failed", created_at: t("2026-07-26T10:00:00Z"), spent_usd: 9.99 },
      { id: "oldest", status: "chair_ruled", created_at: t("2026-07-25T10:00:00Z"), spent_usd: 0.05 },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("newest");
  });

  it("does not let an older high-spend terminal shadow the newest terminal", () => {
    const runs: RunLite[] = [
      { id: "newest-failed", status: "failed", created_at: t("2026-07-27T10:00:00Z"), spent_usd: 0 },
      { id: "older-completed", status: "completed", created_at: t("2026-07-01T10:00:00Z"), spent_usd: 42 },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("newest-failed");
  });


  it("newest terminal failure wins over older, more expensive terminal failure ($4.218 vs $0.923)", () => {
    // Regression: Runway once selected by spend and would surface an
    // ancient revise failure ($4.218) even though a fresh Inspector
    // failure ($0.923) had just landed.
    const runs: RunLite[] = [
      { id: "newer-inspector-fail", status: "failed", created_at: t("2026-07-27T18:00:00Z"), spent_usd: 0.923 },
      { id: "older-revise-fail", status: "failed", created_at: t("2026-07-20T09:00:00Z"), spent_usd: 4.218 },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("newer-inspector-fail");
  });

  it("active run still wins over any terminal — progress trumps recency", () => {
    const runs: RunLite[] = [
      { id: "newer-terminal", status: "failed", created_at: t("2026-07-27T18:00:00Z"), spent_usd: 5 },
      { id: "active-in-progress", status: "running", created_at: t("2026-07-27T10:00:00Z"), spent_usd: 1.5 },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("active-in-progress");
  });

  it("NaN/null/malformed spend is coerced to 0 and never scrambles ordering", () => {
    const runs: RunLite[] = [
      // Two active runs; the one with real numeric spend must win over
      // the NaN-spend row. If safeSpend didn't coerce, the comparator
      // would return NaN and Array.sort would degrade to insertion order.
      { id: "nan-first", status: "running", created_at: t("2026-07-27T10:00:00Z"), spent_usd: "not-a-number" },
      { id: "real-spend", status: "running", created_at: t("2026-07-27T11:00:00Z"), spent_usd: 0.42 },
      { id: "null-spend", status: "running", created_at: t("2026-07-27T12:00:00Z"), spent_usd: null },
    ];
    expect(selectDisplayedRun(runs)?.id).toBe("real-spend");
  });

  it("safeSpend coerces every unsupported shape to 0", () => {
    expect(safeSpend(null)).toBe(0);
    expect(safeSpend(undefined)).toBe(0);
    expect(safeSpend("")).toBe(0);
    expect(safeSpend("abc")).toBe(0);
    expect(safeSpend(Number.NaN)).toBe(0);
    expect(safeSpend(Infinity)).toBe(0);
    expect(safeSpend("1.75")).toBe(1.75);
    expect(safeSpend(2)).toBe(2);
  });
});
