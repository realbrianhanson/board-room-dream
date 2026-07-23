import { describe, expect, it } from "vitest";
import { canProceedFromIntakeStep, MIN_STRATEGY_CHARS, type IntakeAnswers } from "./intake-steps";

const filled: IntakeAnswers = {
  idea: "A specialist scoring engine for founders.",
  positioning: "Unlike a generic template, it grounds every claim in code.",
  buyer: "Solo founders shipping their first Lovable app.",
  acquisition_channel: "Reddit r/SaaS + my own LinkedIn.",
  pain: "They ship broken flows they can't afford to fix.",
  money: "subscription",
  paid_offer: "Monthly Blueprint subscription",
  price_anchor: "$29/mo",
  upgrade_trigger: "Second app import",
  inspiration: "Linear, Notion",
  activation_moment: "First evidence-backed finding in 90s",
  wow_moment: "Screenshot of the locked plan",
};

describe("canProceedFromIntakeStep — five-step persistence of the new required fields", () => {
  it("step 1 (idea) requires idea + positioning", () => {
    expect(canProceedFromIntakeStep("idea", filled)).toBe(true);
    expect(canProceedFromIntakeStep("idea", { ...filled, positioning: "" })).toBe(false);
    expect(canProceedFromIntakeStep("idea", { ...filled, idea: "" })).toBe(false);
  });

  it("step 2 (buyer) requires buyer + acquisition_channel", () => {
    expect(canProceedFromIntakeStep("buyer", filled)).toBe(true);
    expect(canProceedFromIntakeStep("buyer", { ...filled, acquisition_channel: "" })).toBe(false);
    expect(canProceedFromIntakeStep("buyer", { ...filled, buyer: "" })).toBe(false);
  });

  it("step 3 (pain) still just requires pain", () => {
    expect(canProceedFromIntakeStep("pain", filled)).toBe(true);
    expect(canProceedFromIntakeStep("pain", { ...filled, pain: "" })).toBe(false);
  });

  it("step 4 (money) preserves the paid_offer / price_anchor / upgrade_trigger triple", () => {
    expect(canProceedFromIntakeStep("money", filled)).toBe(true);
    expect(canProceedFromIntakeStep("money", { ...filled, paid_offer: "" })).toBe(false);
    expect(canProceedFromIntakeStep("money", { ...filled, price_anchor: "" })).toBe(false);
    expect(canProceedFromIntakeStep("money", { ...filled, upgrade_trigger: "" })).toBe(false);
    expect(canProceedFromIntakeStep("money", { ...filled, money: undefined })).toBe(false);
  });

  it("step 5 (inspiration) requires inspiration + activation_moment + wow_moment", () => {
    expect(canProceedFromIntakeStep("inspiration", filled)).toBe(true);
    expect(canProceedFromIntakeStep("inspiration", { ...filled, activation_moment: "" })).toBe(false);
    expect(canProceedFromIntakeStep("inspiration", { ...filled, wow_moment: "" })).toBe(false);
    expect(canProceedFromIntakeStep("inspiration", { ...filled, inspiration: "" })).toBe(false);
  });
});

describe("shared MIN_STRATEGY_CHARS minimum", () => {
  const tooShort = "x".repeat(MIN_STRATEGY_CHARS - 1);
  const justEnough = "x".repeat(MIN_STRATEGY_CHARS);

  it("rejects strategy fields below the shared minimum (was 2-char bypass)", () => {
    expect(canProceedFromIntakeStep("idea", { ...filled, positioning: tooShort })).toBe(false);
    expect(canProceedFromIntakeStep("buyer", { ...filled, acquisition_channel: tooShort })).toBe(false);
    expect(canProceedFromIntakeStep("money", { ...filled, paid_offer: tooShort })).toBe(false);
    expect(canProceedFromIntakeStep("money", { ...filled, upgrade_trigger: tooShort })).toBe(false);
    expect(canProceedFromIntakeStep("inspiration", { ...filled, activation_moment: tooShort })).toBe(false);
    expect(canProceedFromIntakeStep("inspiration", { ...filled, wow_moment: tooShort })).toBe(false);
  });

  it("accepts strategy fields at exactly the shared minimum", () => {
    expect(canProceedFromIntakeStep("idea", { ...filled, positioning: justEnough })).toBe(true);
  });
});
