// deno-lint-ignore-file no-explicit-any
// Shared audit-finding shape, normalization, dedupe, and validation.
// Used by audit-runner (seat prompts) and boardroom-orchestrator (merge +
// finalize). Any change to the schema or hard caps must land here so all
// stages agree.

export type Severity = "P0" | "P1" | "P2" | "P3";
export type Confidence = "high" | "medium" | "low";

export type RawFinding = {
  seat?: string | null;
  severity: string;
  file_path: unknown;
  title: unknown;
  description: unknown;
  evidence: unknown;
  confidence?: unknown;
  line_start?: unknown;
  line_end?: unknown;
};

export type CleanFinding = {
  seat: string | null;
  severity: Severity;
  file_path: string | null;
  title: string;
  description: string;
  evidence: string;
  confidence: Confidence;
  line_start: number | null;
  line_end: number | null;
};

// Hard per-finding caps (H1). Enforced by pre-cap and by validators before
// persistence. Keep in one place so seat-report caps and merge caps match.
export const CAPS = {
  seatFindingsMax: 12,
  seatSerializedMax: 8_000,
  // AUDIT-MERGE-BOUNDED-R3: Chair merge tightened from 30/18000 → 12/9000.
  // Live run ddf72827 truncated at 6485 tokens (of 6500) emitting the old
  // shape mid-field. Merge now targets a materially smaller schema so the
  // 6500-token budget has real headroom, and per-field caps prevent a
  // single verbose finding from blowing the total.
  mergeFindingsMax: 12,
  mergeSerializedMax: 9_000,
  titleMax: 160,
  descriptionMax: 900,
  // AUDIT-TRUTHFULNESS-DETERMINISTIC: raised only enough to fit compact
  // marker text (IMPACT / CURRENT / SCHEMA_LEDGER / CALLER); the 12/9000
  // merge caps and correction-pass caps are unchanged.
  evidenceMax: 640,
  mergePayloadMax: 80_000,
  mergeTitleMax: 120,
  mergeDescriptionMax: 320,
  mergeEvidenceMax: 280,
  mergeSummaryMax: 600,
  mergeCorrectionFindingsMax: 8,
  mergeCorrectionSerializedMax: 6_000,
  mergeCorrectionSummaryMax: 360,
  mergeCorrectionDescriptionMax: 240,
  mergeCorrectionEvidenceMax: 200,
  mapFindingsMax: 6,
  mapSerializedMax: 4_000,
  mapTitleMax: 120,
  mapDescriptionMax: 400,
  // Bounded map/correction evidence caps unchanged — markers (QUOTE/WHY +
  // IMPACT|CURRENT|SCHEMA_LEDGER|CALLER) are compact by design and fit.
  mapEvidenceMax: 240,
  correctionFindingsMax: 3,
  correctionSerializedMax: 3_000,
  correctionDescriptionMax: 240,
  correctionEvidenceMax: 160,
} as const;

export const FINDING_SCHEMA_DOC = `Each finding MUST be an object with EXACTLY these keys:
{
  "severity": "P0"|"P1"|"P2"|"P3",
  "file_path": "repo-relative path or empty string",
  "title": "<=160 chars, one short line",
  "description": "<=900 chars, one to two sentences: what is broken and why",
  "evidence": "<=500 chars. For P0/P1 the evidence string MUST include a verbatim short code/SQL/HTML quote from the cited file, in the exact marker form: 'QUOTE: <exact excerpt> | WHY: <one-sentence reason it proves the issue>'. A speculative risk, a filename alone, or a semantic paraphrase without a quote will be downgraded to P2.",
  "confidence": "high"|"medium"|"low",
  "line_start": integer > 0 or null,
  "line_end": integer > 0 (>= line_start) or null
}

Serious findings (P0/P1) require:
- a concrete repo-relative file_path (never empty, never a directory alone),
- a verbatim QUOTE: <excerpt> | WHY: <reason> pair in the evidence string,
- confidence "high" or "medium".

Cumulative-ledger rule (Postgres migrations, config, feature flags):
- SQL migrations are a cumulative ledger. An older migration is NOT proof of the current effective state. A P0/P1 based on a historical migration MUST be corroborated against later migrations, current grants, RLS policies, triggers, or current code — the QUOTE must come from the CURRENT effective definition, not a superseded one. Without that corroboration, downgrade to P2 or drop.

Client-side vs server-side authorization:
- A client-side route/UI role check is navigation UX, not the authorization boundary. Do NOT call it an exploit unless the underlying server (RLS policy, RPC, edge function, security-definer function) is concretely bypassable and you can QUOTE the vulnerable server-side construct.

Do NOT invent a security-contract requirement. In particular, storing a role column on profiles is not automatically unsafe when database triggers/policies prevent self-mutation; a separate user_roles table is one architecture, not a universal requirement.

Preserve SERVER_AUTH and OWNER_CONTRACT markers verbatim from seat findings within the evidence character cap — the shared validator uses them to keep client-surface security and product-strategy findings at P0/P1 severity. Never strip them during merge.

Cross-file composition is real evidence:
- Prompts, wrappers, and providers commonly compose across files. Before claiming "seats receive the identical prompt" or "no constitution is prepended", verify with a QUOTE from the actual wrapper (for example callSeat in supabase/functions/_shared/openrouter-proxy.ts prepends the constitution and each model_registry.role_prompt). Contradictory current source wins over any model claim of absence.

Do NOT label a Supabase anon/publishable key as a leaked secret. Only flag a secret when the code embeds or exports an actual unredacted private credential, service-role key, or high-entropy secret.`;

const SEV_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function asSeverity(v: unknown): Severity | null {
  return v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : null;
}
function asConfidence(v: unknown): Confidence | null {
  return v === "high" || v === "medium" || v === "low" ? v : null;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}
function asIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Coerce anything model-ish into the schema. Never throws — drops entries
// that cannot be normalized (missing title/severity).
export function normalizeFindings(raw: any[], seatFallback: string | null = null): CleanFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: CleanFinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const sev = asSeverity((r as any).severity);
    const title = truncate(asStr((r as any).title), CAPS.titleMax);
    if (!sev || !title) continue;
    const conf = asConfidence((r as any).confidence) ?? "medium";
    const fp = asStr((r as any).file_path).trim();
    const ls = asIntOrNull((r as any).line_start);
    let le = asIntOrNull((r as any).line_end);
    if (ls !== null && le !== null && le < ls) le = ls;
    out.push({
      seat: typeof (r as any).seat === "string" ? (r as any).seat : seatFallback,
      severity: sev,
      file_path: fp || null,
      title,
      description: truncate(asStr((r as any).description), CAPS.descriptionMax),
      evidence: truncate(asStr((r as any).evidence), CAPS.evidenceMax),
      confidence: conf,
      line_start: ls,
      line_end: le,
    });
  }
  return out;
}

// Pre-cap a seat report before shipping to the Chair merge: enforce max
// count and per-string caps. Titles/descriptions/evidence are already
// truncated in normalizeFindings. This orders findings by severity so if
// we clip, we clip low-severity nits first.
export function preCapSeat(findings: CleanFinding[]): CleanFinding[] {
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity],
  );
  return sorted.slice(0, CAPS.seatFindingsMax);
}

// Dedupe by normalized (file_path||"") + normalized title root. Keeps the
// strongest (lowest severity number, then highest confidence) instance and
// merges evidence when the loser has extra concrete text.
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function normPath(s: string | null): string {
  return (s ?? "").toLowerCase().replace(/^\/+/, "").trim();
}
const CONF_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export function dedupeFindings(findings: CleanFinding[]): CleanFinding[] {
  const bucket = new Map<string, CleanFinding>();
  for (const f of findings) {
    const key = `${normPath(f.file_path)}|${normTitle(f.title)}`;
    const prev = bucket.get(key);
    if (!prev) {
      bucket.set(key, { ...f });
      continue;
    }
    const winnerIsPrev =
      SEV_ORDER[prev.severity] < SEV_ORDER[f.severity] ||
      (SEV_ORDER[prev.severity] === SEV_ORDER[f.severity] &&
        CONF_ORDER[prev.confidence] <= CONF_ORDER[f.confidence]);
    const winner = winnerIsPrev ? prev : f;
    const loser = winnerIsPrev ? f : prev;
    // Prefer the winner's evidence; fall back to loser's when winner has none.
    const evidence = winner.evidence || loser.evidence;
    bucket.set(key, { ...winner, evidence });
  }
  return [...bucket.values()];
}

// Downgrade unsupported serious findings. Returns the downgraded findings
// plus a reason ledger for audits.summary.validation_downgrades.
export type DowngradeDisposition = "rescored" | "rejected_unsupported";
export type DowngradeRecord = {
  title: string;
  file_path: string | null;
  from: Severity;
  to: Severity;
  reason: string;
  // AUDIT-PUBLISH-TRUST-R4: "rescored" = finding is still published at the
  // reduced severity; "rejected_unsupported" = the finding failed a
  // deterministic factual-proof gate and is OMITTED from published findings
  // (kept in this ledger only for observability). Counts, verdict, and
  // fix_batch generation are based only on published findings.
  disposition: DowngradeDisposition;
  published: boolean;
};

// A supported P0/P1 needs (a) a concrete repo-relative file_path — non-empty,
// not just a bare directory, (b) evidence at least 20 chars long that names
// something concrete, (c) medium/high confidence.
function isConcretePath(fp: string | null): boolean {
  if (!fp) return false;
  const t = fp.trim();
  if (!t) return false;
  if (t.endsWith("/")) return false;
  // A path with no separators AND no dot (bare word) is not concrete.
  if (!/[\/\.]/.test(t)) return false;
  return true;
}

const WEAK_EVIDENCE = [
  /^this file exists\b/i,
  /^may be\b/i,
  /^could be\b/i,
  /^likely\b/i,
  /^suspected\b/i,
  /^potentially\b/i,
];

function isConcreteEvidence(ev: string): boolean {
  const t = ev.trim();
  if (t.length < 20) return false;
  if (WEAK_EVIDENCE.some((rx) => rx.test(t))) return false;
  return true;
}

// P0/P1 evidence must include the deterministic "QUOTE: <excerpt> | WHY:
// <reason>" marker introduced by the audit-truthfulness pass. Semantic
// paraphrases without a verbatim quote are always downgraded to P2.
export function hasQuoteWhyMarker(ev: string): boolean {
  const t = String(ev ?? "");
  if (!/\bQUOTE:\s*\S/.test(t)) return false;
  if (!/\bWHY:\s*\S/.test(t)) return false;
  return true;
}

// ============================== Deterministic markers ==============================
// AUDIT-TRUTHFULNESS-DETERMINISTIC — teach the evaluator (not just prompts)
// to recognize the compact evidence markers that gate serious severity.
//
//   IMPACT: build_failure|data_loss|auth_bypass|secret_exposure
//     A P0 without a valid IMPACT class is downgraded P0 → P1.
//   CURRENT: <quoted current effective definition>
//     A P0/P1 whose file_path lives under supabase/migrations/* must corroborate
//     that the quoted line still represents the CURRENT effective state; missing
//     marker deterministically downgrades to P2.
//   SCHEMA_LEDGER: / RUNTIME_FAILURE:
//     A "does not exist" claim about a table/column/function may only be P0/P1
//     when corroborated by an explicit current schema-ledger inventory or a
//     concrete runtime failure; else P2.
//   CALLER: <caller QUOTE from reachable code>
//     A universal-helper claim ("all seats use", "every request goes through")
//     requires a caller corroboration marker; else P2.

const P0_IMPACT_CLASSES = ["build_failure", "data_loss", "auth_bypass", "secret_exposure"] as const;

export function hasImpactMarker(ev: string): boolean {
  const rx = new RegExp(`\\bIMPACT:\\s*(?:${P0_IMPACT_CLASSES.join("|")})\\b`, "i");
  return rx.test(String(ev ?? ""));
}
export function hasCurrentMarker(ev: string): boolean { return /\bCURRENT:\s*\S/.test(String(ev ?? "")); }
export function hasSchemaLedgerMarker(ev: string): boolean { return /\bSCHEMA_LEDGER:\s*\S/.test(String(ev ?? "")); }
export function hasRuntimeFailureMarker(ev: string): boolean { return /\bRUNTIME_FAILURE:\s*\S/.test(String(ev ?? "")); }
export function hasCallerMarker(ev: string): boolean { return /\bCALLER:\s*\S/.test(String(ev ?? "")); }

// R3 — client-surface security claim corroboration marker.
// A P0/P1 that alleges an auth/admin/RLS/privilege bypass from a frontend
// (src/*) file MUST include a compact SERVER_AUTH quote of the current
// vulnerable server-side boundary (RLS policy, RPC, edge function,
// security-definer function). Without it the claim is a UI-only observation
// and is deterministically downgraded to P2.
export function hasServerAuthMarker(ev: string): boolean { return /\bSERVER_AUTH:\s*\S/.test(String(ev ?? "")); }

// R3 — product-strategy / copy claim corroboration marker.
// Copy, positioning, acquisition, pricing/monetization, onboarding activation,
// or buyer-reach findings cannot be P0/P1 unless the evidence quotes a verbatim
// OWNER_CONTRACT (owner intake / founder note / locked-PRD requirement) OR a
// RUNTIME_FAILURE for a truly broken flow.
export function hasOwnerContractMarker(ev: string): boolean { return /\bOWNER_CONTRACT:\s*\S/.test(String(ev ?? "")); }

export function isMigrationPath(fp: string | null): boolean {
  const t = String(fp ?? "").trim().toLowerCase().replace(/^\.?\/+/, "");
  return t.startsWith("supabase/migrations/");
}

export function isFrontendPath(fp: string | null): boolean {
  const t = String(fp ?? "").trim().toLowerCase().replace(/^\.?\/+/, "");
  return t.startsWith("src/");
}

const MISSING_OBJECT_RX_A =
  /\b(does\s+not\s+exist|no\s+such|missing|undefined|non[- ]?existent|unknown)\b[^.\n]{0,80}\b(table|column|function|policy|view|index|rpc)\b/i;
const MISSING_OBJECT_RX_B =
  /\b(table|column|function|policy|view|index|rpc)\b[^.\n]{0,80}\b(does\s+not\s+exist|is\s+missing|not\s+found|no\s+such)\b/i;
export function looksLikeMissingObjectClaim(title: string, description: string): boolean {
  const t = `${title}\n${description}`;
  return MISSING_OBJECT_RX_A.test(t) || MISSING_OBJECT_RX_B.test(t);
}

const UNIVERSAL_HELPER_RX =
  /\b(all|every|universally|globally|always|each)\b[^.\n]{0,80}\b(seat|caller|call ?site|route|request|function|batch|module|component|invocation|human batch)s?\b/i;
// R3 — extended universal-helper detection. Live regression: an audit finding
// titled "Human channel batches incorrectly require typecheck footer" with
// description "footer check is outside isCodeChannel, applying to human
// batches" is universal-scope reasoning about every human batch reaching the
// footer check. Match it without requiring an "all/every" quantifier so the
// CALLER-marker gate applies deterministically.
const UNIVERSAL_HELPER_RX_R3 =
  /\b(human\s+(?:channel\s+)?batches|non[- ]code\s+batches|human\s+channel|isCodeChannel|footer\s+check|typecheck\s+footer)\b/i;
export function looksLikeUniversalHelperClaim(title: string, description: string): boolean {
  const t = `${title}\n${description}`;
  return UNIVERSAL_HELPER_RX.test(t) || UNIVERSAL_HELPER_RX_R3.test(t);
}

// R3/R7 — client-surface security claim detector. Fires when the file_path
// is a frontend src/* file AND the title/description alleges any of:
//  - authorization / privilege / direct-SELECT bypass (original R3 scope)
//  - browser code READS a sensitive / privileged / server-side field
//    (e.g. run_steps.response_text, api_keys.encrypted_key)
//  - browser code WRITES privileged lifecycle state (spend caps, cohort
//    membership, audit finding lifecycle, project status)
//  - a check/gate/enforcement described as UI-only / client-only / "only
//    enforced in the UI" — trivially bypassable if unbacked by server auth
// Any such finding requires a concrete SERVER_AUTH quote of the current
// vulnerable server-side boundary (RLS policy, RPC, edge function,
// security-definer function). Missing → deterministic REJECTION at any
// severity (Rule 4b in downgradeUnsupported).
const CLIENT_SURFACE_CONCERN_RX =
  /\b(auth\s+bypass|admin\s+bypass|rls\s+bypass|privilege\s+escalation|unauthori[sz]ed\s+(?:access|read|write|query|select|mutation|update)|direct\s+select|direct\s+query|bypass(?:es|ed)?\s+(?:rls|auth|policy|policies|security)|admin\s+(?:only\s+)?(?:page|route|debug|panel|dashboard)|client(?:[- ]side)?\s+(?:only|check|enforcement|writes?|reads?|updates?|mutation)|(?:only|solely)\s+enforced\s+(?:in|on|by)\s+(?:the\s+)?(?:ui|client|browser|frontend)|enforced\s+only\s+(?:in|on|by)\s+(?:the\s+)?(?:ui|client|browser|frontend)|ui[- ]only\s+(?:check|guard|gate|enforcement|validation)|browser\s+(?:can\s+)?(?:reads?|selects?|writes?|mutates?|updates?)|reads?\s+(?:sensitive|privileged|server|backend|response_text|response_json|encrypted_key|api_keys?)|writes?\s+(?:privileged|server|backend|spend|cap|cohort|finding|severity|dismissal))\b/i;
// R8 — client code writing privileged / global / config / registry / admin
// / lifecycle / security state. Fires on titles/evidence that combine a
// write/mutate/update verb (singular OR plural, active OR passive, verb OR
// noun form) with a privileged-domain noun (privileged config, global
// config, model_registry, app_settings, constitution, spend/budget cap,
// admin state, lifecycle state, security state), or that explicitly attribute
// the write to a browser / client / "browser path" / "direct client" origin
// while touching such state. Ordinary user-owned form saving (profile,
// preferences, notes) does NOT match — it lacks the privileged-domain noun.
const CLIENT_PRIVILEGED_WRITE_RX =
  /\b(?:privileged\s+(?:config|configuration|state|settings?|registry|data|lifecycle|security|admin)|global\s+(?:board\s+)?(?:config|configuration|settings?|state|registry|board)|model[_\- ]?registry|app[_\- ]?settings|constitution|(?:spend|budget)\s+cap|admin[_\- ]?only\s+(?:config|configuration|setting|settings|registry|state|lifecycle)|direct\s+(?:browser|client)(?:[- ]side)?(?:\s+\w+){0,3}\s+(?:writes?|written|writing|updates?|updated|updating|reads?|mutat(?:e|es|ed|ing|ion|ions))|(?:writes?|written|writing|updates?|updated|updating|mutat(?:e|es|ed|ing|ion|ions))\s+(?:via|from|through|by)\s+(?:the\s+)?(?:direct\s+)?(?:browser|client)|browser(?:\s+\w+){0,3}\s+(?:writes?|written|writing|mutat(?:e|es|ed|ing|ion|ions))|from\s+(?:the\s+)?browser\s+path|browser\s+path\b|(?:config|configuration|registry|constitution|lifecycle\s+state|privileged\s+state|global\s+state|global\s+config|global\s+configuration)\s+(?:mutat(?:e|es|ed|ing|ion|ions)|updated?|written|writing|changed?|modified?|edited?)|client(?:[- ]side)?\s+(?:code\s+)?(?:can\s+)?(?:change|modify|edit|update|write|mutat\w+)s?\s+(?:global|privileged|admin|config|configuration|lifecycle|security|registry|constitution|model[_\- ]?registry|app[_\- ]?settings))\b/i;
export function looksLikeClientSurfaceSecurityClaim(
  title: string,
  description: string,
  filePath: string | null,
): boolean {
  if (!isFrontendPath(filePath)) return false;
  const t = `${title}\n${description}`;
  return CLIENT_SURFACE_CONCERN_RX.test(t) || CLIENT_PRIVILEGED_WRITE_RX.test(t);
}

// R3 — product-strategy / copy claim detector. Covers copy, positioning,
// acquisition, pricing/monetization, onboarding activation, and buyer-reach
// concerns. These are legitimate product-quality findings but must not carry
// P0/P1 severity without an OWNER_CONTRACT (verbatim owner/PRD requirement)
// or a RUNTIME_FAILURE marker.
//
// R6 — deterministic path exclusion. The default-P2 rule targets real
// product recommendations, NOT backend security/authority/parser/
// orchestration code that merely mentions buyer/payment/price-like words in
// its evidence. Any finding whose file_path lives under a backend infra
// path (supabase/functions/**, supabase/migrations/**, supabase/tests/**) is
// excluded from product-strategy classification and follows the normal
// severity gates instead.
const PRODUCT_STRATEGY_RX =
  /\b(copy|wording|tone|positioning|value\s+prop(?:osition)?|acquisition|pricing|price\s+anchor|monetiz(?:e|ation|ing)|paid\s+offer|upgrade\s+trigger|onboarding|activation|first[- ]?90|wow\s+moment|buyer|hero\s+section|landing\s+(?:page|copy|hero)|CTA|call[- ]to[- ]action|cohort[- ]first|marketing)\b/i;
export function isBackendInfraPath(fp: string | null): boolean {
  const t = String(fp ?? "").trim().toLowerCase().replace(/^\.?\/+/, "");
  if (!t) return false;
  return t.startsWith("supabase/functions/")
    || t.startsWith("supabase/migrations/")
    || t.startsWith("supabase/tests/");
}
export function looksLikeProductStrategyClaim(
  title: string,
  description: string,
  filePath?: string | null,
): boolean {
  if (filePath !== undefined && isBackendInfraPath(filePath)) return false;
  const t = `${title}\n${description}`;
  return PRODUCT_STRATEGY_RX.test(t);
}

// Speculation guard: WHY clauses that lean on hedges ("appears", "may",
// "could", "likely", "seems") never rise past P2 for P0/P1 severity, even
// with an IMPACT marker attached. Keeps deterministic downgrades resistant
// to hallucinated concerns dressed up as concrete quotes.
const SPECULATION_WHY_RX = /\bWHY:\s*[^|\n]{0,200}?\b(appears?|may|might|could|likely|seems?|probably|possibly|perhaps|suspected|potentially)\b/i;
export function whyIsSpeculative(evidence: string): boolean {
  return SPECULATION_WHY_RX.test(String(evidence ?? ""));
}

// R4 — FULL_SOURCE marker for claims that assert a file is "truncated",
// "incomplete", "missing X", or otherwise malformed. Fragment boundaries in
// map/extract inputs regularly show a file mid-token; a P0/P1 claiming
// truncation requires a compact FULL_SOURCE quote of the complete original
// span, or a RUNTIME_FAILURE marker for a real crash. Missing → rejected.
export function hasFullSourceMarker(ev: string): boolean {
  return /\bFULL_SOURCE:\s*\S/.test(String(ev ?? ""));
}
const TRUNCATION_CLAIM_RX =
  /\b(truncat(?:ed|ion)|incomplete|cut[- ]off|malformed|mid[- ](?:token|statement|expression|comment)|missing\s+closing|unterminated|syntactically\s+broken)\b/i;
export function looksLikeTruncationClaim(title: string, description: string): boolean {
  const t = `${title}\n${description}`;
  return TRUNCATION_CLAIM_RX.test(t);
}

export function downgradeUnsupported(
  findings: CleanFinding[],
): { findings: CleanFinding[]; downgrades: DowngradeRecord[]; rejectedIndices: Set<number> } {
  const downgrades: DowngradeRecord[] = [];
  const rejectedIndices = new Set<number>();
  const out = findings.map((f, i) => {
    let sev: Severity = f.severity;
    const push = (
      from: Severity,
      to: Severity,
      reason: string,
      disposition: DowngradeDisposition = "rescored",
    ) => {
      const rejected = disposition === "rejected_unsupported";
      downgrades.push({
        title: f.title,
        file_path: f.file_path,
        from,
        to,
        reason,
        disposition,
        published: !rejected,
      });
      if (rejected) rejectedIndices.add(i);
    };

    // Rule 1 (P0 only, rescored): missing IMPACT marker → P0 becomes P1.
    if (sev === "P0" && !hasImpactMarker(f.evidence)) {
      push("P0", "P1", "P0 evidence missing IMPACT: build_failure|data_loss|auth_bypass|secret_exposure marker");
      sev = "P1";
    }

    // R6 — Rules 2/3/4/4b/4d are SEVERITY-AGNOSTIC factual-proof gates. A
    // P2/P3 finding that alleges a migration gap, missing schema object,
    // universal-helper reachability, client-surface security bypass, or a
    // truncated source is just as unsupported at P2 as it was at P1: false
    // P2 is still bad advice. When the required proof marker is absent, the
    // finding is REJECTED regardless of incoming severity.

    // Rule 2: supabase/migrations/* requires CURRENT (any severity).
    if (isMigrationPath(f.file_path) && !hasCurrentMarker(f.evidence)) {
      // Cap severity to P2 on rejection so any published-array leak still
      // reflects the demotion; the entry is filtered out by rejectedIndices.
      const to: Severity = SEV_ORDER[sev] < SEV_ORDER["P2"] ? "P2" : sev;
      push(sev, to, "migrations/* claim missing CURRENT: corroboration of effective state", "rejected_unsupported");
      return { ...f, severity: to };
    }

    // Rule 3: missing-object claim requires SCHEMA_LEDGER or RUNTIME_FAILURE.
    if (looksLikeMissingObjectClaim(f.title, f.description)
        && !hasSchemaLedgerMarker(f.evidence)
        && !hasRuntimeFailureMarker(f.evidence)) {
      const to: Severity = SEV_ORDER[sev] < SEV_ORDER["P2"] ? "P2" : sev;
      push(sev, to, "missing-object claim lacks SCHEMA_LEDGER: or RUNTIME_FAILURE: corroboration", "rejected_unsupported");
      return { ...f, severity: to };
    }

    // Rule 4: universal-helper claim requires CALLER corroboration.
    if (looksLikeUniversalHelperClaim(f.title, f.description)
        && !hasCallerMarker(f.evidence)) {
      const to: Severity = SEV_ORDER[sev] < SEV_ORDER["P2"] ? "P2" : sev;
      push(sev, to, "universal-helper claim lacks CALLER: corroboration from a reachable caller", "rejected_unsupported");
      return { ...f, severity: to };
    }

    // Rule 4b: client-surface security claim (frontend src/* alleging
    // auth/admin/RLS/privilege/direct-SELECT bypass) requires SERVER_AUTH.
    if (looksLikeClientSurfaceSecurityClaim(f.title, f.description, f.file_path)
        && !hasServerAuthMarker(f.evidence)) {
      const to: Severity = SEV_ORDER[sev] < SEV_ORDER["P2"] ? "P2" : sev;
      push(sev, to, "client-surface security claim lacks SERVER_AUTH: quote of the current vulnerable server construct", "rejected_unsupported");
      return { ...f, severity: to };
    }

    // Rule 4d: truncation / "file is malformed / cut off" claim requires
    // FULL_SOURCE (or RUNTIME_FAILURE).
    if (looksLikeTruncationClaim(f.title, f.description)
        && !hasFullSourceMarker(f.evidence)
        && !hasRuntimeFailureMarker(f.evidence)) {
      const to: Severity = SEV_ORDER[sev] < SEV_ORDER["P2"] ? "P2" : sev;
      push(sev, to, "truncation/incomplete-source claim lacks FULL_SOURCE: or RUNTIME_FAILURE: corroboration", "rejected_unsupported");
      return { ...f, severity: to };
    }

    // Rule 4c (severity-cap only): product-strategy / copy / positioning /
    // pricing / onboarding / buyer-reach findings are P2 by default. R6:
    // path exclusion — backend infra paths are NEVER classified here. Per
    // the constitution, EITHER an OWNER_CONTRACT marker (verbatim owner
    // intake / founder note / locked-PRD requirement) OR a RUNTIME_FAILURE
    // marker preserves P0/P1. Only when BOTH are absent do we cap to P2.
    if ((sev === "P0" || sev === "P1")
        && looksLikeProductStrategyClaim(f.title, f.description, f.file_path)
        && !hasRuntimeFailureMarker(f.evidence)
        && !hasOwnerContractMarker(f.evidence)) {
      push(sev, "P2", "product-strategy/copy claim lacks OWNER_CONTRACT: or RUNTIME_FAILURE: corroboration");
      return { ...f, severity: "P2" as Severity };
    }

    // Rule 5: speculative WHY hedge — reject at P0/P1.
    if ((sev === "P0" || sev === "P1") && whyIsSpeculative(f.evidence)) {
      push(sev, "P2", "WHY: uses speculative hedge ('appears/may/could/likely/seems')", "rejected_unsupported");
      return { ...f, severity: "P2" as Severity };
    }

    // Baseline QUOTE/WHY + concrete-path/evidence/confidence gate (P0/P1).
    // Legitimate product/design/copy P2s still publish — this gate only
    // applies to serious severities.
    if (sev === "P0" || sev === "P1") {
      const reasons: string[] = [];
      if (!isConcretePath(f.file_path)) reasons.push("missing concrete file_path");
      if (!isConcreteEvidence(f.evidence)) reasons.push("evidence lacks concrete detail");
      if (!hasQuoteWhyMarker(f.evidence)) reasons.push("evidence missing QUOTE:/WHY: marker");
      if (f.confidence === "low") reasons.push("confidence low");
      if (reasons.length > 0) {
        push(sev, "P2", reasons.join("; "), "rejected_unsupported");
        return { ...f, severity: "P2" as Severity };
      }
    }
    return sev === f.severity ? f : { ...f, severity: sev };
  });
  return { findings: out, downgrades, rejectedIndices };
}

// Strict validator. Returns null on OK, or a short message describing the
// first violation. Enforces per-finding shape, counts, and payload size.
// AUDIT-MERGE-BOUNDED-R3: uses merge-specific per-field caps (tighter than
// the global CAPS.titleMax/etc used during normalization) and optionally
// validates the merge summary length.
export function validateMerged(
  findings: CleanFinding[],
  summary?: string | null,
): string | null {
  if (findings.length > CAPS.mergeFindingsMax) {
    return `merged findings has ${findings.length} entries — max ${CAPS.mergeFindingsMax}. Dedupe and drop lowest-severity duplicates.`;
  }
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (!asSeverity(f.severity)) return `findings[${i}].severity invalid`;
    if (!asConfidence(f.confidence)) return `findings[${i}].confidence invalid`;
    if (typeof f.title !== "string" || !f.title.trim()) return `findings[${i}].title missing`;
    if (typeof f.description !== "string") return `findings[${i}].description must be a string`;
    if (typeof f.evidence !== "string") return `findings[${i}].evidence must be a string`;
    if (f.title.length > CAPS.mergeTitleMax) return `findings[${i}].title over ${CAPS.mergeTitleMax}`;
    if (f.description.length > CAPS.mergeDescriptionMax) return `findings[${i}].description over ${CAPS.mergeDescriptionMax}`;
    if (f.evidence.length > CAPS.mergeEvidenceMax) return `findings[${i}].evidence over ${CAPS.mergeEvidenceMax}`;
    if (f.line_start !== null && !(Number.isInteger(f.line_start) && f.line_start > 0)) {
      return `findings[${i}].line_start invalid`;
    }
    if (f.line_end !== null && !(Number.isInteger(f.line_end) && f.line_end > 0)) {
      return `findings[${i}].line_end invalid`;
    }
    if (f.line_start !== null && f.line_end !== null && f.line_end < f.line_start) {
      return `findings[${i}].line_end must be >= line_start`;
    }
  }
  const payloadLen = JSON.stringify(findings).length;
  if (payloadLen > CAPS.mergeSerializedMax) {
    return `serialized merged findings is ${payloadLen} chars — exceeds ${CAPS.mergeSerializedMax}. Compress evidence.`;
  }
  if (typeof summary === "string" && summary.length > CAPS.mergeSummaryMax) {
    return `summary is ${summary.length} chars — exceeds ${CAPS.mergeSummaryMax}.`;
  }
  return null;
}

// Shared merge-candidate evaluator used by BOTH validateStepJson (before the
// step is marked completed, so a merge-cap violation triggers the existing
// single correction pass) and finalizeAudit (defense in depth). Runs the
// full pipeline: normalize → dedupe → downgrade unsupported P0/P1 → strict
// validateMerged. Never truncates or synthesizes; a cap violation surfaces
// as an error string exactly like the seat-report path.
export type ChairMergeEvaluation = {
  error: string | null;
  findings: CleanFinding[];
  downgrades: DowngradeRecord[];
  summary: string;
  verdict: "clean" | "findings";
};

export function evaluateChairMergeCandidate(parsed: unknown): ChairMergeEvaluation {
  const obj = (parsed && typeof parsed === "object") ? (parsed as any) : {};
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const normalized = normalizeFindings(rawFindings);
  const deduped = dedupeFindings(normalized);
  const { findings: downgraded, downgrades, rejectedIndices } = downgradeUnsupported(deduped);
  // AUDIT-PUBLISH-TRUST-R4: omit findings whose downgrade disposition marks
  // them as factually unsupported. The full ledger (rescored + rejected)
  // remains on the audit summary for observability, but counts/verdict/
  // fix_prompt are based only on the published (kept) findings.
  const published = downgraded.filter((_, i) => !rejectedIndices.has(i));
  const error = validateMerged(published, summary);
  const verdictClaim = obj.verdict === "clean" ? "clean" : "findings";
  const verdict: "clean" | "findings" =
    verdictClaim === "clean" || published.length === 0 ? "clean" : "findings";
  return { error, findings: published, downgrades, summary, verdict };
}

// AUDIT-SUMMARY-DETERMINISTIC — the persisted summary.text MUST be built
// deterministically from the validated post-downgrade / post-rejection
// counts. We NEVER preserve model-authored prose in summary.text, even
// when its severity/count claims happen to match the counts: the risk of
// leaking a rejected finding title, a bogus "critical" adjective, or a
// stale count-word into published summaries is not worth the marginal
// narrative value. validation_downgrades (a separate structured field)
// stays as it was.
//
// Callers still pass the raw text (and any rejected titles) so the shape
// of the function is backwards compatible, but both inputs are ignored.
export type AuditCounts = { P0: number; P1: number; P2: number; P3: number };
export function reconcileAuditSummaryText(
  _rawText: string,
  counts: AuditCounts,
  _rejectedTitles: string[] = [],
): string {
  const countsSentence =
    `Validated counts: P0=${counts.P0}, P1=${counts.P1}, P2=${counts.P2}, P3=${counts.P3}.`;
  return countsSentence.slice(0, CAPS.mergeSummaryMax);
}


export function validateSeatReport(findings: CleanFinding[]): string | null {
  if (findings.length > CAPS.seatFindingsMax) {
    return `seat findings has ${findings.length} entries — max ${CAPS.seatFindingsMax}.`;
  }
  const payloadLen = JSON.stringify(findings).length;
  if (payloadLen > CAPS.seatSerializedMax) {
    return `serialized seat findings is ${payloadLen} chars — exceeds ${CAPS.seatSerializedMax}.`;
  }
  return null;
}


// Build the compact merge input: seat reports collapsed to normalized
// finding objects only, with a deterministic overall payload cap. Strips
// prose, prompts, raw repo. Returns the input block + the parsed seat
// findings for later reuse.
export function buildMergeInput(
  seatReports: Array<{ step_key: string; seat: string; findings: CleanFinding[] }>,
): { block: string; totalFindings: number } {
  const parts: string[] = [];
  for (const r of seatReports) {
    const capped = preCapSeat(r.findings);
    parts.push(
      `--- ${r.step_key.toUpperCase()} (${capped.length} findings) ---\n` +
        JSON.stringify(capped, null, 0),
    );
  }
  let block = parts.join("\n\n");
  if (block.length > CAPS.mergePayloadMax) {
    // Deterministic trim: drop lowest-severity items until under cap.
    const flat = seatReports
      .flatMap((r) => preCapSeat(r.findings).map((f) => ({ ...f, seat: r.step_key })))
      .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    while (flat.length && JSON.stringify(flat).length > CAPS.mergePayloadMax) {
      flat.pop();
    }
    block = `--- COMPACTED (${flat.length} findings across all seats) ---\n` + JSON.stringify(flat, null, 0);
  }
  const totalFindings = seatReports.reduce((s, r) => s + preCapSeat(r.findings).length, 0);
  return { block, totalFindings };
}


// ============================== Map-seat schema doc ==============================
// Narrower than FINDING_SCHEMA_DOC — every per-chunk map/extract call uses
// this to stay well inside the 4000-token map budget.
export const MAP_FINDING_SCHEMA_DOC = `Each finding MUST be an object with EXACTLY these keys:
{
  "severity": "P0"|"P1"|"P2"|"P3",
  "file_path": "repo-relative path (never a fragment label like 'fragment 3 of 5')",
  "title": "<=${CAPS.mapTitleMax} chars, one short line",
  "description": "<=${CAPS.mapDescriptionMax} chars, one to two sentences: what is broken and why",
  "evidence": "<=${CAPS.mapEvidenceMax} chars. For P0/P1 the evidence MUST use the marker form: 'QUOTE: <exact short excerpt from the file> | WHY: <one sentence reason it proves the issue>'. A filename alone, a speculative risk, or a semantic paraphrase without the QUOTE/WHY markers will be downgraded to P2 by the shared validator.",
  "confidence": "high"|"medium"|"low",
  "line_start": integer > 0 or null,
  "line_end": integer > 0 (>= line_start) or null
}

Serious findings (P0/P1) require:
- a concrete repo-relative file_path,
- a verbatim QUOTE: <excerpt> | WHY: <reason> pair in the evidence,
- confidence "high" or "medium".

P0 requires an IMPACT class marker inside the evidence:
  'IMPACT: build_failure' or 'IMPACT: data_loss' or 'IMPACT: auth_bypass' or 'IMPACT: secret_exposure'.
Any P0 without a valid IMPACT is deterministically downgraded to P1.

Migration-file rule (hard): if file_path is under supabase/migrations/*, a P0/P1 MUST include a
compact 'CURRENT: <quoted current effective definition>' marker corroborating that the quoted line
still represents the effective state (later migration, current schema, current grant/policy/trigger).
Missing CURRENT → downgraded to P2.

Missing-object claim rule: any claim of the form "table/column/function/policy X does not exist"
requires either 'SCHEMA_LEDGER: <inventory line proving absence>' or 'RUNTIME_FAILURE: <error>' in
the evidence. Partial-chunk absence is NOT proof. Missing marker → downgraded to P2.

Universal-helper claim rule: any claim that a helper/validator/middleware "applies to all X" or
"every call goes through Y" requires 'CALLER: <quote from a reachable current caller>'. Missing
marker → downgraded to P2.

Client-surface security claim rule (frontend src/*): any P0/P1 that alleges an auth/admin/RLS/privilege/
unauthorized/direct-SELECT bypass and cites a src/* frontend file MUST include a compact
'SERVER_AUTH: <quote of the current vulnerable server RLS/RPC/edge/security-definer construct>' marker.
UI-only observation without SERVER_AUTH is downgraded to P2.

Product-strategy/copy claim rule: findings about copy, positioning, acquisition, pricing/monetization,
onboarding activation, or buyer-reach cannot be P0/P1 without either 'OWNER_CONTRACT: <verbatim owner
intake / founder note / locked-PRD requirement>' or 'RUNTIME_FAILURE: <error>'. Without one, they are
downgraded to P2 (still visible as product-quality findings).

Cumulative-ledger rule: SQL migrations are a cumulative ledger. An older migration is NOT proof of the current effective state. Corroborate any P0/P1 based on a migration against later migrations / current grants / current RLS policies / current triggers / current code — the QUOTE must come from the CURRENT effective definition, not a superseded one. Otherwise downgrade to P2 or drop.

Client-side vs server-side authorization: a client-side route/UI role check is navigation UX, not the authorization boundary. Do NOT flag it as an exploit unless the underlying server (RLS / RPC / edge function / security-definer) is concretely bypassable and you can QUOTE the vulnerable server construct.

Cross-file composition: prompts, wrappers, and providers compose across files. Do NOT claim "seats share the same prompt" or "no constitution is prepended" without a QUOTE from the actual wrapper — the current source (e.g. callSeat in supabase/functions/_shared/openrouter-proxy.ts prepends the constitution and each model_registry.role_prompt) wins over any model claim of absence.

Fragment-boundary rule (hard):
- The CODE section may show one or more files split across labelled fragments ("fragment N of M"). A non-first fragment MAY begin mid-token, mid-statement, or mid-comment; a non-final fragment MAY end mid-token. Never report a file as truncated, malformed, or syntactically broken based ONLY on a fragment boundary. Report syntax truncation only when the FULL file boundary is present or you have concrete full-file evidence.
- Always cite the original repo-relative file_path in "file_path" — never the fragment label.

Do NOT label a Supabase anon/publishable key as a leaked secret. Only flag a secret when the code embeds an actual unredacted private credential, service-role key, or high-entropy secret.`;


// ============================== JSON tail closure ==============================

// Conservative, deterministic JSON tail-closure. Given a possibly-truncated
// JSON string, append ONLY the missing "}" and "]" closers required to
// balance open structures, and return the parsed value if JSON.parse
// accepts the result. Refuses on ANY of:
//   - unterminated string (open double-quote at end),
//   - mismatched delimiter (e.g. "{" popped by "]"),
//   - dangling structural token at the tail (",", ":", "{", "[")
//     — trailing commas / bare braces are NOT auto-fixed,
//   - the resulting string still fails JSON.parse.
// Never rewrites, deletes, guesses, or synthesizes content.
export type TailShape = "map" | "merge" | "generic";

// Maximum unmatched closers this rescue is willing to append at EOF. Anything
// beyond this bound is treated as ambiguous truncation and rejected — the
// live vote/audit failure modes we recover from are missing 1-2 outer
// closers only. Never fabricate keys/values; only balance.
const MAX_APPENDED_CLOSERS = 2;

export function tryCloseJsonTail(
  text: string,
  opts: { shape?: TailShape } = {},
): { ok: true; value: unknown; closed: string } | { ok: false; reason: string } {
  const shape: TailShape = opts.shape ?? "map";
  const s = String(text ?? "");
  if (!s.trim()) return { ok: false, reason: "empty" };
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;
  let lastMeaningful: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = false; lastMeaningful = '"'; }
      continue;
    }
    if (c === '"') { inString = true; lastMeaningful = '"'; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    if (c === "{" || c === "[") { stack.push(c as "{" | "["); lastMeaningful = c; continue; }
    if (c === "}" || c === "]") {
      const open = stack.pop();
      if (!open || (open === "{" && c !== "}") || (open === "[" && c !== "]")) {
        return { ok: false, reason: "mismatched delimiter" };
      }
      lastMeaningful = c;
      continue;
    }
    lastMeaningful = c;
  }
  if (inString) return { ok: false, reason: "unterminated string" };
  if (stack.length === 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(s); }
    catch (e) { return { ok: false, reason: `parse failed after balanced scan: ${(e as Error).message}` }; }
    const shapeErr = validateRescuedShape(parsed, shape);
    if (shapeErr) return { ok: false, reason: shapeErr };
    return { ok: true, value: parsed, closed: "" };
  }
  if (lastMeaningful === "," || lastMeaningful === ":" || lastMeaningful === "{" || lastMeaningful === "[") {
    return { ok: false, reason: `dangling structural token '${lastMeaningful}' — refuse to synthesize` };
  }
  if (stack.length > MAX_APPENDED_CLOSERS) {
    return { ok: false, reason: `refusing to append ${stack.length} closers — max ${MAX_APPENDED_CLOSERS}` };
  }
  let closers = "";
  for (let i = stack.length - 1; i >= 0; i--) closers += stack[i] === "{" ? "}" : "]";
  const attempt = s + closers;
  let parsed: unknown;
  try { parsed = JSON.parse(attempt); }
  catch (e) { return { ok: false, reason: `parse failed after appending ${JSON.stringify(closers)}: ${(e as Error).message}` }; }
  const shapeErr = validateRescuedShape(parsed, shape);
  if (shapeErr) return { ok: false, reason: shapeErr };
  return { ok: true, value: parsed, closed: closers };
}

// Rescued JSON must at minimum look like the target shape:
// - "map":     seat-report object with a findings array under seat caps.
// - "merge":   chair-merge object with verdict/summary/findings passing the
//              strict merged-report validator (no loose seat-cap acceptance).
// - "generic": non-audit steps (e.g. Round-4 vote objects). Caller's
//              validateStepJson enforces schema; this only requires the
//              rescued value to be an object or array so we never publish a
//              bare string/number/null as recovered JSON.
function validateRescuedShape(v: unknown, shape: TailShape): string | null {
  if (shape === "generic") {
    if (v === null || typeof v !== "object") return "rescued JSON is not an object or array";
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "rescued JSON is not an object";
  const findings = (v as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return "rescued JSON missing findings array";
  const cleaned = normalizeFindings(findings);
  if (cleaned.length === 0 && findings.length > 0) return "no findings survived normalization";
  if (shape === "merge") {
    const summary = (v as { summary?: unknown }).summary;
    const summaryStr = typeof summary === "string" ? summary : "";
    return validateMerged(cleaned, summaryStr);
  }
  return validateSeatReport(cleaned);
}

// AUDIT-JSON-RECOVERY-R5 — bounded deterministic recovery for a valid
// top-level JSON object/array followed only by whitespace and redundant
// unmatched closing delimiters of the SAME kind (e.g. an extra "}" after a
// complete object). This exists because live production step
// audit_inspector_c15 emitted:
//   {\n  "findings": []\n}\n}
// which is machine-recoverable without repair, guessing, or truncation.
//
// Rules (all must hold):
//   1. First non-whitespace char is "{" or "[" (root is object/array).
//   2. A balanced prefix parses strictly with JSON.parse.
//   3. Every char AFTER that prefix is whitespace OR the SAME closer as the
//      root kind ("}" for object roots, "]" for array roots).
//   4. Any prose, commas, colons, open delimiters, mismatched closers, a
//      second JSON value, or unterminated string ⇒ reject.
// This helper does NOT run schema validation; the caller runs it after.
export function tryRecoverTrailingRedundantCloser(
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const s = String(text ?? "");
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  if (i >= s.length) return { ok: false, reason: "empty" };
  const first = s[i];
  if (first !== "{" && first !== "[") return { ok: false, reason: "root is not object or array" };
  const allowedTrailing = first === "{" ? "}" : "]";
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;
  let end = -1;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{" || c === "[") { stack.push(c as "{" | "["); continue; }
    if (c === "}" || c === "]") {
      const open = stack.pop();
      if (!open) return { ok: false, reason: "unbalanced closing delimiter" };
      if ((open === "{" && c !== "}") || (open === "[" && c !== "]")) {
        return { ok: false, reason: "mismatched delimiter" };
      }
      if (stack.length === 0) { end = j; break; }
    }
  }
  if (inString) return { ok: false, reason: "unterminated string" };
  if (end < 0) return { ok: false, reason: "no complete top-level value" };
  const prefix = s.slice(i, end + 1);
  let value: unknown;
  try { value = JSON.parse(prefix); }
  catch (e) { return { ok: false, reason: `parse failed: ${(e as Error).message}` }; }
  for (let j = end + 1; j < s.length; j++) {
    const c = s[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    if (c === allowedTrailing) continue;
    return { ok: false, reason: `unexpected trailing character ${JSON.stringify(c)}` };
  }
  return { ok: true, value };
}
