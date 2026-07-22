/**
 * Onboarding primary-path helpers. The activation-first onboarding sets a
 * "skipped" localStorage marker whether the user takes the primary CTA or
 * joins a cohort, so the app never re-nags. Kept pure so tests can assert
 * the invariant without mounting the route.
 */
export const COHORT_SKIP_KEY = "boardroom.cohort_skipped";

export type CohortSkipStorage = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
};

export function markCohortSkipped(storage: CohortSkipStorage): void {
  storage.setItem(COHORT_SKIP_KEY, "1");
}

export function clearCohortSkipped(storage: CohortSkipStorage): void {
  storage.removeItem(COHORT_SKIP_KEY);
}

export function isCohortSkipped(storage: CohortSkipStorage): boolean {
  return storage.getItem(COHORT_SKIP_KEY) === "1";
}

/** Where the primary onboarding CTA should send the user. */
export const ONBOARDING_PRIMARY_DESTINATION = "/dashboard" as const;
