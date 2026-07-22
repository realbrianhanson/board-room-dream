import { describe, it, expect } from "vitest";
import {
  IMPORT_AUDIT_GATE_MESSAGE,
  importConveneGate,
  isSuccessfulFinalAudit,
} from "./convene-gate";

describe("importConveneGate", () => {
  it("greenfield projects never see the import gate", () => {
    expect(
      importConveneGate({ isImport: false, gateLoading: true, hasSuccessfulFinalAudit: false }),
    ).toBeNull();
  });

  it("import while gate is loading blocks with the canonical message", () => {
    expect(
      importConveneGate({ isImport: true, gateLoading: true, hasSuccessfulFinalAudit: true }),
    ).toBe(IMPORT_AUDIT_GATE_MESSAGE);
  });

  it("import without a successful audit blocks", () => {
    expect(
      importConveneGate({ isImport: true, gateLoading: false, hasSuccessfulFinalAudit: false }),
    ).toBe(IMPORT_AUDIT_GATE_MESSAGE);
  });

  it("import with a successful audit unlocks", () => {
    expect(
      importConveneGate({ isImport: true, gateLoading: false, hasSuccessfulFinalAudit: true }),
    ).toBeNull();
  });
});

describe("isSuccessfulFinalAudit", () => {
  it("clean and findings count", () => {
    expect(isSuccessfulFinalAudit({ status: "clean" })).toBe(true);
    expect(isSuccessfulFinalAudit({ status: "findings" })).toBe(true);
  });
  it("failed and running do not count", () => {
    expect(isSuccessfulFinalAudit({ status: "failed" })).toBe(false);
    expect(isSuccessfulFinalAudit({ status: "running" })).toBe(false);
    expect(isSuccessfulFinalAudit({ status: "queued" })).toBe(false);
  });
});
