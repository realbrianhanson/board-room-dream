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

export function canProceedFromIntakeStep(kind: IntakeStepKind, a: IntakeAnswers): boolean {
  switch (kind) {
    case "idea":
      return t(a.idea).length > 3 && t(a.positioning).length > 1;
    case "buyer":
      return t(a.buyer).length > 3 && t(a.acquisition_channel).length > 1;
    case "pain":
      return t(a.pain).length > 3;
    case "money":
      return (
        !!a.money &&
        t(a.paid_offer).length > 2 &&
        t(a.price_anchor).length > 0 &&
        t(a.upgrade_trigger).length > 2
      );
    case "inspiration":
      return (
        t(a.inspiration).length > 3 &&
        t(a.activation_moment).length > 1 &&
        t(a.wow_moment).length > 1
      );
  }
}
