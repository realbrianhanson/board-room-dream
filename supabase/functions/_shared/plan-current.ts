/**
 * Server-side mirror of the client selector: "current" plan means the
 * newest BUILD-SAFE version. Kept in sync with src/lib/plan-current.ts.
 */
export type PlanVersionLite = {
  id: string;
  version: number;
  is_build_safe: boolean;
};

export function selectCurrentPlanVersion<T extends PlanVersionLite>(
  versions: readonly T[],
): T | null {
  const safe = versions.filter((v) => v.is_build_safe);
  if (safe.length === 0) return null;
  return [...safe].sort((a, b) => b.version - a.version)[0] ?? null;
}
