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
 * Uses the strict field-level validator below so the badge, readiness
 * gate, client button, and server gate all agree on what counts as
 * credible strategy context.
 */
export function missingImportFields(
  input: Partial<ImportStrategyInput>,
): StrategyField[] {
  return STRATEGY_FIELDS.filter((k) => !isFieldValid(k, input[k]));
}

/**
 * Field-level validation rules used everywhere strategy context is gated.
 *
 * - `price_anchor` accepts either the canonical recommend placeholder or a
 *   trimmed value with at least 2 characters (so "$0", "£9", "free" are
 *   valid). Founders may legitimately not have chosen a price yet.
 * - `upgrade_trigger` accepts the canonical placeholder or ≥4 chars.
 * - All other fields require ≥4 trimmed characters of real signal — a
 *   single-character filler is not credible strategy context.
 * - Only `price_anchor` and `upgrade_trigger` may use the placeholder;
 *   using it elsewhere is rejected.
 */
export function isFieldValid(field: StrategyField, value: string | null | undefined): boolean {
  const v = t(value);
  if (v.length === 0) return false;
  if (isRecommendPlaceholder(v)) {
    return RECOMMENDABLE_FIELDS.includes(field);
  }
  if (field === "price_anchor") return v.length >= 2;
  return v.length >= 4;
}

/**
 * Returns a list of `{ field, reason }` explaining every invalid strategy
 * field, suitable for surfacing in the UI and server error responses.
 */
export function validateImportStrategy(
  input: Partial<ImportStrategyInput>,
): Array<{ field: StrategyField; reason: string }> {
  const out: Array<{ field: StrategyField; reason: string }> = [];
  for (const f of STRATEGY_FIELDS) {
    const v = t(input[f]);
    if (v.length === 0) {
      out.push({ field: f, reason: "missing" });
      continue;
    }
    if (isRecommendPlaceholder(v)) {
      if (!RECOMMENDABLE_FIELDS.includes(f)) {
        out.push({ field: f, reason: "placeholder-not-allowed" });
      }
      continue;
    }
    const min = f === "price_anchor" ? 2 : 4;
    if (v.length < min) out.push({ field: f, reason: `too-short (min ${min})` });
  }
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

