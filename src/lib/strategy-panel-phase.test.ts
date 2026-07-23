import { describe, it, expect } from "vitest";
import { strategyPanelPhase } from "./strategy-panel-phase";

describe("strategyPanelPhase", () => {
  it("returns 'loading' while the fetch is in flight", () => {
    expect(strategyPanelPhase({ loading: true, error: null, intakeId: null })).toBe("loading");
    expect(strategyPanelPhase({ loading: true, error: "x", intakeId: "1" })).toBe("loading");
  });

  it("returns 'error' once settled with an error, even if an intakeId exists", () => {
    expect(strategyPanelPhase({ loading: false, error: "boom", intakeId: null })).toBe("error");
    expect(strategyPanelPhase({ loading: false, error: "boom", intakeId: "1" })).toBe("error");
  });

  it("returns 'missing' when settled successfully with no intake row", () => {
    expect(strategyPanelPhase({ loading: false, error: null, intakeId: null })).toBe("missing");
  });

  it("returns 'ready' only when we have an intake row and no error", () => {
    expect(strategyPanelPhase({ loading: false, error: null, intakeId: "abc" })).toBe("ready");
  });

  it("never returns 'loading' once the fetch has settled — no permanent skeleton", () => {
    for (const intakeId of [null, "row"]) {
      for (const error of [null, "err"]) {
        expect(strategyPanelPhase({ loading: false, error, intakeId })).not.toBe("loading");
      }
    }
  });
});
