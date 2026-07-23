import { describe, expect, it } from "vitest";
import { deriveDashboardLoadState } from "./dashboard-load-state";

describe("deriveDashboardLoadState", () => {
  it("loading before the first query resolves", () => {
    expect(deriveDashboardLoadState({ projects: null, loadError: null })).toBe("loading");
  });

  it("error is retryable, never collapsed into empty", () => {
    expect(deriveDashboardLoadState({ projects: null, loadError: "boom" })).toBe("error");
    // Even if projects is [] from a stale successful load, an error still wins.
    expect(deriveDashboardLoadState({ projects: [], loadError: "boom" })).toBe("error");
  });

  it("empty only for a successful query with zero rows", () => {
    expect(deriveDashboardLoadState({ projects: [], loadError: null })).toBe("empty");
  });

  it("ready when rows are present", () => {
    expect(deriveDashboardLoadState({ projects: [{ id: "x" }], loadError: null })).toBe("ready");
  });
});
