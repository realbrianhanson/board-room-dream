/**
 * Resume-budget validator for the boardroom-orchestrator's action:"resume"
 * endpoint. Extracted so both the edge handler and unit tests share the
 * exact numeric contract. Never trust arbitrary `extra_budget_usd` from
 * the client — cap a single addition at $10 and total run budget at $30.
 * The separate server-enforced daily cap ($125) is unchanged.
 */

export const RESUME_ADD_MAX_USD = 10;
export const RUN_TOTAL_MAX_USD = 30;

export type ResumeBudgetResult =
  | { ok: true; extra: number; newTotal: number }
  | { ok: false; status: 400; error: string };

export function validateResumeBudget(
  raw: unknown,
  currentBudget: number,
): ResumeBudgetResult {
  const extra = raw == null ? 0 : Number(raw as number | string);
  if (!Number.isFinite(extra)) {
    return { ok: false, status: 400, error: "extra_budget_usd must be a finite number" };
  }
  if (extra < 0) {
    return { ok: false, status: 400, error: "extra_budget_usd cannot be negative" };
  }
  if (extra > RESUME_ADD_MAX_USD) {
    return {
      ok: false,
      status: 400,
      error: `extra_budget_usd cannot exceed $${RESUME_ADD_MAX_USD} per resume`,
    };
  }
  const currentSafe = Number.isFinite(currentBudget) ? currentBudget : 0;
  const newTotal = currentSafe + extra;
  if (newTotal > RUN_TOTAL_MAX_USD) {
    return {
      ok: false,
      status: 400,
      error:
        `Total run budget cannot exceed $${RUN_TOTAL_MAX_USD} ` +
        `(current $${currentSafe.toFixed(2)} + requested $${extra.toFixed(2)} = ` +
        `$${newTotal.toFixed(2)}).`,
    };
  }
  return { ok: true, extra, newTotal };
}
