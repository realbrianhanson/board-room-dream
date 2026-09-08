import { describe, expect, it } from "vitest";
import { SMOKE_KINDS, SMOKE_KIND_LABEL, smokeRunOutcome, smokeRunRequest } from "./smoke-run";

describe("smokeRunRequest", () => {
  it("audit goes to audit-runner as a github final audit with smoke: true", () => {
    const r = smokeRunRequest("audit", "p1");
    expect(r.fn).toBe("audit-runner");
    expect(r.body).toEqual({ action: "start_final_audit", project_id: "p1", source: "github", smoke: true });
  });

  it("batches / plan / design go to the orchestrator start_run with smoke: true", () => {
    for (const kind of ["batches", "plan", "design"] as const) {
      const r = smokeRunRequest(kind, "p2");
      expect(r.fn).toBe("boardroom-orchestrator");
      expect(r.body).toEqual({ action: "start_run", project_id: "p2", kind, smoke: true });
    }
  });

  it("every kind has a label", () => {
    for (const kind of SMOKE_KINDS) expect(SMOKE_KIND_LABEL[kind]).toBeTruthy();
  });
});

describe("smokeRunOutcome", () => {
  it("names the existing active run instead of claiming a new one", () => {
    expect(smokeRunOutcome({ existing: true, run_id: "abc", status: "running" })).toMatch(/already active \(running\)/);
  });

  it("reports the queued run id and the $1 budget", () => {
    const msg = smokeRunOutcome({ run_id: "0123456789abcdef" });
    expect(msg).toContain("01234567");
    expect(msg).toContain("$1");
  });

  it("falls back to a plain confirmation", () => {
    expect(smokeRunOutcome(null)).toBe("Smoke run queued.");
  });
});
