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
  mergeFindingsMax: 30,
  mergeSerializedMax: 18_000,
  titleMax: 160,
  descriptionMax: 900,
  evidenceMax: 500,
  mergePayloadMax: 80_000,
  // Map/extraction (per-chunk per-seat) — deliberately narrower than the merge
  // input caps. The live 2400-token map budget was too tight for the prior
  // 12/8000 schema and produced structurally complete JSON that ended one
  // token short of the outer "]}" (run e2c5faf3). Narrowing the shape gives
  // the low-reasoning map call actual headroom under a max_tokens of 4000.
  mapFindingsMax: 6,
  mapSerializedMax: 4_000,
  mapTitleMax: 120,
  mapDescriptionMax: 400,
  mapEvidenceMax: 240,
  // Post-truncation correction — asks ONLY for a compact, complete
  // reconstruction. Must not repeat the failure mode: never 12 findings,
  // never 8000 chars.
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
  "evidence": "<=500 chars, concrete: exact vulnerable construct, verbatim quote/snippet, or precise data-flow. A filename alone or a speculative risk is NOT evidence.",
  "confidence": "high"|"medium"|"low",
  "line_start": integer > 0 or null,
  "line_end": integer > 0 (>= line_start) or null
}

Serious findings (P0/P1) require:
- a concrete repo-relative file_path (never empty, never a directory alone),
- specific evidence explaining the exact vulnerable/broken construct (not the mere presence of a file, dependency, or category of risk),
- confidence "high" or "medium".

Include lines when the source provides reliable line numbers. When the corpus formatting has no stable lines (chunked concatenations, paste), leave line_start / line_end null instead of guessing.

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

export function downgradeUnsupported(
  findings: CleanFinding[],
): { findings: CleanFinding[]; downgrades: DowngradeRecord[] } {
  const downgrades: DowngradeRecord[] = [];
  const out = findings.map((f) => {
    if (f.severity !== "P0" && f.severity !== "P1") return f;
    const reasons: string[] = [];
    if (!isConcretePath(f.file_path)) reasons.push("missing concrete file_path");
    if (!isConcreteEvidence(f.evidence)) reasons.push("evidence lacks concrete detail");
    if (f.confidence === "low") reasons.push("confidence low");
    if (reasons.length === 0) return f;
    downgrades.push({
      title: f.title,
      file_path: f.file_path,
      from: f.severity,
      to: "P2",
      reason: reasons.join("; "),
    });
    return { ...f, severity: "P2" as Severity };
  });
  return { findings: out, downgrades };
}

// Strict validator. Returns null on OK, or a short message describing the
// first violation. Enforces per-finding shape, counts, and payload size.
export function validateMerged(findings: CleanFinding[]): string | null {
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
    if (f.title.length > CAPS.titleMax) return `findings[${i}].title over ${CAPS.titleMax}`;
    if (f.description.length > CAPS.descriptionMax) return `findings[${i}].description over ${CAPS.descriptionMax}`;
    if (f.evidence.length > CAPS.evidenceMax) return `findings[${i}].evidence over ${CAPS.evidenceMax}`;
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
  return null;
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
  "evidence": "<=${CAPS.mapEvidenceMax} chars, concrete: exact vulnerable construct, verbatim short quote, or precise data-flow. A filename alone or a speculative risk is NOT evidence.",
  "confidence": "high"|"medium"|"low",
  "line_start": integer > 0 or null,
  "line_end": integer > 0 (>= line_start) or null
}

Serious findings (P0/P1) require:
- a concrete repo-relative file_path,
- specific evidence explaining the exact vulnerable/broken construct,
- confidence "high" or "medium".

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
export function tryCloseJsonTail(
  text: string,
): { ok: true; value: unknown; closed: string } | { ok: false; reason: string } {
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
    // Already balanced — try to parse as is; if this fails the caller falls
    // through to correction.
    try { return { ok: true, value: JSON.parse(s), closed: "" }; }
    catch (e) { return { ok: false, reason: `parse failed after balanced scan: ${(e as Error).message}` }; }
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
  const shapeErr = validateRescuedShape(parsed);
  if (shapeErr) return { ok: false, reason: shapeErr };
  return { ok: true, value: parsed, closed: closers };
}

// Rescued JSON must at minimum look like a map-step response: an object with
// a `findings` array whose entries survive normalizeFindings. This keeps the
// rescue helper from ever handing the orchestrator a payload the seat/merge
// validators would reject a step later.
function validateRescuedShape(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "rescued JSON is not an object";
  const findings = (v as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return "rescued JSON missing findings array";
  const cleaned = normalizeFindings(findings);
  if (cleaned.length === 0 && findings.length > 0) return "no findings survived normalization";
  return validateSeatReport(cleaned);
}
