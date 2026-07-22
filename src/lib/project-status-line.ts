/**
 * Compute the truthful status line for a project card.
 *
 * Rules:
 * - Never infer a batch number from `projects.current_batch_no`.
 * - Only render a "· batch N" suffix when at least one row exists in the
 *   `batches` table for this project AND that row's number is > 0.
 * - Imports with zero batches must render only their status (e.g. "imported").
 */
export type ProjectStatusInput = {
  status: string;
  current_batch_no?: number | null;
  has_batches?: boolean;
};

export function projectStatusLine(p: ProjectStatusInput): string {
  const status = p.status ?? "";
  const showBatch = Boolean(p.has_batches) && Number(p.current_batch_no ?? 0) > 0;
  return showBatch ? `${status} · batch ${p.current_batch_no}` : status;
}
