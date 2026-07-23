import { describe, expect, it } from "vitest";
import { initialModeFromSearch } from "./dashboard-search";

describe("dashboard search param -> initial mode", () => {
  it("maps ?new=idea to the new-idea flow", () => {
    expect(initialModeFromSearch("idea")).toBe("idea");
  });
  it("maps ?new=import to the existing-app flow", () => {
    expect(initialModeFromSearch("import")).toBe("import");
  });
  it("falls back to null for unknown, empty, or wrong-typed values", () => {
    expect(initialModeFromSearch("")).toBe(null);
    expect(initialModeFromSearch("chooser")).toBe(null);
    expect(initialModeFromSearch("IDEA")).toBe(null); // exact match only
    expect(initialModeFromSearch(undefined)).toBe(null);
    expect(initialModeFromSearch(null)).toBe(null);
    expect(initialModeFromSearch(42)).toBe(null);
    expect(initialModeFromSearch({ new: "idea" })).toBe(null);
  });
});
