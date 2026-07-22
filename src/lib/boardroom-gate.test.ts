import { describe, it, expect } from "vitest";
import {
  computeBoardroomGate,
  IMPORT_AUDIT_GATE_MESSAGE,
} from "./boardroom-gate";

describe("computeBoardroomGate", () => {
  it("returns loading while queries are in flight", () => {
    expect(
      computeBoardroomGate({
        loading: true,
        error: null,
        isImport: true,
        hasSuccessfulAudit: false,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("returns error state (retryable) when any query failed", () => {
    const s = computeBoardroomGate({
      loading: false,
      error: "network exploded",
      isImport: true,
      hasSuccessfulAudit: false,
    });
    expect(s).toEqual({ kind: "error", message: "network exploded" });
  });

  it("gates imports on a successful final audit", () => {
    const s = computeBoardroomGate({
      loading: false,
      error: null,
      isImport: true,
      hasSuccessfulAudit: false,
    });
    expect(s).toEqual({
      kind: "needs-import-audit",
      message: IMPORT_AUDIT_GATE_MESSAGE,
    });
  });

  it("returns ready for imports with a successful audit", () => {
    expect(
      computeBoardroomGate({
        loading: false,
        error: null,
        isImport: true,
        hasSuccessfulAudit: true,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("returns ready for greenfield projects regardless of audit status", () => {
    for (const hasSuccessfulAudit of [false, true]) {
      expect(
        computeBoardroomGate({
          loading: false,
          error: null,
          isImport: false,
          hasSuccessfulAudit,
        }),
      ).toEqual({ kind: "ready" });
    }
  });

  it("error takes precedence over the import-audit gate", () => {
    const s = computeBoardroomGate({
      loading: false,
      error: "boom",
      isImport: true,
      hasSuccessfulAudit: false,
    });
    expect(s.kind).toBe("error");
  });
});
