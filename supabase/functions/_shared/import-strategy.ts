// Deno mirror of src/lib/import-strategy.ts field-level validation rules.
// Kept dependency-free so audit-runner can enforce the same strategy-context
// gate the client uses. A parity test (import-strategy-parity.test.ts) locks
// the rules by exercising identical fixtures through both modules.

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

export const RECOMMEND_PLACEHOLDER = "Not set — Board should recommend";
export const RECOMMENDABLE_FIELDS: readonly StrategyField[] = [
  "price_anchor",
  "upgrade_trigger",
];

export function isRecommendPlaceholder(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === RECOMMEND_PLACEHOLDER.toLowerCase();
}

const t = (v: string | null | undefined) => (v ?? "").trim();

// Mirror of src/lib/import-strategy.ts FILLER_PLACEHOLDERS. Keep in sync.
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

export function isFieldValid(field: StrategyField, value: string | null | undefined): boolean {
  const v = t(value);
  if (v.length === 0) return false;
  if (isRecommendPlaceholder(v)) return RECOMMENDABLE_FIELDS.includes(field);
  if (isRepeatedSingleChar(v)) return false;
  if (isPunctuationOnly(v)) return false;
  if (FILLER_PLACEHOLDERS.has(normFiller(v))) return false;
  if (field === "price_anchor") {
    return v.length >= 2 && /[\p{L}\p{N}]/u.test(v);
  }
  return v.length >= 3;
}

export function validateImportStrategy(
  input: Partial<ImportStrategyInput>,
): Array<{ field: StrategyField; reason: string }> {
  const out: Array<{ field: StrategyField; reason: string }> = [];
  for (const f of STRATEGY_FIELDS) {
    const v = t(input[f]);
    if (v.length === 0) { out.push({ field: f, reason: "missing" }); continue; }
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
