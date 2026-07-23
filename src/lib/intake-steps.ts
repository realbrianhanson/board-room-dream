/**
 * Pure step-gating helpers for the five-step intake wizard, mirrored from
 * intake.$intakeId.tsx so we can prove in tests that each of the new
 * required fields (positioning, acquisition_channel, activation_moment,
 * wow_moment) blocks progression on its step.
 */

export type IntakeAnswers = {
  idea?: string;
  positioning?: string;
  buyer?: string;
  acquisition_channel?: string;
  pain?: string;
  money?: "one_time" | "subscription" | "service_enabler";
  paid_offer?: string;
  price_anchor?: string;
  upgrade_trigger?: string;
  inspiration?: string;
  activation_moment?: string;
  wow_moment?: string;
};

export type IntakeStepKind = "idea" | "buyer" | "pain" | "money" | "inspiration";

const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Shared minimum for owner-supplied "strategy" free-text fields (positioning,
 * acquisition channel, activation moment, wow moment, paid offer, upgrade
 * trigger). Keeps callers from passing 1–2 character placeholders like "x"
 * that pass the old `>1` check while carrying zero signal downstream. We
 * pick a conservative bar (8 chars) rather than an essay-length one so the
 * intake stays fast to complete.
 */
export const MIN_STRATEGY_CHARS = 8;

export function canProceedFromIntakeStep(kind: IntakeStepKind, a: IntakeAnswers): boolean {
  switch (kind) {
    case "idea":
      return t(a.idea).length > 3 && t(a.positioning).length >= MIN_STRATEGY_CHARS;
    case "buyer":
      return t(a.buyer).length > 3 && t(a.acquisition_channel).length >= MIN_STRATEGY_CHARS;
    case "pain":
      return t(a.pain).length > 3;
    case "money":
      // price_anchor is deliberately optional. An owner may leave it unset
      // when they want the Board to recommend one. Blank pricing here is
      // intentional, not invalid — the App Blueprint itself never invents
      // a price for the customer's product.
      return (
        !!a.money &&
        t(a.paid_offer).length >= MIN_STRATEGY_CHARS &&
        t(a.upgrade_trigger).length >= MIN_STRATEGY_CHARS
      );
    case "inspiration":
      return (
        t(a.inspiration).length > 3 &&
        t(a.activation_moment).length >= MIN_STRATEGY_CHARS &&
        t(a.wow_moment).length >= MIN_STRATEGY_CHARS
      );
  }
}
