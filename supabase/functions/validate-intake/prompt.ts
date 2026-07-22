// Pure helpers for validate-intake. Kept out of index.ts so tests can
// import them without triggering Deno.serve().

export const DIMENSIONS = [
  "painful_problem",
  "reachable_buyer",
  "monetization_path",
  "buildable_scope",
  "differentiation",
] as const;

export type Scores = Record<(typeof DIMENSIONS)[number], { score: number; evidence: string }>;
export type Verdict = { scores: Scores; total: number; verdict: "pass" | "kill"; pivot?: string };

export function hasMonetizationDetails(answers: any): boolean {
  const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return !!(trim(answers?.paid_offer) && trim(answers?.price_anchor) && trim(answers?.upgrade_trigger));
}

export function buildUserPrompt(answers: any) {
  const paidOffer = String(answers?.paid_offer ?? "").trim() || "(not supplied)";
  const priceAnchor = String(answers?.price_anchor ?? "").trim() || "(not supplied)";
  const upgradeTrigger = String(answers?.upgrade_trigger ?? "").trim() || "(not supplied)";
  return `You will score a founder's app intake on five dimensions from 1 to 10. Return ONLY strict JSON:
{
  "scores": {
    "painful_problem": {"score": 1-10, "evidence": "one sentence"},
    "reachable_buyer": {"score": 1-10, "evidence": "one sentence"},
    "monetization_path": {"score": 1-10, "evidence": "one sentence"},
    "buildable_scope": {"score": 1-10, "evidence": "one sentence"},
    "differentiation": {"score": 1-10, "evidence": "one sentence"}
  },
  "pivot": "one sentence — only if verdict is kill, else empty string"
}

INTAKE ANSWERS
1. Idea: ${answers?.idea ?? ""}
2. Buyer: ${answers?.buyer ?? ""}
3. Pain: ${answers?.pain ?? ""}
4. Money model: ${answers?.money ?? ""}
   4a. Paid offer (what they pay for): ${paidOffer}
   4b. Price anchor (best guess): ${priceAnchor}
   4c. Upgrade trigger (buy/renew/upgrade): ${upgradeTrigger}
5. Inspiration: ${answers?.inspiration ?? ""}

MONETIZATION SCORING RULE (hard):
- The monetization_path score MUST be grounded in the paid_offer + price_anchor + upgrade_trigger triple (4a/4b/4c). Reference them by name in the evidence sentence.
- If ANY of 4a/4b/4c is "(not supplied)" you MUST cap monetization_path at 5 and say so in the evidence — the founder has not shown a real path to money yet. Do NOT award 8+ for a strong money "model" alone.

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
  for (const d of DIMENSIONS) {
    let s = Number(scores?.[d]?.score);
    const evidence = String(scores?.[d]?.evidence ?? "");
    if (!Number.isFinite(s) || s < 1 || s > 10) return null;
    s = Math.round(s);
    // Deterministic backstop: cap monetization_path when 4a/4b/4c are not
    // all supplied. The model is instructed to do this itself; the cap here
    // ensures legacy intakes and rare disobedience cannot award a strong
    // monetization score without the concrete offer/anchor/trigger triple.
    if (d === "monetization_path" && monetizationCap !== null && s > monetizationCap) {
      s = monetizationCap;
    }
    out[d] = { score: s, evidence };
    total += s;
    if (s <= 3) anyLow = true;
  }
  const verdict: "pass" | "kill" = total < 30 || anyLow ? "kill" : "pass";
  const pivot = String(parsed?.pivot ?? "").trim();
  return { scores: out, total, verdict, pivot: verdict === "kill" ? pivot : undefined };
}
