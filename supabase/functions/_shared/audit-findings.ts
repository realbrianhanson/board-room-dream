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
  mapEvidenceMax: 320,
  correctionFindingsMax: 3,
  correctionSerializedMax: 3_000,
  correctionDescriptionMax: 240,
  correctionEvidenceMax: 220,
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
export type DowngradeRecord = {
  title: string;
  file_path: string | null;
  from: Severity;
  to: Severity;
  reason: string;
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

export function isMigrationPath(fp: string | null): boolean {
  const t = String(fp ?? "").trim().toLowerCase().replace(/^\.?\/+/, "");
  return t.startsWith("supabase/migrations/");
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
export function looksLikeUniversalHelperClaim(title: string, description: string): boolean {
  const t = `${title}\n${description}`;
  return UNIVERSAL_HELPER_RX.test(t);
}

// Speculation guard: WHY clauses that lean on hedges ("appears", "may",
// "could", "likely", "seems") never rise past P2 for P0/P1 severity, even
// with an IMPACT marker attached. Keeps deterministic downgrades resistant
// to hallucinated concerns dressed up as concrete quotes.
const SPECULATION_WHY_RX = /\bWHY:\s*[^|\n]{0,200}?\b(appears?|may|might|could|likely|seems?|probably|possibly|perhaps|suspected|potentially)\b/i;
export function whyIsSpeculative(evidence: string): boolean {
  return SPECULATION_WHY_RX.test(String(evidence ?? ""));
}

export function downgradeUnsupported(
  findings: CleanFinding[],
): { findings: CleanFinding[]; downgrades: DowngradeRecord[] } {
  const downgrades: DowngradeRecord[] = [];
  const out = findings.map((f) => {
    if (f.severity !== "P0" && f.severity !== "P1") return f;
    let sev: Severity = f.severity;
    const push = (from: Severity, to: Severity, reason: string) => {
      downgrades.push({ title: f.title, file_path: f.file_path, from, to, reason });
    };

    // Rule 1 (P0 only): missing IMPACT marker → P0 becomes P1.
    if (sev === "P0" && !hasImpactMarker(f.evidence)) {
      push("P0", "P1", "P0 evidence missing IMPACT: build_failure|data_loss|auth_bypass|secret_exposure marker");
      sev = "P1";
    }

    // Rule 2: supabase/migrations/* P0/P1 requires CURRENT marker.
    if ((sev === "P0" || sev === "P1") && isMigrationPath(f.file_path) && !hasCurrentMarker(f.evidence)) {
      push(sev, "P2", "migrations/* claim missing CURRENT: corroboration of effective state");
      return { ...f, severity: "P2" as Severity };
    }

    // Rule 3: missing-object claim requires SCHEMA_LEDGER or RUNTIME_FAILURE.
    if ((sev === "P0" || sev === "P1")
        && looksLikeMissingObjectClaim(f.title, f.description)
        && !hasSchemaLedgerMarker(f.evidence)
        && !hasRuntimeFailureMarker(f.evidence)) {
      push(sev, "P2", "missing-object claim lacks SCHEMA_LEDGER: or RUNTIME_FAILURE: corroboration");
      return { ...f, severity: "P2" as Severity };
    }

    // Rule 4: universal-helper claim requires CALLER corroboration.
    if ((sev === "P0" || sev === "P1")
        && looksLikeUniversalHelperClaim(f.title, f.description)
        && !hasCallerMarker(f.evidence)) {
      push(sev, "P2", "universal-helper claim lacks CALLER: corroboration from a reachable caller");
      return { ...f, severity: "P2" as Severity };
    }

    // Baseline QUOTE/WHY + concrete-path/evidence/confidence gate.
    const reasons: string[] = [];
    if (!isConcretePath(f.file_path)) reasons.push("missing concrete file_path");
    if (!isConcreteEvidence(f.evidence)) reasons.push("evidence lacks concrete detail");
    if (!hasQuoteWhyMarker(f.evidence)) reasons.push("evidence missing QUOTE:/WHY: marker");
    if (f.confidence === "low") reasons.push("confidence low");
    if (reasons.length > 0) {
      push(sev, "P2", reasons.join("; "));
      return { ...f, severity: "P2" as Severity };
    }
    return sev === f.severity ? f : { ...f, severity: sev };
  });
  return { findings: out, downgrades };
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
  const { findings, downgrades } = downgradeUnsupported(deduped);
  const error = validateMerged(findings, summary);
  const verdictClaim = obj.verdict === "clean" ? "clean" : "findings";
  const verdict: "clean" | "findings" =
    verdictClaim === "clean" || findings.length === 0 ? "clean" : "findings";
  return { error, findings, downgrades, summary, verdict };
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
export type TailShape = "map" | "merge";

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
    // Any other token (bare word, number, comma, colon). Track for tail check.
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
  // Require the last non-whitespace token to be a value terminator. Explicit
  // reject list: ",", ":", "{", "[" — those all imply a missing value or key
  // that we refuse to synthesize.
  if (lastMeaningful === "," || lastMeaningful === ":" || lastMeaningful === "{" || lastMeaningful === "[") {
    return { ok: false, reason: `dangling structural token '${lastMeaningful}' — refuse to synthesize` };
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
// - "map":   seat-report object with a findings array under seat caps.
// - "merge": chair-merge object with verdict/summary/findings passing the
//   strict merged-report validator (no loose seat-cap acceptance).
function validateRescuedShape(v: unknown, shape: TailShape): string | null {
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
