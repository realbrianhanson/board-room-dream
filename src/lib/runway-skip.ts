/**
 * Pure helper for the "sequential skip" rule on the Runway page.
 *
 * A user who chooses to skip a batch also implicitly cannot rely on any later
 * unbuilt batch that depended on it. Rather than silently break that promise
 * we skip the target AND every later batch that is still "unbuilt" (pending
 * or fix_needed). Terminal states (built/passed/sent/auditing/skipped) are
 * left alone so we never rewrite work the user has actually done or shipped.
 */
export type SkipBatchLite = {
  id: string;
  batch_no: number;
  status:
    | "pending"
    | "sent"
    | "built"
    | "auditing"
    | "fix_needed"
    | "passed"
    | "skipped";
};

const UNBUILT: ReadonlySet<SkipBatchLite["status"]> = new Set([
  "pending",
  "fix_needed",
]);

export function computeSkipSuffixIds<T extends SkipBatchLite>(
  batches: readonly T[],
  targetId: string,
): string[] {
  const target = batches.find((b) => b.id === targetId);
  if (!target) return [];
  if (!UNBUILT.has(target.status)) return [];
  const ids: string[] = [];
  const ordered = [...batches].sort((a, b) => a.batch_no - b.batch_no);
  for (const b of ordered) {
    if (b.batch_no < target.batch_no) continue;
    if (b.batch_no === target.batch_no) {
      ids.push(b.id);
      continue;
    }
    if (UNBUILT.has(b.status)) ids.push(b.id);
  }
  return ids;
}
