/**
 * Pure selector for the "current" plan version.
 *
 * "Current" ALWAYS means the newest build-safe row. Unsafe rows (invalidated
 * under a later founder-authority version, or explicitly marked legacy) may
 * appear in history but must never present as current — otherwise batches,
 * change requests, compilers, and audits would inherit unsafe state.
 *
 * Callers pass rows in any order; this function does not mutate the input.
 */
export type PlanVersionLite = {
  id: string;
  version: number;
  is_build_safe: boolean;
  invalidated_reason?: string | null;
  locked_at?: string | null;
};

export function selectCurrentPlanVersion<T extends PlanVersionLite>(
  versions: readonly T[],
): T | null {
  const safe = versions.filter((v) => v.is_build_safe);
  if (safe.length === 0) return null;
  return [...safe].sort((a, b) => b.version - a.version)[0] ?? null;
}

/** Was any plan version invalidated (i.e. there is a legacy history)? */
export function hasLegacyPlanHistory(versions: readonly PlanVersionLite[]): boolean {
  return versions.some((v) => !v.is_build_safe);
}
