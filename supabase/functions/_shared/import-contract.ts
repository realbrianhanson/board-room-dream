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
    line("Description", asString(a.description), "audit must reason from code only for what the app does"),
    line("Stated goals for the board", goals, "no specific goals stated"),
    line("Buyer", asString(a.buyer), "no buyer stated; do not invent a target segment"),
    line("Paid offer", asString(a.paid_offer), "no paid offer stated; may be internal/free — do not assert a paid product"),
    line("Price anchor", asString(a.price_anchor), "no price anchor stated; do not invent one"),
    line("Upgrade trigger", asString(a.upgrade_trigger), "no upgrade/renew/buy trigger stated"),
    line("First-90-second activation moment", asString(a.activation_moment), "no activation moment stated; assess from code only if visible"),
    line("Wow moment", asString(a.wow_moment), "no wow moment stated; do not invent one"),
    line("Positioning (Unlike ___, this app ___)", asString(a.positioning), "no positioning stated; do not invent competitors"),
  ].join("\n");
}
