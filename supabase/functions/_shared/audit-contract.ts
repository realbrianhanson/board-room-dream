// Deterministic target-selection for the final A-Z audit.
// Fixes the imported-app contract bug: when an imported project has a locked
// FUTURE improvement plan/design plus pending batches, a re-audit was grading
// today's repo against unbuilt work. This module chooses either the full
// blueprint (locked plan + PRD + design) or the current-milestone contract
// (intake description + only actually implemented batch contracts).
//
// Rules (kind === 'final_az'):
//   - Non-import projects: 'full_blueprint'.
//   - Import + zero batches: 'import_current_milestone'.
//   - Import + any batch not in {passed}: 'import_current_milestone'.
//     Included implemented batches: status in {built, auditing, fix_needed, passed}.
//     Explicitly excluded: pending, sent, skipped.
//   - Import + >= 1 batch AND every batch status is 'passed': 'full_blueprint'.

export type AuditContractMode = "import_current_milestone" | "full_blueprint";

export type ContractBatch = {
  id: string;
  batch_no: number | null;
  title: string | null;
  channel: string | null;
  status: string;
  prompt_md?: string | null;
  compiled_prompt_md?: string | null;
};

export const IMPLEMENTED_BATCH_STATUSES = new Set([
  "built",
  "auditing",
  "fix_needed",
  "passed",
]);

// Deterministic ceiling on the extra current-milestone context appended to the
// per-seat prompt, in characters. Keeps final-audit prompts bounded regardless
// of how many batches have been implemented.
export const MAX_EXTRA_CONTRACT_CHARS = 30_000;

// Sentinel substrings the current-milestone audit must NEVER emit into seat
// requests — presence indicates a future-plan leak.
export const UNBUILT_LEAK_SENTINELS = [
  "PLAN\n",
  "DESIGN BRIEF\n",
] as const;

export function resolveAuditContractMode(
  isImport: boolean,
  batches: Array<{ status: string }>,
): AuditContractMode {
  if (!isImport) return "full_blueprint";
  if (!batches || batches.length === 0) return "import_current_milestone";
  const allPassed = batches.every((b) => b.status === "passed");
  return allPassed ? "full_blueprint" : "import_current_milestone";
}

export function selectImplementedBatches(
  batches: ContractBatch[],
): ContractBatch[] {
  return batches
    .filter((b) => IMPLEMENTED_BATCH_STATUSES.has(b.status))
    .sort((a, b) => (a.batch_no ?? 0) - (b.batch_no ?? 0));
}

export type ImplementedContextResult = {
  text: string;
  includedIds: string[];
  truncated: boolean;
};

/**
 * Build the implemented-batches context block appended to a current-milestone
 * final audit. Bounded by MAX_EXTRA_CONTRACT_CHARS; if a batch would overflow,
 * its actionable contract is truncated at a safe boundary with a marker, and
 * later batches beyond the budget are omitted with a tail marker. batch_no,
 * title, and channel are always preserved so evidence still cites real work.
 */
export function buildImplementedBatchesContext(
  batches: ContractBatch[],
): ImplementedContextResult {
  const selected = selectImplementedBatches(batches);
  if (selected.length === 0) {
    return { text: "", includedIds: [], truncated: false };
  }
  const header =
    "IMPLEMENTED IMPROVEMENT BATCHES (audit today's app; do NOT grade unbuilt work):\n\n";
  const parts: string[] = [header];
  const includedIds: string[] = [];
  let used = header.length;
  let truncated = false;

  for (const b of selected) {
    const body = String(b.compiled_prompt_md ?? b.prompt_md ?? "").trim();
    const title = b.title ?? "(untitled)";
    const channel = b.channel ?? "lovable";
    const bno = b.batch_no ?? 0;
    const bHead = `--- Batch ${bno} — ${title} [${channel}] (${b.status}) ---\n`;
    const trailer = "\n";
    const overhead = bHead.length + trailer.length;
    const remaining = MAX_EXTRA_CONTRACT_CHARS - used;
    if (remaining <= overhead + 80) {
      parts.push(
        "\n[TRUNCATED: additional implemented batches omitted to keep audit context <= 30000 chars]\n",
      );
      truncated = true;
      break;
    }
    const budget = remaining - overhead;
    let excerpt = body;
    if (excerpt.length > budget) {
      const marker = `\n[TRUNCATED batch contract at ${budget - 60} chars for context budget]`;
      excerpt = excerpt.slice(0, Math.max(0, budget - marker.length)) + marker;
      truncated = true;
    }
    const chunk = bHead + excerpt + trailer;
    parts.push(chunk);
    used += chunk.length;
    includedIds.push(b.id);
  }

  return { text: parts.join(""), includedIds, truncated };
}

export type PlanLike = {
  content_md?: string | null;
  prd_md?: string | null;
} | null;

export type ResolvedContract = {
  mode: AuditContractMode;
  planContentMd: string | null; // full plan text (or import intake, in milestone mode)
  prdMd: string | null;
  designBrief: string | null;
  includedBatchIds: string[];
  extraContext: string; // implemented-batches block for milestone mode; else ""
  extraTruncated: boolean;
};

/**
 * Assemble the final-audit contract for a project.
 *
 * @param isImport      projects.is_import
 * @param batches       every batch row for the project (id/status required)
 * @param plan          latest locked plan_versions row for kind='plan' (or null)
 * @param designBrief   latest plan_versions.content_md for kind='design' (or null)
 * @param importIntake  fallback intake-derived contract (only used when
 *                      loadImportContract already resolved) — used in
 *                      milestone mode, and as fallback if plan is missing.
 */
export function resolveFinalAuditContract(input: {
  isImport: boolean;
  batches: ContractBatch[];
  plan: PlanLike;
  designBrief: string | null;
  importIntake: { content_md: string; prd_md: string } | null;
}): ResolvedContract {
  const { isImport, batches, plan, designBrief, importIntake } = input;
  const mode = resolveAuditContractMode(isImport, batches);

  if (mode === "import_current_milestone") {
    const { text, includedIds, truncated } = buildImplementedBatchesContext(batches);
    return {
      mode,
      planContentMd: importIntake?.content_md ?? null,
      prdMd: importIntake?.prd_md ?? null,
      designBrief: null,
      includedBatchIds: includedIds,
      extraContext: text,
      extraTruncated: truncated,
    };
  }

  // full_blueprint
  return {
    mode,
    planContentMd: plan?.content_md ?? importIntake?.content_md ?? null,
    prdMd: plan?.prd_md ?? importIntake?.prd_md ?? null,
    designBrief: designBrief,
    includedBatchIds: [],
    extraContext: "",
    extraTruncated: false,
  };
}

/**
 * Render the plan/PRD/design section for a seat prompt. Deduplicates when
 * PRD and PLAN content are byte-identical (common for import intake, which
 * synthesises the same contract into both fields).
 */
export function renderContractSection(c: {
  planContentMd: string | null;
  prdMd: string | null;
  designBrief: string | null;
  extraContext: string;
  mode: AuditContractMode;
}): string {
  const prd = (c.prdMd ?? "").trim();
  const plan = (c.planContentMd ?? "").trim();
  const design = (c.designBrief ?? "").trim();

  const lines: string[] = [];
  if (prd && plan && prd === plan) {
    lines.push("PRD / PLAN (identical)");
    lines.push(prd);
  } else {
    lines.push("PRD");
    lines.push(prd || "(none)");
    if (c.mode === "full_blueprint") {
      lines.push("");
      lines.push("PLAN");
      lines.push(plan || "(none)");
    } else if (plan && plan !== prd) {
      // Milestone mode: intake sometimes yields distinct plan text; keep it
      // but under a milestone label so seats don't treat it as future work.
      lines.push("");
      lines.push("CURRENT MILESTONE CONTRACT");
      lines.push(plan);
    }
  }

  if (c.mode === "full_blueprint") {
    lines.push("");
    lines.push("DESIGN BRIEF");
    lines.push(design || "(none)");
  }

  if (c.extraContext) {
    lines.push("");
    lines.push(c.extraContext.trimEnd());
  }

  return lines.join("\n");
}
