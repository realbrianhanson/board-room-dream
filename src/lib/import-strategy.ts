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

/**
 * {filled, total} for the "Strategy context X/8" badge. Uses the same
 * field-level validity as the readiness gate — a filled-but-invalid
 * value (e.g. "xxxx", "test", punctuation-only) does NOT count toward
 * completeness, so the badge tells the truth about how many fields
 * actually carry credible strategy context.
 */
export function strategyCompleteness(
  input: Partial<ImportStrategyInput>,
): { filled: number; total: number } {
  const filled = STRATEGY_FIELDS.filter((k) => isFieldValid(k, input[k])).length;
  return { filled, total: STRATEGY_FIELDS.length };
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
 * Common filler / placeholder values (case-insensitive, whitespace-collapsed)
 * that must never count as real strategy context. Kept as a Set so the
 * client and server mirrors compare against identical lookups.
 *
 * Legitimate concise values (e.g. "SMBs", "SEO", "free", "$0") are NOT in
 * this list, and pass the length + shape rules in {@link isFieldValid}.
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

/** Normalize for filler lookup: lowercase, collapse whitespace. */
function normFiller(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Repeated single character: "xxxx", "1111", "----". */
function isRepeatedSingleChar(v: string): boolean {
  const stripped = v.replace(/\s+/g, "");
  if (stripped.length < 2) return false;
  return /^(.)\1+$/.test(stripped);
}

/** Only punctuation / symbol characters, no letters or digits. */
function isPunctuationOnly(v: string): boolean {
  return v.length > 0 && !/[\p{L}\p{N}]/u.test(v);
}

/**
 * Field-level validation rules used everywhere strategy context is gated.
 *
 * - `price_anchor` accepts either the canonical recommend placeholder or a
 *   trimmed value with at least 2 characters containing at least one
 *   letter or digit (so "$0", "£9", "free" are valid; "$" and "--" are not).
 * - `upgrade_trigger` accepts the canonical placeholder or ≥3 chars of real signal.
 * - All other fields require ≥3 trimmed characters — accepting legitimate
 *   concise acronyms like "SEO" while still rejecting single-character filler.
 * - Every field additionally rejects repeated-single-character strings,
 *   punctuation-only strings, and common placeholder tokens
 *   (asdf, test, todo, tbd, n/a, none, unknown, lorem, foo/bar, xxx, …).
 * - Only `price_anchor` and `upgrade_trigger` may use the recommend
 *   placeholder; using it elsewhere is rejected.
 */
export function isFieldValid(field: StrategyField, value: string | null | undefined): boolean {
  const v = t(value);
  if (v.length === 0) return false;
  if (isRecommendPlaceholder(v)) {
    return RECOMMENDABLE_FIELDS.includes(field);
  }
  // Universal filler rejection.
  if (isRepeatedSingleChar(v)) return false;
  if (isPunctuationOnly(v)) return false;
  if (FILLER_PLACEHOLDERS.has(normFiller(v))) return false;
  if (field === "price_anchor") {
    // Must be at least 2 chars AND contain at least one letter or digit
    // so a bare "$" or "--" is rejected but "$0" / "£9" / "free" pass.
    return v.length >= 2 && /[\p{L}\p{N}]/u.test(v);
  }
  return v.length >= 3;
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
 * Legacy readiness gate (all 8 fields, strict). Retained for callers that
 * want the "everything filled" signal without accepting the recommend
 * placeholder as a substitute.
 */
export function isImportStrategyReady(input: Partial<ImportStrategyInput>): boolean {
  return STRATEGY_FIELDS.every((k) => {
    const v = t(input[k]);
    if (v.length === 0) return false;
    if (isRecommendPlaceholder(v)) return false;
    return isFieldValid(k, v);
  });
}

