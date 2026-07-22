/**
 * Pure helpers that mirror the Dashboard's client-side gating for the
 * "Existing app" import form. Extracted so we can prove the required
 * acquisition_channel field is enforced without mounting the route.
 */

export type ImportStrategyInput = {
  buyer: string;
  acquisition_channel: string;
  paid_offer: string;
  price_anchor: string;
  upgrade_trigger: string;
  activation_moment: string;
  wow_moment: string;
  positioning: string;
};

const t = (v: string) => v.trim();

export function isImportStrategyReady(input: Partial<ImportStrategyInput>): boolean {
  return (
    t(input.buyer ?? "").length > 1 &&
    t(input.acquisition_channel ?? "").length > 1 &&
    t(input.paid_offer ?? "").length > 1 &&
    t(input.price_anchor ?? "").length > 0 &&
    t(input.upgrade_trigger ?? "").length > 1 &&
    t(input.activation_moment ?? "").length > 1 &&
    t(input.wow_moment ?? "").length > 1 &&
    t(input.positioning ?? "").length > 1
  );
}
