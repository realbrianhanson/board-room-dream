/**
 * Pure helpers for the "Existing app" import strategy fields.
 *
 * ACTIVATION-FLOW-R3: the imported-app audit must NOT begin with zero
 * strategic context. Import readiness now requires all eight strategy
 * fields plus core identity. For the two monetization fields owners may
 * legitimately not have decided yet (price_anchor, upgrade_trigger) we
 * accept a normalized "Board should recommend" placeholder so we never
 * force founders to invent a number. Every other field must carry real
 * owner-supplied signal.
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

/**
 * The exact string the UI writes when an owner explicitly defers a
 * monetization decision to the Board. Kept as a single constant so the
 * badge, readiness gate, persistence layer, and downstream audit all
 * recognise the same value.
 */
export const RECOMMEND_PLACEHOLDER = "Not set — Board should recommend";

/** Fields where {@link RECOMMEND_PLACEHOLDER} is a valid owner answer. */
export const RECOMMENDABLE_FIELDS: readonly StrategyField[] = [
  "price_anchor",
  "upgrade_trigger",
];

export function isRecommendPlaceholder(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === RECOMMEND_PLACEHOLDER.toLowerCase();
}

const t = (v: string | null | undefined) => (v ?? "").trim();

function isFilled(value: string | null | undefined): boolean {
  return t(value).length > 0;
}

/** Human labels for the badge / missing-field guidance UI. */
export const STRATEGY_FIELD_LABELS: Record<StrategyField, string> = {
  buyer: "Buyer",
  acquisition_channel: "Acquisition channel",
  paid_offer: "Paid offer",
  price_anchor: "Price anchor",
  upgrade_trigger: "Upgrade trigger",
  activation_moment: "Activation moment",
  wow_moment: "Wow moment",
  positioning: "Positioning",
};

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
 * Core-identity readiness for the import form (name / description / goal).
 * Callers that also need the full strategy-context requirement use
 * {@link isImportReady}.
 */
export function isImportCoreReady(input: {
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

/**
 * Full readiness gate for launching an imported-app audit. Requires the
 * three core-identity fields plus all eight strategy fields. The two
 * recommendable monetization fields accept {@link RECOMMEND_PLACEHOLDER}
 * so owners aren't forced to invent pricing.
 */
export function isImportReady(input: {
  name: string;
  description: string;
  goals: readonly string[];
  strategy?: Partial<ImportStrategyInput>;
}): boolean {
  if (!isImportCoreReady(input)) return false;
  return missingImportFields(input.strategy ?? {}).length === 0;
}

/**
 * The strategy fields still needed before an import audit can launch,
 * honoring {@link RECOMMEND_PLACEHOLDER} for recommendable fields.
 */
export function missingImportFields(
  input: Partial<ImportStrategyInput>,
): StrategyField[] {
  return STRATEGY_FIELDS.filter((k) => !isFilled(input[k]));
}

/**
 * Trim every strategy field, preserving empty strings so downstream code can
 * treat blanks as explicit "missing owner input" rather than fabricated data.
 * Recommendable fields keep the placeholder verbatim.
 */
export function normalizeStrategyForPersist(
  input: Partial<ImportStrategyInput>,
): ImportStrategyInput {
  const out = {} as ImportStrategyInput;
  for (const k of STRATEGY_FIELDS) out[k] = t(input[k]);
  return out;
}

/**
 * Legacy readiness gate (all 8 fields, strict). Retained for callers that
 * want the "everything filled" signal without accepting the recommend
 * placeholder as a substitute.
 */
export function isImportStrategyReady(input: Partial<ImportStrategyInput>): boolean {
  return STRATEGY_FIELDS.every((k) => {
    const v = t(input[k]);
    if (v.length === 0) return false;
    if (isRecommendPlaceholder(v)) return false;
    return true;
  });
}
