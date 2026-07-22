// Pure eligibility check for starting a final A–Z audit.
// Separated so it can be exercised via Deno tests without a live DB.

export type FinalAuditEligibilityInput = {
  isImport: boolean;
  batches: Array<{ status: string }>;
  source: "github" | "paste";
  githubRepo: string | null | undefined;
};

export type FinalAuditEligibilityResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Rules:
 * - Imports may run/retry the final audit at any time, regardless of batch
 *   status. Only the source must be valid (linked repo, or pasted code).
 * - Greenfield (is_import=false) projects still require at least one batch
 *   and every batch to be passed or skipped before the A–Z audit.
 */
export function checkFinalAuditEligibility(
  input: FinalAuditEligibilityInput,
): FinalAuditEligibilityResult {
  const { isImport, batches, source, githubRepo } = input;

  if (source === "github" && !githubRepo) {
    return { ok: false, error: "Link your repo or paste your code first." };
  }

  if (isImport) return { ok: true };

  if (!batches?.length) return { ok: false, error: "No batches to audit" };
  const unresolved = batches.filter(
    (b) => !["passed", "skipped"].includes(b.status),
  );
  if (unresolved.length) {
    return {
      ok: false,
      error: "All batches must be passed or skipped before the A-Z audit",
    };
  }
  return { ok: true };
}
