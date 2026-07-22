// Pure validators + helpers for batch-compiler. Kept import-free of Deno.serve
// or supabase clients so they can be exercised deterministically from tests.

import { ownerAuthorityError, type OwnerAuthority } from "../_shared/owner-authority.ts";
export { ownerAuthorityError } from "../_shared/owner-authority.ts";
export type { OwnerAuthority } from "../_shared/owner-authority.ts";

export type TouchedPath = { path: string; action: "update" | "create" | "verify"; reason: string };
export type EvidenceItem = { claim: string; path: string; detail: string };
export type SatisfiedItem = { item: string; evidence: string };
export type Parsed = {
  status: "ready" | "already_done" | "blocked";
  compiled_prompt_md: string;
  compiled_verification_prompt_md?: string;
  rationale: string;
  drift_notes: string[];
  touched_paths: TouchedPath[];
  evidence: EvidenceItem[];
  preserved_intents: string[];
  satisfied_items: SatisfiedItem[];
  added_prerequisites: { item: string; reason: string; evidence: string }[];
  primary_intent_summary: string;
};

// G1: lovable AND supabase are code channels; human is a console checklist.
export function isCodeChannel(channel: string): boolean {
  return channel === "lovable" || channel === "supabase";
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","for","to","in","on","with","by","from","at","as","is","are","be","this","that","it",
  "batch","step","phase","module","modules","additions","addition","setup","setups","initial","new",
]);

export function tokenize(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * True when the compiled prompt's title / opening semantically matches the
 * current batch title: at least ceil(currentTokens/2) (min 1) content tokens
 * from the current title appear in the compiled prompt's first heading or
 * first 240 chars.
 */
export function titleSemanticallyMatches(compiled: string, currentTitle: string): boolean {
  const currentTokens = tokenize(currentTitle);
  if (!currentTokens.length) return true; // nothing to compare against
  const head = (compiled ?? "").split(/\r?\n/).slice(0, 6).join("\n").slice(0, 240).toLowerCase();
  const hits = currentTokens.filter((t) => head.includes(t)).length;
  const need = Math.max(1, Math.ceil(currentTokens.length / 2));
  return hits >= need;
}

/**
 * Detects shell/CI commands that swallow failure and therefore never fail a
 * pipeline (grep ... || exit 0, foo || true, etc.). Returns the offending
 * lines verbatim so the caller can surface them.
 */
export function detectUnsafeCommands(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  const lines = text.split(/\r?\n/);
  const patterns: RegExp[] = [
    /\|\|\s*exit\s+0\b/i,          // ... || exit 0
    /\|\|\s*true\b/i,               // ... || true
    /;\s*true\s*$/i,                // ... ; true
    /2>\s*\/dev\/null\s*;\s*true/i, // silent + true chain
  ];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (patterns.some((p) => p.test(line))) found.push(line);
  }
  return found;
}

/**
 * Heuristic: is this compiled prompt adding unrelated CI / repo-wide grep /
 * package.json script scope that has no support in evidence? We flag when the
 * prompt mentions CI/package.json scripts / grep sweeps AND none of the
 * evidence paths point to CI or package.json.
 */
export function looksLikeUnrelatedCiScope(compiled: string, evidence: EvidenceItem[]): boolean {
  if (!compiled) return false;
  const c = compiled.toLowerCase();
  const mentionsCiScope =
    /\bpackage\.json\b/.test(c) && /"scripts"|grep -r|ci\b|github actions|workflows\//.test(c);
  if (!mentionsCiScope) return false;
  const evidencedCi = (evidence ?? []).some((e) =>
    /(^|\/)(package\.json|\.github\/workflows\/)/i.test(e.path ?? ""),
  );
  return !evidencedCi;
}

/**
 * Shape validation — the compiler's structural contract with the model.
 * Returns null when valid, or a short human error string.
 */
export function shapeError(p: any): string | null {
  if (!p || typeof p !== "object") return "Not a JSON object.";
  if (!["ready", "already_done", "blocked"].includes(p.status)) return "Missing/invalid status.";
  if (typeof p.rationale !== "string" || !p.rationale.trim()) return "Missing rationale.";
  for (const key of ["drift_notes","touched_paths","evidence","preserved_intents","satisfied_items","added_prerequisites"]) {
    if (!Array.isArray(p[key])) return `Missing ${key} array.`;
  }
  if (typeof p.primary_intent_summary !== "string" || !p.primary_intent_summary.trim()) {
    return "Missing primary_intent_summary.";
  }
  for (const t of p.touched_paths) {
    if (!t || typeof t.path !== "string" || !t.path.trim()) return "touched_paths entries need a non-empty path.";
    if (!["update", "create", "verify"].includes(t.action)) return "touched_paths.action must be 'update' | 'create' | 'verify'.";
    if (typeof t.reason !== "string" || !t.reason.trim()) return "touched_paths entries need a non-empty reason.";
  }
  for (const e of p.evidence) {
    if (!e || typeof e.claim !== "string" || !e.claim.trim()) return "evidence entries need a non-empty claim.";
    if (typeof e.path !== "string" || !e.path.trim()) return "evidence entries need a non-empty path.";
    if (typeof e.detail !== "string" || !e.detail.trim()) return "evidence entries need a non-empty detail.";
  }
  for (const s of p.satisfied_items) {
    if (!s || typeof s.item !== "string" || !s.item.trim()) return "satisfied_items need item.";
    if (typeof s.evidence !== "string" || !s.evidence.trim()) return "satisfied_items need evidence.";
  }
  for (const a of p.added_prerequisites) {
    if (!a || typeof a.item !== "string" || !a.item.trim()) return "added_prerequisites need item.";
    if (typeof a.reason !== "string" || !a.reason.trim()) return "added_prerequisites need reason.";
    if (typeof a.evidence !== "string" || !a.evidence.trim()) return "added_prerequisites need evidence.";
  }
  if (p.status === "ready") {
    if (typeof p.compiled_prompt_md !== "string" || !p.compiled_prompt_md.trim()) {
      return "status 'ready' requires a non-empty compiled_prompt_md.";
    }
    if (p.touched_paths.length < 1) return "status 'ready' requires at least one touched_path.";
    if (p.evidence.length < 1) return "status 'ready' requires at least one evidence item.";
    if (p.preserved_intents.length < 1) return "status 'ready' requires at least one preserved_intent.";
  }
  return null;
}

/**
 * Deterministic validation of a parsed compile against the CURRENT batch row
 * (authoritative for scope) and the live repo file tree (authoritative for
 * reality). This is the F1 scope-substitution guard.
 */
export function batchAuthorityError(
  p: Parsed,
  batch: { title: string; channel: string; batch_no: number },
  fileTreeSet: Set<string>,
  opts: { source: "github" | "paste"; schemaObjects?: Set<string>; authority?: OwnerAuthority } = { source: "github" },
): string | null {
  if (p.status !== "ready") return null; // only ready prompts need scope enforcement
  // Verification prompt is required for code channels (lovable + supabase), forbidden for human.
  const isCode = isCodeChannel(batch.channel);
  const vp = p.compiled_verification_prompt_md ?? "";
  if (isCode) {
    if (!vp || !vp.trim()) {
      return `status 'ready' requires a non-empty compiled_verification_prompt_md for ${batch.channel} batches.`;
    }
    if (vp.length < 250 || vp.length > 1500) {
      return `compiled_verification_prompt_md is ${vp.length} chars — must be 250–1500.`;
    }
    if (!/^\s*Verify\s+Batch\s+\d+\s+after\s+implementation\.\s+Do\s+not\s+change\s+product\s+scope\./i.test(vp)) {
      return `compiled_verification_prompt_md must start with "Verify Batch N after implementation. Do not change product scope."`;
    }
    // Tool routing: lovable → browser test; supabase → direct edge/RPC + Deno test.
    if (batch.channel === "lovable" && !/browser\s+test|user\s+flow|click/i.test(vp)) {
      return `lovable verification prompt must invoke Lovable's browser testing / user flow verification.`;
    }
    if (batch.channel === "supabase" && !/(edge\s+function|rpc|deno\s+test|edge-function\s+verification)/i.test(vp)) {
      return `supabase verification prompt must invoke direct edge-function/RPC calls and Deno tests.`;
    }
  } else {
    // human channel — must not carry a verification prompt.
    if (vp && vp.trim()) {
      return `human channel batches must not include a compiled_verification_prompt_md.`;
    }
  }




  if (!titleSemanticallyMatches(p.compiled_prompt_md, batch.title)) {
    return `Compiled prompt title does not semantically match the current batch title "${batch.title}". The current batch row is authoritative — never substitute an older plan's same-number batch.`;
  }
  const unsafe = detectUnsafeCommands(p.compiled_prompt_md);
  if (unsafe.length) {
    return `Compiled prompt contains failure-swallowing command(s) that never fail a pipeline (e.g. "|| exit 0", "|| true"): ${unsafe[0]}`;
  }
  if (looksLikeUnrelatedCiScope(p.compiled_prompt_md, p.evidence)) {
    return `Compiled prompt adds package.json script / CI / repo-wide grep scope with no evidence pointing at package.json or .github/workflows — unrelated to the current batch intent.`;
  }
  // Reality checks against the live repo (github source only).
  if (opts.source === "github") {
    const badPath = (path: string) => path.startsWith("/") || path.includes("..") || path.includes("\\");
    const seen = new Set<string>();
    for (const t of p.touched_paths) {
      if (badPath(t.path)) return `touched_paths path "${t.path}" is not a repo-relative POSIX path.`;
      const key = `${t.action}:${t.path}`;
      if (seen.has(key)) return `touched_paths has a duplicate entry for ${key}.`;
      seen.add(key);
      // No create+update on the same path.
      for (const other of ["update","create","verify"]) {
        if (other === t.action) continue;
        if (seen.has(`${other}:${t.path}`)) return `touched_paths conflicts on "${t.path}" (${other} + ${t.action}).`;
      }
      if ((t.action === "update" || t.action === "verify") && !fileTreeSet.has(t.path)) {
        return `touched_paths ${t.action} target "${t.path}" does not exist in the live repo — either it must be action "create" or the path is wrong.`;
      }
      if (t.action === "create" && fileTreeSet.has(t.path)) {
        return `touched_paths create target "${t.path}" already exists in the live repo — convert to "update" or "verify", or drop it and record it in satisfied_items.`;
      }
    }
    for (const e of p.evidence) {
      if (badPath(e.path)) return `evidence path "${e.path}" is not a repo-relative POSIX path.`;
      if (!fileTreeSet.has(e.path)) return `evidence path "${e.path}" does not exist in the live repo.`;
    }
    // Schema inventory — a CREATE for an object that already exists must be ALTER/VERIFY.
    if (opts.schemaObjects && opts.schemaObjects.size) {
      const hit = findExistingCreateCollision(p.compiled_prompt_md, opts.schemaObjects);
      if (hit) {
        return `Compiled prompt tells Lovable to CREATE ${hit.kind} "${hit.name}" which already exists in the live database — must be ALTER/VERIFY, or moved to satisfied_items with current-column evidence.`;
      }
    }
  }
  // Owner-authority gate — deterministic post-validator, independent of any
  // upstream "reviewed"/"approved" flag. Blocks high-impact directives (pricing,
  // payment providers, disabling existing features, destructive SQL, custom
  // domains, RLS broadening, public sign-ups) that lack a verified
  // [OWNER-AUTHORIZED: source="..." quote="..."] marker whose quote appears
  // verbatim in intake, founder_notes, or an approved change_request.
  if (opts.authority) {
    const authErr =
      ownerAuthorityError(p.compiled_prompt_md, opts.authority) ??
      (p.compiled_verification_prompt_md
        ? ownerAuthorityError(p.compiled_verification_prompt_md, opts.authority)
        : null);
    if (authErr) return authErr;
  }
  // Skeleton enforcement — all ready compiles (human batches are rejected upstream).
  const sk = skeletonError(p.compiled_prompt_md, batch);
  if (sk) return sk;
  return null;
}

/**
 * Strip identifier quoting (double-quotes, backticks) and an optional
 * "public." schema prefix, and lowercase — so "public.audit_findings",
 * `audit_findings`, "audit_findings", and audit_findings all normalize to
 * the same key used by the inventory Set.
 */
export function normalizeSqlIdent(raw: string): string {
  return raw
    .trim()
    .replace(/^[`"](.*)[`"]$/, "$1")
    .replace(/^public\./i, "")
    .toLowerCase();
}

/**
 * Detects CREATE statements against objects that already exist in the live
 * DB, tolerant of identifier quoting, schema prefixes, IF NOT EXISTS, and
 * the narrative phrasing "Create a Postgres RPC/table/function <name>(...)".
 */
export function findExistingCreateCollision(
  text: string,
  existing: Set<string>,
): { kind: string; name: string } | null {
  if (!text) return null;
  // Canonical SQL: CREATE [OR REPLACE] TABLE|FUNCTION|POLICY|TRIGGER|INDEX [IF NOT EXISTS] [public.]name
  const sqlRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|FUNCTION|POLICY|TRIGGER|INDEX|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:public\.)?(?:"[^"]+"|`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = sqlRe.exec(text))) {
    const kind = m[1].toLowerCase();
    const name = normalizeSqlIdent(m[2]);
    if (existing.has(name)) return { kind, name };
  }
  // Narrative: "Create a Postgres RPC/table/function/policy called <name>(...)".
  const narrativeRe = /\bcreate\s+(?:a|an|the)?\s*(?:new\s+)?(?:postgres\s+|supabase\s+|database\s+|db\s+)?(rpc|table|function|policy|trigger|index|view)\s+(?:called|named|for)?\s*((?:public\.)?(?:"[^"]+"|`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*))\s*\(/gi;
  while ((m = narrativeRe.exec(text))) {
    const kind = m[1].toLowerCase();
    const name = normalizeSqlIdent(m[2]);
    if (existing.has(name)) return { kind, name };
  }
  return null;
}

/**
 * Strict skeleton check for code-channel compiled prompts:
 * - first line: `Batch {n} — <title semantically matching current title>. Numbered items only, no scope creep.`
 * - 900–3200 chars total.
 * - 2–4 lines under an "Acceptance" section (case-insensitive).
 * - ends with the closing footer verbatim.
 */
export function skeletonError(
  compiled: string,
  batch: { title: string; batch_no: number; channel: string },
): string | null {
  const text = (compiled ?? "").replace(/\r\n/g, "\n");
  if (text.length < 900) return `compiled_prompt_md too short (${text.length} chars, min 900).`;
  if (text.length > 3200) return `compiled_prompt_md too long (${text.length} chars, max 3200).`;
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  const stripLead = firstLine.replace(/^[#>*\s]+/, "");
  const headerRe = new RegExp(`^Batch\\s+${batch.batch_no}\\s*[—-]\\s+(.+?)\\.\\s*Numbered\\s+items\\s+only,\\s+no\\s+scope\\s+creep\\.$`, "i");
  const m = stripLead.match(headerRe);
  if (!m) {
    return `First line must be "Batch ${batch.batch_no} — <title>. Numbered items only, no scope creep." (got: ${firstLine.slice(0, 140)})`;
  }
  if (!titleSemanticallyMatches(m[1], batch.title)) {
    return `First-line title "${m[1]}" does not semantically match current batch title "${batch.title}".`;
  }
  // Acceptance section required for code batches (lovable + supabase).
  // G1 FIX: the previous check compared against "code" and never fired because
  // real batch channels are "lovable" / "supabase" / "human".
  if (isCodeChannel(batch.channel)) {
    const acceptIdx = text.search(/^\s*(?:#+\s*)?acceptance(?:\s+checks)?\s*[:\s]*$/im);
    if (acceptIdx < 0) return `Missing "Acceptance" section.`;
    const afterAccept = text.slice(acceptIdx).split(/\n/).slice(1);
    const acceptLines: string[] = [];
    for (const l of afterAccept) {
      const t = l.trim();
      if (!t) { if (acceptLines.length) break; else continue; }
      if (/^(#+\s|Keep everything else identical\.)/i.test(t)) break;
      acceptLines.push(t);
    }
    if (acceptLines.length < 2 || acceptLines.length > 4) {
      return `Acceptance section must have 2–4 checks (found ${acceptLines.length}).`;
    }
  }
  const trimmedEnd = text.trimEnd();
  if (!/Keep everything else identical\.\s*\n\s*Typecheck when done\.$/.test(trimmedEnd)) {
    return `compiled_prompt_md must end exactly with "Keep everything else identical.\\nTypecheck when done.".`;
  }
  return null;
}
