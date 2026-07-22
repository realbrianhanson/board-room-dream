import { describe, it, expect } from "vitest";
import { projectStatusLine } from "./project-status-line";

describe("projectStatusLine", () => {
  it("shows only status for an import with zero batches (even if current_batch_no is set)", () => {
    expect(
      projectStatusLine({ status: "imported", current_batch_no: 1, has_batches: false }),
    ).toBe("imported");
  });

  it("shows only status when has_batches is false regardless of current_batch_no", () => {
    expect(projectStatusLine({ status: "building", current_batch_no: 3, has_batches: false })).toBe(
      "building",
    );
  });

  it("shows batch suffix when at least one batch row exists", () => {
    expect(projectStatusLine({ status: "building", current_batch_no: 2, has_batches: true })).toBe(
      "building · batch 2",
    );
  });

  it("omits batch suffix when has_batches is true but current_batch_no is 0/undefined", () => {
    expect(projectStatusLine({ status: "locked", current_batch_no: 0, has_batches: true })).toBe(
      "locked",
    );
    expect(projectStatusLine({ status: "locked", has_batches: true })).toBe("locked");
  });

  it("never infers a batch from current_batch_no alone", () => {
    expect(projectStatusLine({ status: "imported", current_batch_no: 1 })).toBe("imported");
  });
});
