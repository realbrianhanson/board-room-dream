/**
 * Pure helpers for the "Existing app" import strategy fields.
 *
 * ACTIVATION-FLOW-R2: strategy fields are OPTIONAL at import time. Import
 * readiness depends only on core identity (name, description, at least one
 * goal). Strategy completeness is tracked separately so the audit page can
 * surface "Strategy context X/8" without blocking submission.
 */

export const STRATEGY_FIELDS = [
  "buyer",
  "acquisition_channel",
  "paid_offer",
  "price_anchor",
  "upgrade_trigger",
  "activation_moment",
  "wow_moment",
  "positioning",
] as const;

export type StrategyField = (typeof STRATEGY_FIELDS)[number];

export type ImportStrategyInput = Record<StrategyField, string>;

const t = (v: string | null | undefined) => (v ?? "").trim();

// A field counts as "filled" when it has any non-whitespace content. Price
// anchor and other short values may be a single character (e.g. "0"), so we
// only require length > 0.
function isFilled(value: string | null | undefined): boolean {
  return t(value).length > 0;
}

/**
 * Core-identity readiness for the import form. Strategy fields are handled
 * separately by {@link strategyCompleteness}.
 */
export function isImportReady(input: {
  name: string;
  description: string;
  goals: readonly string[];
}): boolean {
  return (
    t(input.name).length > 0 &&
    t(input.description).length > 0 &&
    input.goals.length > 0
  );
}

/** Returns the names of strategy fields that have no owner-supplied value. */
export function missingStrategyFields(
  input: Partial<ImportStrategyInput>,
): StrategyField[] {
  return STRATEGY_FIELDS.filter((k) => !isFilled(input[k]));
}

/** {filled, total} for the "Strategy context X/8" badge. */
export function strategyCompleteness(
  input: Partial<ImportStrategyInput>,
): { filled: number; total: number } {
  const missing = missingStrategyFields(input).length;
  return { filled: STRATEGY_FIELDS.length - missing, total: STRATEGY_FIELDS.length };
}

/**
 * Trim every strategy field, preserving empty strings so downstream code can
 * treat blanks as explicit "missing owner input" rather than fabricated data.
 */
export function normalizeStrategyForPersist(
  input: Partial<ImportStrategyInput>,
): ImportStrategyInput {
  const out = {} as ImportStrategyInput;
  for (const k of STRATEGY_FIELDS) out[k] = t(input[k]);
  return out;
}

/**
 * Legacy readiness gate (all 8 fields). Retained for callers that still want
 * the "everything filled" signal; the dashboard no longer uses it to block
 * submission.
 */
export function isImportStrategyReady(input: Partial<ImportStrategyInput>): boolean {
  return missingStrategyFields(input).length === 0;
}
