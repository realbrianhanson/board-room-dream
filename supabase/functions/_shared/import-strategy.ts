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

export function isFieldValid(field: StrategyField, value: string | null | undefined): boolean {
  const v = t(value);
  if (v.length === 0) return false;
  if (isRecommendPlaceholder(v)) return RECOMMENDABLE_FIELDS.includes(field);
  if (field === "price_anchor") return v.length >= 2;
  return v.length >= 4;
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
    const min = f === "price_anchor" ? 2 : 4;
    if (v.length < min) out.push({ field: f, reason: `too-short (min ${min})` });
  }
  return out;
}
