import { describe, expect, it } from "vitest";
import {
  COHORT_SKIP_KEY,
  clearCohortSkipped,
  isCohortSkipped,
  markCohortSkipped,
  ONBOARDING_PRIMARY_DESTINATION,
} from "./onboarding";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("onboarding primary path", () => {
  it("primary CTA destination is the dashboard", () => {
    expect(ONBOARDING_PRIMARY_DESTINATION).toBe("/dashboard");
  });

  it("marks cohort skipped so onboarding never re-nags after the primary CTA", () => {
    const s = memoryStorage();
    markCohortSkipped(s);
    expect(isCohortSkipped(s)).toBe(true);
    expect(s.getItem(COHORT_SKIP_KEY)).toBe("1");
  });

  it("joining a cohort clears the skipped marker", () => {
    const s = memoryStorage();
    markCohortSkipped(s);
    clearCohortSkipped(s);
    expect(isCohortSkipped(s)).toBe(false);
  });
});
