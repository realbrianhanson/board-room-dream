import { describe, expect, it } from "vitest";
import {
  SMOKE_DEFAULT_KIND,
  SMOKE_KINDS,
  SMOKE_KIND_LABEL,
  SMOKE_LAST_KEY,
  parseSmokeLast,
  readSmokeLast,
  restoreSmokeSelection,
  smokeRunOutcome,
  smokeRunRequest,
  writeSmokeLast,
} from "./smoke-run";

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

  it("adds executor: true to the body only when the override is set", () => {
    expect(smokeRunRequest("plan", "p3", { executor: true }).body).toEqual({
      action: "start_run", project_id: "p3", kind: "plan", smoke: true, executor: true,
    });
    expect(smokeRunRequest("audit", "p3", { executor: true }).body).toEqual({
      action: "start_final_audit", project_id: "p3", source: "github", smoke: true, executor: true,
    });
    // Unset / false / no opts: the body is byte-identical to before the override existed.
    for (const opts of [undefined, {}, { executor: false }]) {
      expect(smokeRunRequest("batches", "p3", opts).body).toEqual({
        action: "start_run", project_id: "p3", kind: "batches", smoke: true,
      });
      expect(smokeRunRequest("audit", "p3", opts).body).not.toHaveProperty("executor");
    }
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

describe("remembered smoke selection", () => {
  it("defaults to batches", () => {
    expect(SMOKE_DEFAULT_KIND).toBe("batches");
    expect(restoreSmokeSelection({}, [{ id: "a" }, { id: "b" }])).toEqual({ projectId: "a", kind: "batches" });
  });

  it("parses a stored selection and drops anything malformed", () => {
    expect(parseSmokeLast(JSON.stringify({ projectId: "p9", kind: "audit" }))).toEqual({ projectId: "p9", kind: "audit" });
    expect(parseSmokeLast(JSON.stringify({ projectId: "", kind: "nope" }))).toEqual({});
    expect(parseSmokeLast(JSON.stringify({ projectId: 12, kind: "plan" }))).toEqual({ kind: "plan" });
    expect(parseSmokeLast("{not json")).toEqual({});
    expect(parseSmokeLast(null)).toEqual({});
    expect(parseSmokeLast("null")).toEqual({});
    expect(SMOKE_LAST_KEY).toBe("boardroom.smoke.last");
  });

  it("restores the remembered project only while it is still in the list", () => {
    const projects = [{ id: "a" }, { id: "b" }];
    expect(restoreSmokeSelection({ projectId: "b", kind: "design" }, projects)).toEqual({ projectId: "b", kind: "design" });
    expect(restoreSmokeSelection({ projectId: "gone", kind: "design" }, projects)).toEqual({ projectId: "a", kind: "design" });
    expect(restoreSmokeSelection({ projectId: "b" }, [])).toEqual({ projectId: "", kind: "batches" });
  });

  it("read/write never throw without localStorage", () => {
    expect(readSmokeLast()).toEqual({});
    expect(() => writeSmokeLast({ projectId: "a", kind: "audit" })).not.toThrow();
  });
});
