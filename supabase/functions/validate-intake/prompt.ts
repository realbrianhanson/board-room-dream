// Pure helpers for validate-intake. Kept out of index.ts so tests can
// import them without triggering Deno.serve().

export const DIMENSIONS = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
  "activation_value",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];
export type Scores = Record<Dimension, { score: number; evidence: string }>;
export type Verdict = { scores: Scores; total: number; verdict: "pass" | "kill"; pivot?: string };

// Pass threshold now runs on six dimensions (max 60). Historical five-dim
// intakes remain in the DB with total <= 50; those are read via legacy
// rendering paths and are NOT re-evaluated against the new threshold.
export const PASS_THRESHOLD = 36;
export const MAX_SCORE = DIMENSIONS.length * 10; // 60

export function hasMonetizationDetails(answers: any): boolean {
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return !!(trim(answers?.paid_offer) && trim(answers?.price_anchor) && trim(answers?.upgrade_trigger));
}

export function hasAcquisitionChannel(answers: any): boolean {
  return typeof answers?.acquisition_channel === "string" && answers.acquisition_channel.trim().length > 0;
}

export function hasActivationDetails(answers: any): boolean {
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return !!(trim(answers?.activation_moment) && trim(answers?.wow_moment));
}

export function hasPositioning(answers: any): boolean {
  return typeof answers?.positioning === "string" && answers.positioning.trim().length > 0;
}

export function buildUserPrompt(answers: any) {
  const paidOffer = String(answers?.paid_offer ?? "").trim() || "(not supplied)";
  const priceAnchor = String(answers?.price_anchor ?? "").trim() || "(not supplied)";
  const upgradeTrigger = String(answers?.upgrade_trigger ?? "").trim() || "(not supplied)";
  const acquisition = String(answers?.acquisition_channel ?? "").trim() || "(not supplied)";
  const positioning = String(answers?.positioning ?? "").trim() || "(not supplied)";
  const activation = String(answers?.activation_moment ?? "").trim() || "(not supplied)";
  const wow = String(answers?.wow_moment ?? "").trim() || "(not supplied)";
  return `You will score a founder's app intake on six dimensions from 1 to 10. Return ONLY strict JSON:
{
  "scores": {
    "painful_problem": {"score": 1-10, "evidence": "one sentence"},
    "reachable_buyer": {"score": 1-10, "evidence": "one sentence"},
    "monetization_path": {"score": 1-10, "evidence": "one sentence"},
    "buildable_scope": {"score": 1-10, "evidence": "one sentence"},
    "differentiation": {"score": 1-10, "evidence": "one sentence"},
    "activation_value": {"score": 1-10, "evidence": "one sentence"}
  },
  "pivot": "one sentence — only if verdict is kill, else empty string"
}

INTAKE ANSWERS
1. Idea: ${answers?.idea ?? ""}
   1a. Positioning (unlike X, why this): ${positioning}
2. Buyer: ${answers?.buyer ?? ""}
   2a. Acquisition channel (first 10 buyers in 30 days): ${acquisition}
3. Pain: ${answers?.pain ?? ""}
4. Money model: ${answers?.money ?? ""}
   4a. Paid offer (what they pay for): ${paidOffer}
   4b. Price anchor (best guess): ${priceAnchor}
   4c. Upgrade trigger (buy/renew/upgrade): ${upgradeTrigger}
5. Inspiration: ${answers?.inspiration ?? ""}
   5a. Activation moment (useful result in first 90 seconds): ${activation}
   5b. Wow moment (they'd immediately show someone): ${wow}

SCORING RULES (hard):
- monetization_path: MUST be grounded in the paid_offer + price_anchor + upgrade_trigger triple (4a/4b/4c). Reference them by name. If ANY of 4a/4b/4c is "(not supplied)" cap monetization_path at 5.
- reachable_buyer: MUST cite the acquisition_channel (2a). If (2a) is "(not supplied)" cap reachable_buyer at 5.
- differentiation: MUST cite the positioning (1a). If (1a) is "(not supplied)" cap differentiation at 5.
- activation_value: score the first-90-second useful result (5a) and the screenshot/share-worthy wow (5b). If EITHER is "(not supplied)" cap activation_value at 5.

Score honestly. Kill weak ideas fast. If web search results are available, ground your evidence in real competitors and real demand signals — name them in the evidence sentences.`;
}

export function parseVerdict(content: string, answers: any = null): Verdict | null {
  let parsed: any;
  try { parsed = JSON.parse(content); } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }
  const scores: any = parsed?.scores;
  if (!scores) return null;
  const out: any = {};
  let total = 0;
  let anyLow = false;
  const monetizationCap = answers && !hasMonetizationDetails(answers) ? 5 : null;
  const buyerCap = answers && !hasAcquisitionChannel(answers) ? 5 : null;
  const positioningCap = answers && !hasPositioning(answers) ? 5 : null;
  const activationCap = answers && !hasActivationDetails(answers) ? 5 : null;
  for (const d of DIMENSIONS) {
    let s = Number(scores?.[d]?.score);
    const evidence = String(scores?.[d]?.evidence ?? "");
    if (!Number.isFinite(s) || s < 1 || s > 10) return null;
    s = Math.round(s);
    // Deterministic backstops: caps applied when the corresponding intake
    // fields are missing. Model is instructed to do this itself; these caps
    // ensure legacy intakes and rare disobedience cannot inflate scores.
    if (d === "monetization_path" && monetizationCap !== null && s > monetizationCap) s = monetizationCap;
    if (d === "reachable_buyer" && buyerCap !== null && s > buyerCap) s = buyerCap;
    if (d === "differentiation" && positioningCap !== null && s > positioningCap) s = positioningCap;
    if (d === "activation_value" && activationCap !== null && s > activationCap) s = activationCap;
    out[d] = { score: s, evidence };
    total += s;
    if (s <= 3) anyLow = true;
  }
  const verdict: "pass" | "kill" = total < PASS_THRESHOLD || anyLow ? "kill" : "pass";
  const pivot = String(parsed?.pivot ?? "").trim();
  return { scores: out, total, verdict, pivot: verdict === "kill" ? pivot : undefined };
}
