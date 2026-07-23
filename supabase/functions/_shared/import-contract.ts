// Pure renderer for the IMPORTED APP audit contract. Serializes every
// owner-supplied import intake answer with an explicit "not supplied"
// fallback for legacy imports, so the audit distinguishes owner facts from
// missing context and never invents price/positioning.
//
// Kept dependency-free so it is unit-testable without a Supabase client.

export type ImportAnswers = {
  imported?: unknown;
  description?: unknown;
  goals?: unknown;
  buyer?: unknown;
  paid_offer?: unknown;
  price_anchor?: unknown;
  upgrade_trigger?: unknown;
  activation_moment?: unknown;
  wow_moment?: unknown;
  positioning?: unknown;
  lovable_project_url?: unknown;
} & Record<string, unknown>;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function line(label: string, value: string, missingHint: string): string {
  if (value) return `${label}: ${value}`;
  return `${label}: (not supplied by owner — ${missingHint})`;
}

export function renderImportContract(answers: ImportAnswers | null | undefined): string {
  const a = answers ?? {};
  const goalsRaw = Array.isArray(a.goals) ? (a.goals as unknown[]).map((g) => String(g)) : [];
  const goals = goalsRaw.length ? goalsRaw.join(", ") : "";
  return [
    "IMPORTED APP — the owner already built this and brought it to the board.",
    "The lines below are the OWNER'S OWN WORDS. Treat supplied lines as authoritative facts. Where a line is marked '(not supplied by owner — …)', the owner has not stated it and the board MUST NOT invent a price anchor, positioning claim, or activation/wow moment — say the context is missing rather than fabricating.",
    "",
    "ADVISORY RECOMMENDATIONS (price / upgrade only): For MISSING price_anchor or upgrade_trigger inputs specifically, the Board MAY offer an explicitly assumption-labeled advisory recommendation to help the owner decide. Any such recommendation MUST:",
    "  1. Be prefixed with '[OWNER DECISION REQUIRED]' and marked 'proposal_requires_owner_approval'.",
    "  2. Never be presented as owner fact, and never carry an 'OWNER-AUTHORIZED' marker.",
    "  3. Be EXCLUDED from any locked plan, executable batch, compiled implementation prompt, checkout flow, pricing CTA, or monetization scope until the owner explicitly approves it.",
    "For every other missing field (buyer / paid_offer / activation / wow / positioning / acquisition_channel), the board must say the context is missing rather than propose an advisory recommendation — those are not eligible for the assumption-labeled path.",
    "",
    line("Description", asString(a.description), "audit must reason from code only for what the app does"),
    line("Stated goals for the board", goals, "no specific goals stated"),
    line("Buyer", asString(a.buyer), "no buyer stated; do not invent a target segment"),
    line("Paid offer", asString(a.paid_offer), "no paid offer stated; may be internal/free — do not assert a paid product"),
    line("Price anchor", asString(a.price_anchor), "no price anchor stated; if the board offers a number it MUST be marked [OWNER DECISION REQUIRED] / proposal_requires_owner_approval and excluded from locked plans, batches, CTAs, and checkout until the owner approves"),
    line("Upgrade trigger", asString(a.upgrade_trigger), "no upgrade/renew/buy trigger stated; if the board proposes one it MUST be marked [OWNER DECISION REQUIRED] / proposal_requires_owner_approval and excluded from locked plans and batches until the owner approves"),
    line("First-90-second activation moment", asString(a.activation_moment), "no activation moment stated; assess from code only if visible"),
    line("Wow moment", asString(a.wow_moment), "no wow moment stated; do not invent one"),
    line("Positioning (Unlike ___, this app ___)", asString(a.positioning), "no positioning stated; do not invent competitors"),
  ].join("\n");
}
