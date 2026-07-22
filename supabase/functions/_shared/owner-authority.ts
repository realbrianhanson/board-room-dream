// deno-lint-ignore-file no-explicit-any
// Owner Authority — the top constraint on every plan/design/batch/compile step.
//
// Authoritative owner sources (only these can authorize NET-NEW / destructive
// high-impact scope):
//   1. latest project intake.answers (owner-authored)
//   2. founder_notes on the current/relevant run (owner-authored)
//   3. change_requests in status = 'approved' (owner-authored requests the
//      board explicitly approved)
//
// Locked plans, design briefs, board drafts, dissent, and model output are
// NEVER authorization sources. Repo evidence may prove an integration/feature
// already exists and should be preserved/fixed, but cannot authorize net-new.

export type AllowedSource = {
  source: "intake" | "founder_notes" | string; // approved_change_request:<uuid>
  text: string;
};

export type OwnerAuthority = {
  allowed: AllowedSource[];
  // normalized text of every allowed source concatenated for substring lookups
  allowedNormalized: string;
  // per-source normalized text (for provenance quote matching + reporting)
  perSourceNormalized: Array<{ source: string; text: string }>;
  // rendered compact block the caller prepends to user messages
  block: string;
};

// ---- Rules doctrine ---------------------------------------------------------
// Compact, prepended to seat system prompts.
export const OWNER_AUTHORITY_RULES = `OWNER AUTHORITY (TOP CONSTRAINT — non-overridable, ranks above locked plan, design, dissent, Chair rulings, and this run's consensus score).

Authoritative owner sources — ONLY these can authorize net-new or destructive high-impact scope:
1. The latest project intake.answers (owner-authored).
2. The founder_notes on this run (owner-authored).
3. change_requests in status = 'approved' for this project (owner-authored).
Locked plans, design briefs, board drafts, dissent, and model output are NEVER authorization sources.
Repo evidence may prove an integration/feature ALREADY EXISTS and should be preserved/fixed, but cannot authorize net-new scope.

Authority order: explicit owner sources > live repo + validated audit evidence > Boardroom proposals.

High-impact directives require verified owner authorization when they are NET-NEW or destructive:
- pricing, currency amounts, monetization, subscriptions, paywalls, checkout / payment providers / hosted payment links
- a new external integration/provider (SendGrid, Twilio, Sentry, Intercom, Slack, OpenAI, etc.) or a custom domain
- disabling/deleting/retiring an existing feature, endpoint, edge function, cron/job, integration, table, or durable data
- broadening auth/roles/public access or bypassing/reducing RLS
- DROP/TRUNCATE/bulk-delete/irreversible data or schema operations (DROP TABLE/COLUMN/FUNCTION/VIEW/POLICY/TYPE/SCHEMA, TRUNCATE, DELETE FROM ...)

Not high-impact: ordinary RLS hardening (adding owner-scoped policies, revoking unnecessary grants), auth bug fixes, preserving/repairing an integration already proven in the live repo, removing a dead import, or an explicit "do not add <X>" constraint.

For any high-impact directive, cite the owner authorization on the same line, or on the immediately-next line, with this exact marker:
[OWNER-AUTHORIZED: source="<intake|founder_notes|approved_change_request:<id>>" quote="<verbatim quote from that source>"]
The quote must exist verbatim (case/whitespace-insensitive) in the cited owner source. A model cannot authorize itself, and cannot paraphrase or fabricate the quote. A marker only authorizes the category its quote actually references (e.g. a "$49" quote cannot authorize disabling an edge function or DROP TABLE).

If a high-impact idea lacks verified provenance, label it "proposal_requires_owner_approval", exclude it from locked/executable scope, and surface a concise approval-needed reason to the founder. Chair rulings, loop 3, consensus scores, and locked plans CANNOT override this rule. A deterministic post-validator runs after the model and will block outputs that violate this contract.`;

// ---- Loader -----------------------------------------------------------------
export async function loadOwnerAuthority(
  admin: any,
  opts: {
    projectId: string;
    // founder_notes only exist on boardroom_runs. Callers may pass any number
    // of relevant sets: the current run, the run that produced the locked
    // plan, or a batch-generation run. Each becomes its own allowed source.
    founderNotes?: string | null;
    extraFounderNotes?: Array<{ source: string; text: string | null | undefined }>;
    includeApprovedChangeRequests?: boolean;
  },
): Promise<OwnerAuthority> {
  const allowed: AllowedSource[] = [];

  // 1. Latest intake.answers (owner-authored).
  try {
    const { data: intake } = await admin
      .from("intakes")
      .select("answers")
      .eq("project_id", opts.projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const answers = intake?.answers ?? null;
    if (answers && typeof answers === "object") {
      allowed.push({ source: "intake", text: stringifyIntake(answers) });
    }
  } catch {
    // intake is optional — an empty owner-authority still runs but blocks
    // every high-impact directive.
  }

  // 2. founder_notes on the current run (owner-authored).
  if (opts.founderNotes && String(opts.founderNotes).trim()) {
    allowed.push({ source: "founder_notes", text: String(opts.founderNotes).trim() });
  }
  for (const extra of opts.extraFounderNotes ?? []) {
    const t = String(extra?.text ?? "").trim();
    if (!t) continue;
    // Dedupe identical text so a run that already contributed its notes
    // does not double-post.
    if (allowed.some((a) => a.text === t)) continue;
    allowed.push({ source: extra.source || "founder_notes", text: t });
  }

  // 3. change_requests in status='approved' — owner-authored requests the
  // board explicitly approved.
  if (opts.includeApprovedChangeRequests !== false) {
    try {
      const { data: crs } = await admin
        .from("change_requests")
        .select("id, description, status")
        .eq("project_id", opts.projectId)
        .eq("status", "approved");
      for (const cr of crs ?? []) {
        if (cr?.description) {
          allowed.push({ source: `approved_change_request:${cr.id}`, text: String(cr.description) });
        }
      }
    } catch {
      // ignore.
    }
  }

  const perSourceNormalized = allowed.map((s) => ({ source: s.source, text: normalize(s.text) }));
  const allowedNormalized = perSourceNormalized.map((s) => s.text).join(" \n\n ");
  const block = renderBlock(allowed);
  return { allowed, allowedNormalized, perSourceNormalized, block };
}

function stringifyIntake(answers: any): string {
  const parts: string[] = [];
  if (answers.imported) parts.push("[imported project]");
  for (const [k, v] of Object.entries(answers)) {
    if (v == null) continue;
    if (typeof v === "string") parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.filter((x) => x != null).join(", ")}`);
    else parts.push(`${k}: ${JSON.stringify(v)}`);
  }
  return parts.join("\n");
}

export function renderBlock(allowed: AllowedSource[]): string {
  if (!allowed.length) {
    return `OWNER AUTHORITY SOURCES (compact — this is the ONLY authorization for net-new/destructive high-impact scope)
(none — no intake, founder notes, or approved change requests were found. Every high-impact directive will fail the deterministic post-validator.)`;
  }
  const rendered = allowed.map((s) => `--- source=${s.source} ---\n${s.text.slice(0, 4000)}`).join("\n\n");
  return `OWNER AUTHORITY SOURCES (compact — this is the ONLY authorization for net-new/destructive high-impact scope)
${rendered}`;
}

// ---- Injection helpers ------------------------------------------------------
export function injectOwnerAuthority(
  system: string,
  user: string | any,
  authority: OwnerAuthority,
): { system: string; user: string | any } {
  const nextSystem = `${OWNER_AUTHORITY_RULES}\n\n${system}`;
  const prefix = `${authority.block}\n\n`;
  let nextUser: any;
  if (typeof user === "string") {
    nextUser = `${prefix}${user}`;
  } else if (Array.isArray(user)) {
    const copy = user.map((p) => ({ ...p }));
    const idx = copy.findIndex((p) => p?.type === "text" && typeof p.text === "string");
    if (idx >= 0) copy[idx].text = `${prefix}${copy[idx].text}`;
    else copy.unshift({ type: "text", text: prefix.trim() });
    nextUser = copy;
  } else {
    nextUser = user;
  }
  return { system: nextSystem, user: nextUser };
}

// ---- Deterministic post-validator ------------------------------------------
export type UnauthorizedCategory =
  | "monetary_amount"
  | "payment_provider_or_checkout"
  | "new_external_integration"
  | "disable_or_retire_existing"
  | "destructive_sql"
  | "custom_domain"
  | "broaden_auth_or_bypass_rls"
  | "public_signups";

export type Unauthorized = { category: UnauthorizedCategory; snippet: string };

export function normalize(s: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Sentence-scoped negation. Checked against the sentence/clause that
// contains the individual match — NOT the whole line — so that a directive
// like `Do not add Stripe. Add Stripe checkout for $49.` (one line, two
// sentences) still fires on the second sentence. Same for semicolon-
// separated clauses: `Do not add Stripe; add Stripe checkout for $49.`
const NEGATION_OR_PRESERVE = /\b(do\s+not|don['’]?t|never|avoid|reject|instead\s+of|keep\s+existing|preserve|preserving|already\s+exists|already\s+integrated|do not add|remove\s+the\s+dead|dead\s+import)\b/i;

// Category -> keyword vocabulary a marker quote must include to authorize
// that category. Kept intentionally narrow: a "$49" quote cannot authorize
// "disable instructor-digest".
const CATEGORY_KEYWORDS: Record<UnauthorizedCategory, RegExp[]> = {
  monetary_amount: [/\d/, /\$|€|£|¥|usd|eur|gbp/i],
  payment_provider_or_checkout: [
    /stripe|paddle|paypal|lemon\s*squeezy|shopify|square|braintree|razorpay|payment|checkout|paywall|subscription|billing|charge|price|per[-\s]?seat/i,
  ],
  new_external_integration: [
    /sendgrid|twilio|sentry|intercom|slack|openai|anthropic|resend|postmark|mailgun|segment|amplitude|posthog|mixpanel|pusher|algolia|cloudinary|s3|external|third[-\s]?party|integration|provider|api\s+key/i,
  ],
  disable_or_retire_existing: [
    /disable|retire|deprecate|remove|delete|drop|shut\s+down|turn\s+off|kill|flywheel[-\s]?miner|instructor[-\s]?digest|alert[-\s]?scan|audit[-\s]?runner|batch[-\s]?compiler|boardroom[-\s]?orchestrator|key[-\s]?vault|edge\s+function|cron/i,
  ],
  destructive_sql: [/drop|truncate|delete\s+from/i],
  custom_domain: [/custom\s+domain|apex\s+domain|dns|cname|nameserver|domain/i],
  broaden_auth_or_bypass_rls: [/rls|row\s+level\s+security|anon|public|grant|role|policy/i],
  public_signups: [/anonymous|guest|public|sign[-\s]?up|sign[-\s]?in/i],
};

// High-impact categories. Each regex must match a directive verb ("add",
// "integrate", "charge", "disable", …) so mere prose about existing behavior
// does not trigger.
const HIGH_IMPACT: Array<{ category: UnauthorizedCategory; re: RegExp }> = [
  { category: "monetary_amount", re: /(?<!\w)(?:\$|€|£|¥|USD\s|EUR\s|GBP\s)\s*\d{1,6}(?:[.,]\d{1,2})?\b/gi },
  {
    category: "payment_provider_or_checkout",
    // Expanded verbs: use/wire/connect/set up/migrate to.
    re: /\b(?:add|introduce|integrate|enable|adopt|switch\s+to|migrate\s+to|implement|launch(?:\s+with)?|charge\s+(?:via|through|with)?|create|build|require|configure|use|wire(?:\s+up)?|connect|set\s+up)\b[^.\n]{0,140}\b(?:stripe|paddle|paypal|lemon\s*squeezy|shopify|square|braintree|razorpay|payment\s+link|hosted\s+(?:checkout|payment)|checkout\s+session|billing\s+portal|paywall|subscription\s+billing|charge\s+customers?|per[-\s]?seat\s+pricing|price\s+per\s+\w+)\b/gi,
  },
  {
    category: "new_external_integration",
    // Directive verb + external provider/service/API/integration keyword or a
    // named third-party service. Preserving/repairing an existing repo-proven
    // integration is filtered upstream via NEGATION_OR_PRESERVE.
    re: /\b(?:add|introduce|integrate|adopt|switch\s+to|migrate\s+to|connect|wire(?:\s+up)?|set\s+up|use|configure)\b[^.\n]{0,140}\b(?:new\s+(?:external\s+)?(?:provider|service|integration|api|third[-\s]?party)|sendgrid|twilio|sentry|intercom|slack|openai|anthropic|resend|postmark|mailgun|segment|amplitude|posthog|mixpanel|pusher|algolia|cloudinary)\b/gi,
  },
  {
    category: "disable_or_retire_existing",
    re: /\b(?:disable|retire|deprecate|remove|delete|drop|shut\s+down|turn\s+off|kill)\b[^.\n]{0,140}\b(?:edge\s+function|integration|feature|endpoint|cron|scheduled\s+job|table|bucket|policy|flywheel[-\s]?miner|instructor[-\s]?digest|alert[-\s]?scan|audit[-\s]?runner|batch[-\s]?compiler|boardroom[-\s]?orchestrator|key[-\s]?vault)\b/gi,
  },
  {
    // Destructive SQL: DROP TABLE/COLUMN/FUNCTION/VIEW/POLICY/TYPE/SCHEMA/INDEX/TRIGGER/DATABASE,
    // TRUNCATE, and DELETE FROM (including with WHERE). Fires regardless of
    // surrounding verb — the SQL IS the directive.
    category: "destructive_sql",
    re: /\b(?:DROP\s+(?:TABLE|COLUMN|FUNCTION|VIEW|MATERIALIZED\s+VIEW|POLICY|TYPE|SCHEMA|INDEX|TRIGGER|DATABASE)\b[^.\n;]{0,80}|TRUNCATE\s+(?:TABLE\s+)?[a-z_][a-z0-9_.]*|DELETE\s+FROM\s+[a-z_][a-z0-9_.]*(?:\s+WHERE\s[^;\n]{0,200})?)/gi,
  },
  {
    category: "custom_domain",
    re: /\b(?:add|purchase|buy|configure|verify|point|move\s+to|set\s+up)\b[^.\n]{0,60}\b(?:custom\s+domain|apex\s+domain|dns\s+record|cname\s+record|nameserver)\b/gi,
  },
  {
    category: "broaden_auth_or_bypass_rls",
    re: /\b(?:disable\s+row\s+level\s+security|disable\s+rls|bypass\s+rls|grant\s+(?:select|insert|update|delete|all|usage)\b[^.\n]{0,40}\bto\s+(?:anon|public)|GRANT\s+[^.\n]{0,40}\s+TO\s+public|allow\s+(?:anonymous|guest)\s+(?:writes?|inserts?|updates?|deletes?))\b/gi,
  },
  {
    category: "public_signups",
    re: /\b(?:enable|allow|permit|turn\s+on)\s+(?:anonymous|guest|public)\s+(?:sign[-\s]?up|sign[-\s]?in|access|writes?)\b/gi,
  },
];

const MARKER_RE =
  /\[OWNER-AUTHORIZED:\s*source\s*=\s*"([^"]+)"\s*quote\s*=\s*"([^"]+)"\s*\]/gi;

export type ProvenanceMarker = {
  source: string;
  quote: string;
  index: number;
  endIndex: number;
  line: number;
  ok: boolean;
  // categories this marker's quote is authorized to cover.
  categories: Set<UnauthorizedCategory>;
};

function classifyQuoteCategories(quote: string): Set<UnauthorizedCategory> {
  const nq = quote.toLowerCase();
  const out = new Set<UnauthorizedCategory>();
  for (const cat of Object.keys(CATEGORY_KEYWORDS) as UnauthorizedCategory[]) {
    const pats = CATEGORY_KEYWORDS[cat];
    // A quote authorizes a category iff at least one of the category's
    // keywords is present in the quote. Multi-pattern categories (e.g.
    // monetary_amount = digit + currency) require ALL patterns to match.
    if (cat === "monetary_amount") {
      if (pats.every((p) => p.test(nq))) out.add(cat);
    } else {
      if (pats.some((p) => p.test(nq))) out.add(cat);
    }
  }
  return out;
}

export function extractProvenanceMarkers(text: string, authority: OwnerAuthority): ProvenanceMarker[] {
  const out: ProvenanceMarker[] = [];
  if (!text) return out;
  const lineOfIdx = (i: number) => {
    let n = 0;
    for (let k = 0; k < i && k < text.length; k++) if (text.charCodeAt(k) === 10) n++;
    return n;
  };
  let m: RegExpExecArray | null;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text))) {
    const source = m[1];
    const quote = m[2];
    const nq = normalize(quote);
    const src = authority.perSourceNormalized.find((s) => s.source === source);
    const ok = !!nq && !!src && src.text.includes(nq);
    out.push({
      source,
      quote,
      index: m.index,
      endIndex: m.index + m[0].length,
      line: lineOfIdx(m.index),
      ok,
      categories: ok ? classifyQuoteCategories(quote) : new Set(),
    });
  }
  return out;
}

// Extract the salient "entity" tokens from a matched directive so that a
// marker quote authorizing e.g. `drop old_policy` cannot authorize
// `DROP TABLE projects`, a `$49` quote cannot authorize `$999/month`, and
// a Stripe quote cannot authorize PayPal. If a category has no meaningful
// entity to enforce (e.g. custom_domain / broaden_auth), returns []; the
// caller treats an empty result as "category-only match is sufficient".
export function extractDirectiveEntities(category: UnauthorizedCategory, snippet: string): string[] {
  const s = snippet.toLowerCase();
  const out: string[] = [];
  if (category === "monetary_amount") {
    // Capture the numeric amount (e.g. "$49", "$999.00", "eur 20") as digits.
    const m = s.match(/\d[\d,]*(?:\.\d+)?/);
    if (m) out.push(m[0].replace(/[,]/g, ""));
  } else if (category === "payment_provider_or_checkout") {
    const providers = ["stripe", "paddle", "paypal", "lemon squeezy", "lemonsqueezy", "shopify", "square", "braintree", "razorpay"];
    for (const p of providers) if (s.includes(p)) out.push(p);
  } else if (category === "new_external_integration") {
    const provs = ["sendgrid", "twilio", "sentry", "intercom", "slack", "openai", "anthropic", "resend", "postmark", "mailgun", "segment", "amplitude", "posthog", "mixpanel", "pusher", "algolia", "cloudinary"];
    for (const p of provs) if (s.includes(p)) out.push(p);
  } else if (category === "disable_or_retire_existing") {
    const named = s.match(/\b(flywheel[-\s]?miner|instructor[-\s]?digest|alert[-\s]?scan|audit[-\s]?runner|batch[-\s]?compiler|boardroom[-\s]?orchestrator|key[-\s]?vault)\b/g);
    if (named) out.push(...named.map((x) => x.replace(/\s+/g, "-")));
  } else if (category === "destructive_sql") {
    const m = s.match(/\b(?:DROP\s+(?:TABLE|COLUMN|FUNCTION|VIEW|MATERIALIZED\s+VIEW|POLICY|TYPE|SCHEMA|INDEX|TRIGGER|DATABASE)|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM)\s+([a-z_][a-z0-9_.]*)/i);
    if (m) out.push(m[1].toLowerCase().replace(/^public\./, ""));
  }
  return out;
}

// Return the sentence/clause (bounded by . ! ? ;) inside `ownLine` that
// contains position `matchOffset`.
function sentenceForMatch(ownLine: string, matchOffset: number): string {
  const parts: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < ownLine.length; i++) {
    const c = ownLine.charCodeAt(i);
    if (c === 46 || c === 33 || c === 63 || c === 59) {
      parts.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < ownLine.length) parts.push({ start, end: ownLine.length });
  for (const p of parts) {
    if (matchOffset >= p.start && matchOffset < p.end) return ownLine.slice(p.start, p.end);
  }
  return ownLine;
}

// Find spans in `text` that describe net-new / destructive high-impact
// directives which are NOT covered by a verified OWNER-AUTHORIZED marker on
// the same line or the immediately-following line, AND whose category is
// actually authorized by the marker's quote, AND whose salient entity/value
// (provider name, numeric amount, object name) actually overlaps the quote.
export function findUnauthorizedHighImpact(
  text: string,
  authority: OwnerAuthority,
): Unauthorized[] {
  const out: Unauthorized[] = [];
  if (!text) return out;
  const markers = extractProvenanceMarkers(text, authority);
  const lineStarts = buildLineIndex(text);

  for (const rule of HIGH_IMPACT) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const start = m.index;
      const line = findLineIndex(lineStarts, start);
      const lineStart = lineStarts[line];
      const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length;
      const ownLine = text.slice(lineStart, lineEnd);
      // Sentence-scope: negation/preservation only silences the individual
      // match if it occurs in the same sentence/clause as the match.
      const sentence = sentenceForMatch(ownLine, start - lineStart);
      if (NEGATION_OR_PRESERVE.test(sentence)) continue;
      if (rule.category === "monetary_amount" && /(?:\$|€|£|¥)\s*0(?![.,]?\d)/i.test(m[0])) continue;
      const directiveEntities = extractDirectiveEntities(rule.category, m[0]);
      // Marker coverage: same line or the immediately-following line, category
      // match, AND (when the directive has a salient entity) meaningful
      // overlap between that entity and the marker's quote.
      const covered = markers.some((mk) => {
        if (!mk.ok) return false;
        if (!(mk.line === line || mk.line === line + 1)) return false;
        if (!mk.categories.has(rule.category)) return false;
        if (!directiveEntities.length) return true;
        const nq = normalize(mk.quote);
        return directiveEntities.every((e) => nq.includes(e.toLowerCase()));
      });
      if (covered) continue;
      out.push({ category: rule.category, snippet: m[0].trim().slice(0, 200) });
    }
  }
  return dedupe(out);
}

function dedupe(items: Unauthorized[]): Unauthorized[] {
  const seen = new Set<string>();
  const out: Unauthorized[] = [];
  for (const it of items) {
    const key = `${it.category}::${normalize(it.snippet)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function buildLineIndex(text: string): number[] {
  const idx: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) idx.push(i + 1);
  return idx;
}

function findLineIndex(lineStarts: number[], pos: number): number {
  let lo = 0, hi = lineStarts.length - 1, line = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= pos) { line = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return line;
}

export function ownerAuthorityError(
  text: string,
  authority: OwnerAuthority,
): string | null {
  const issues = findUnauthorizedHighImpact(text, authority);
  if (!issues.length) return null;
  const shown = issues.slice(0, 8);
  const lines = shown.map((i) => `- [${i.category}] "${i.snippet}"`);
  const more = issues.length > shown.length ? `\n(+${issues.length - shown.length} more)` : "";
  return `OWNER AUTHORITY VIOLATION — high-impact directives without verified owner authorization. Each item below must either be removed, replaced with a repo-proven preservation/repair, or accompanied by a valid [OWNER-AUTHORIZED: source="..." quote="..."] marker whose quote appears verbatim in the cited owner source (intake, founder_notes, or an approved change_request) and whose text actually references the same category:\n${lines.join("\n")}${more}`;
}

// Pre-lock/pre-promotion validator. Callers pass a batch of executable
// artifacts (plan/prd/design content, batch prompt_md, features JSON …) and
// receive either null (all clear) or a single "proposal_requires_owner_approval"
// error listing each artifact's unauthorized directives. This function is
// intentionally free of Deno.serve / supabase client imports so it is unit
// testable and importable from both compiler and orchestrator.
export function preLockAuthorityError(
  artifacts: Array<{ label: string; text: string }>,
  authority: OwnerAuthority,
): string | null {
  const violations: string[] = [];
  for (const a of artifacts) {
    const t = String(a?.text ?? "");
    if (!t.trim()) continue;
    const issues = findUnauthorizedHighImpact(t, authority);
    if (!issues.length) continue;
    const shown = issues.slice(0, 5).map((i) => `  - [${i.category}] "${i.snippet}"`);
    violations.push(`* ${a.label}:\n${shown.join("\n")}${issues.length > 5 ? `\n  (+${issues.length - 5} more)` : ""}`);
  }
  if (!violations.length) return null;
  return `proposal_requires_owner_approval — the following executable artifacts contain high-impact directives without verified owner authorization and CANNOT be locked, queued, or promoted. Each item must be removed, replaced with a repo-proven preservation/repair, or accompanied by a valid [OWNER-AUTHORIZED: source="..." quote="..."] marker whose quote appears verbatim in intake, founder_notes, or an approved change_request AND whose text references the same category:\n${violations.join("\n")}`;
}
