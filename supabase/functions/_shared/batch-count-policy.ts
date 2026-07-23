// Pure prompt-policy helpers for batch generation.
//
// Runtime output of `batchPromptPolicy` is used verbatim in queues.ts to
// build the Chair prompt for `batches_chair`. `productStrategyContract` is
// used inside the R3 synthesis prompt for non-design runs so plans always
// carry the five-decision Product strategy H2 with owner-authority language.
//
// These are pulled out of queues.ts as pure functions so the prompt shape can
// be regression-tested without spinning up the orchestrator.

export type BatchPromptPolicy = {
  isImport: boolean;
  minBatches: number;
  maxBatches: number;
  rangeText: string;
  rangePrompt: string;
  countRule: string;
};

export function batchPromptPolicy(isImport: boolean): BatchPromptPolicy {
  if (isImport) {
    return {
      isImport: true,
      minBatches: 3,
      maxBatches: 6,
      rangeText: "3-6",
      rangePrompt:
        "Produce 3-6 dependency-safe, single-concern build batches — the SMALLEST count that fully covers the locked improvement plan without padding. Do NOT invent extra batches (or Enhancement batches) to reach six.",
      countRule:
        "Between 3 and 6 batches, chosen to be the smallest count that covers the locked improvement plan. Merge overlapping concerns aggressively; do NOT pad to reach six.",
    };
  }
  return {
    isImport: false,
    minBatches: 6,
    maxBatches: 8,
    rangeText: "6-8",
    rangePrompt:
      "Produce 6-8 dependency-safe, single-concern build batches (STRONGLY PREFER 6) that turn the locked plan + PRD into a shippable app — core batches first, then clearly-labeled Enhancement batches so lower-priority value is never silently dropped.",
    countRule:
      "Exactly 6 batches unless a 7th or 8th is strictly required to keep any single batch below its size limit. Prefer merging overlapping concerns.",
  };
}

// The five-decision Product strategy contract injected into every non-design
// R3 synthesis prompt. Owner-authority language is present for both greenfield
// and imports so the Chair never invents pricing, activation, or positioning
// facts the owner did not supply.
export function productStrategyContract(): string {
  return `The document MUST contain a "## Product strategy" H2 section (place it after the concept/user sections, before Data model) with these concrete decisions in bullet form — one bullet per point. For imported apps the owner's supplied intake answers are AUTHORITY: use them verbatim and NEVER silently replace them. Where an owner input is missing, do NOT invent or assume the missing value and do NOT emit a generic catch-all "assume the missing item" directive — instead follow the per-field rules below (aligned with supabase/functions/_shared/import-contract.ts):

- Reachable buyer + concrete acquisition channel (name the channel; do not say "growth marketing"). If buyer or acquisition channel is not supplied by the owner, explicitly state the context is missing and EXCLUDE any dependent claims, positioning bullets, or executable scope until the owner supplies it — do not invent a segment or channel.
- Paid offer — if not supplied by the owner, explicitly state the context is missing and do not assert a paid product; EXCLUDE monetization scope until the owner supplies it.
- Price anchor — if not supplied by the owner, the Board MAY offer an advisory recommendation ONLY when it is prefixed with "[OWNER DECISION REQUIRED]", marked "proposal_requires_owner_approval", never presented as owner fact, never carries an "OWNER-AUTHORIZED" marker, and is EXCLUDED from any locked plan, executable batch, compiled implementation prompt, checkout flow, pricing CTA, or monetization scope until the owner explicitly approves it.
- Upgrade trigger — same advisory rule as price anchor: only allowed as an "[OWNER DECISION REQUIRED]" / "proposal_requires_owner_approval" recommendation, excluded from locked plans, executable batches, CTAs, checkout, and monetization implementation until the owner approves it.
- First-90-second activation moment — what the new user sees and does in the first ninety seconds. If not supplied by the owner, state the context is missing (assess from code only if visible) and do not invent one.
- Screenshot-worthy wow moment — the one moment worth posting a picture of. If not supplied by the owner, state the context is missing and do not invent one.
- Positioning line completing "Unlike <named alternative>, this app <one clear differentiator>" (do not invent competitors). If positioning is not supplied by the owner, state the context is missing and EXCLUDE positioning claims until the owner supplies it.`;
}
