/**
 * Pure helpers for the "Existing app" import strategy fields.
 *
 * ACTIVATION-FLOW-R4: the imported-app A–Z audit requires credible owner
 * context for SIX required fields (buyer, acquisition_channel, paid_offer,
 * activation_moment, wow_moment, positioning). Price anchor and upgrade
 * trigger are owner monetization decisions that may legitimately remain
 * blank — BOTH a blank value AND the canonical "Not set — Board should
 * recommend" placeholder pass the readiness gate. Blanks persist as empty
 * strings so downstream code (audit contract, board prompts) treats them
 * as explicit missing owner input rather than fabricated facts.
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

/** Six fields that MUST carry credible owner context before the A–Z audit. */
export const REQUIRED_STRATEGY_FIELDS: readonly StrategyField[] = [
  "buyer",
  "acquisition_channel",
  "paid_offer",
  "activation_moment",
  "wow_moment",
  "positioning",
];

/** Two owner-decision monetization fields that may remain blank or use the recommend placeholder. */
export const OPTIONAL_MONETIZATION_FIELDS: readonly StrategyField[] = [
  "price_anchor",
  "upgrade_trigger",
];

/**
 * The exact string the UI writes when an owner explicitly defers a
 * monetization decision to the Board. Kept as a single constant so the
 * badge, readiness gate, persistence layer, and downstream audit all
 * recognise the same value.
 */
export const RECOMMEND_PLACEHOLDER = "Not set — Board should recommend";

/** Fields where {@link RECOMMEND_PLACEHOLDER} is a valid owner answer. */
export const RECOMMENDABLE_FIELDS: readonly StrategyField[] = OPTIONAL_MONETIZATION_FIELDS;

export function isRecommendPlaceholder(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === RECOMMEND_PLACEHOLDER.toLowerCase();
}

const t = (v: string | null | undefined) => (v ?? "").trim();

function isFilled(value: string | null | undefined): boolean {
  return t(value).length > 0;
}

export function isOptionalMonetizationField(field: StrategyField): boolean {
  return OPTIONAL_MONETIZATION_FIELDS.includes(field);
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

/** Returns strategy fields (both required + optional) that have no owner-supplied value. */
export function missingStrategyFields(
  input: Partial<ImportStrategyInput>,
): StrategyField[] {
  return STRATEGY_FIELDS.filter((k) => !isFilled(input[k]));
}

/**
 * Breakdown for the "Strategy context" badge: how many required fields carry
 * credible owner signal (X/6), and how many optional monetization fields the
 * owner has filled or explicitly deferred (Y/2). Uses the same field-level
 * validity as the readiness gate — filler ("xxxx", "test", punctuation-only)
 * does NOT count. For optional monetization fields, both a real value AND
 * the canonical recommend placeholder count as "filled".
 */
export function strategyCompleteness(
  input: Partial<ImportStrategyInput>,
): {
  required: { filled: number; total: number };
  optional: { filled: number; total: number };
} {
  const requiredFilled = REQUIRED_STRATEGY_FIELDS.filter((k) => isFieldValid(k, input[k])).length;
  const optionalFilled = OPTIONAL_MONETIZATION_FIELDS.filter((k) => {
    const v = t(input[k]);
    if (v.length === 0) return false;
    return isFieldValid(k, v);
  }).length;
  return {
    required: { filled: requiredFilled, total: REQUIRED_STRATEGY_FIELDS.length },
    optional: { filled: optionalFilled, total: OPTIONAL_MONETIZATION_FIELDS.length },
  };
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
 * three core-identity fields plus credible owner context for every
 * REQUIRED strategy field. Price anchor and upgrade trigger are owner
 * decisions — blank or the recommend placeholder both pass.
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
 * REQUIRED strategy fields still missing/invalid before an import audit can
 * launch. Optional monetization fields (price_anchor, upgrade_trigger) are
 * never listed here — blank counts as an owner decision to defer.
 */
export function missingImportFields(
  input: Partial<ImportStrategyInput>,
): StrategyField[] {
  return REQUIRED_STRATEGY_FIELDS.filter((k) => !isFieldValid(k, input[k]));
}


/**
 * Trim every strategy field, preserving empty strings so downstream code can
 * treat blanks as explicit "missing owner input" rather than fabricated data.
 * Blank price_anchor / upgrade_trigger MUST stay blank — never coerced to
 * the recommend placeholder or any invented value.
 */
export function normalizeStrategyForPersist(
  input: Partial<ImportStrategyInput>,
): ImportStrategyInput {
  const out = {} as ImportStrategyInput;
  for (const k of STRATEGY_FIELDS) out[k] = t(input[k]);
  return out;
}


/**
 * Common filler / placeholder values (case-insensitive, whitespace-collapsed)
 * that must never count as real strategy context. Kept as a Set so the
 * client and server mirrors compare against identical lookups.
 */
const FILLER_PLACEHOLDERS = new Set<string>([
  "asdf", "asdfasdf", "qwerty", "qwertyuiop",
  "test", "tests", "testing", "test test",
  "todo", "to do", "to-do",
  "tbd", "tba",
  "n/a", "na", "n a",
  "none", "nope",
  "unknown", "idk", "dunno", "??", "???",
  "lorem", "lorem ipsum",
  "placeholder", "example", "sample",
  "foo", "bar", "foobar", "baz",
  "xxx", "yyy", "zzz",
]);

function normFiller(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

function isRepeatedSingleChar(v: string): boolean {
  const stripped = v.replace(/\s+/g, "");
  if (stripped.length < 2) return false;
  return /^(.)\1+$/.test(stripped);
}

function isPunctuationOnly(v: string): boolean {
  return v.length > 0 && !/[\p{L}\p{N}]/u.test(v);
}

/**
 * Field-level validation rules used everywhere strategy context is gated.
 *
 * - Optional monetization fields (price_anchor, upgrade_trigger) accept a
 *   BLANK value (owner deferring the decision) OR the canonical
 *   {@link RECOMMEND_PLACEHOLDER}. Non-blank values still must pass the
 *   filler / shape rules; price_anchor accepts short-but-meaningful values
 *   ("$0", "£9", "free"), upgrade_trigger needs ≥3 chars.
 * - Required strategy fields (buyer / acquisition / paid_offer /
 *   activation / wow / positioning) MUST carry ≥3 trimmed characters of
 *   credible signal. The recommend placeholder is REJECTED there.
 * - Every non-blank value rejects repeated-single-character strings,
 *   punctuation-only strings, and common placeholder tokens
 *   (asdf, test, todo, tbd, n/a, none, unknown, lorem, foo/bar, xxx, …).
 */
export function isFieldValid(field: StrategyField, value: string | null | undefined): boolean {
  const v = t(value);
  const optional = isOptionalMonetizationField(field);
  if (v.length === 0) return optional; // blank is a valid owner decision on optional fields only.
  if (isRecommendPlaceholder(v)) return optional; // placeholder only on optional fields.
  if (isRepeatedSingleChar(v)) return false;
  if (isPunctuationOnly(v)) return false;
  if (FILLER_PLACEHOLDERS.has(normFiller(v))) return false;
  if (field === "price_anchor") {
    return v.length >= 2 && /[\p{L}\p{N}]/u.test(v);
  }
  return v.length >= 3;
}

/**
 * Returns a list of `{ field, reason }` explaining every invalid strategy
 * field, suitable for surfacing in the UI and server error responses.
 * Blank optional monetization fields (price_anchor, upgrade_trigger) never
 * generate an issue — they are owner decisions.
 */
export function validateImportStrategy(
  input: Partial<ImportStrategyInput>,
): Array<{ field: StrategyField; reason: string }> {
  const out: Array<{ field: StrategyField; reason: string }> = [];
  for (const f of STRATEGY_FIELDS) {
    const v = t(input[f]);
    const optional = isOptionalMonetizationField(f);
    if (v.length === 0) {
      if (!optional) out.push({ field: f, reason: "missing" });
      continue;
    }
    if (isRecommendPlaceholder(v)) {
      if (!optional) out.push({ field: f, reason: "placeholder-not-allowed" });
      continue;
    }
    if (isRepeatedSingleChar(v)) { out.push({ field: f, reason: "filler" }); continue; }
    if (isPunctuationOnly(v))    { out.push({ field: f, reason: "filler" }); continue; }
    if (FILLER_PLACEHOLDERS.has(normFiller(v))) { out.push({ field: f, reason: "filler" }); continue; }
    if (f === "price_anchor") {
      if (v.length < 2 || !/[\p{L}\p{N}]/u.test(v)) {
        out.push({ field: f, reason: "too-short (min 2)" });
      }
      continue;
    }
    if (v.length < 3) out.push({ field: f, reason: "too-short (min 3)" });
  }
  return out;
}

/**
 * Readiness gate signalling that the strategy inputs are shippable to the
 * audit runner. Requires credible signal on every REQUIRED field and, for
 * optional monetization fields, accepts blank OR the recommend placeholder
 * (never fabricated filler). Kept in lockstep with {@link isImportReady}
 * so client and server can never disagree.
 */
export function isImportStrategyReady(input: Partial<ImportStrategyInput>): boolean {
  return validateImportStrategy(input).length === 0;
}
