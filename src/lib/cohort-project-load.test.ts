import { describe, it, expect } from "vitest";
import { selectLoadError } from "./cohort-project-load";

describe("selectLoadError", () => {
  it("returns null when all errors absent", () => {
    expect(selectLoadError([
      { label: "Project", error: null },
      { label: "Owner", error: undefined },
    ])).toBeNull();
  });

  it("returns the first non-null error with label and message", () => {
    expect(selectLoadError([
      { label: "Project", error: null },
      { label: "Batches", error: { message: "boom" } },
      { label: "Findings", error: { message: "later" } },
    ])).toBe("Batches: boom");
  });

  it("falls back to label alone when message is blank", () => {
    expect(selectLoadError([
      { label: "Findings", error: { message: "" } },
    ])).toBe("Findings");
  });
});
