// Deterministic pure sanitizer for Chair-authored fix batch prompts.
//
// The audit pipeline downgrades unsupported P0/P1 findings before publishing
// (see audit-findings.ts). However the Chair's raw `fix_prompt_md` may still
// contain numbered fix items derived from those rejected findings — which
// would leak unpublished directives into an executable Lovable batch.
//
// This module reshapes a raw fix prompt so it contains ONLY numbered items
// tied to the post-validation SUPPORTED P0/P1 findings. Any item that
// references a rejected finding (by file_path or by a distinctive token
// from its title) is dropped. Any item that cannot be tied to a supported
// finding is also dropped (fail-closed). Retained items are re-numbered;
// acceptance checks are filtered the same way. The Lovable batch footer
// ("Keep everything else identical." + "Typecheck when done.") is preserved.
//
// If nothing remains, the caller must insert no batch and alert.
//
// Pure and dependency-free so it can be unit-tested without a Supabase
// client or the orchestrator runtime.

export type FindingRef = {
  title?: string | null;
  file_path?: string | null;
};

export type SanitizeResult = {
  prompt: string | null;
  keptItemCount: number;
  droppedRejected: number;
  droppedUnmatched: number;
  reason: "ok" | "empty_input" | "no_items_retained" | "no_supported";
};

const FOOTER_KEEP = "Keep everything else identical.";
const FOOTER_TYPECHECK = "Typecheck when done.";
const ACCEPTANCE_HEADER_RE = /^\s*acceptance checks\s*:\s*$/i;
const NUMBERED_RE = /^\s*\d+\.\s+/;

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Extract distinctive identifier-like tokens from a finding title:
// mixed-case identifiers of length >= 9 (e.g. `getClaims`) or tokens
// containing `_`, `.`, or `-` (e.g. `auth-middleware`, `has_role`).
// Bare English words and short capitalized names (e.g. `Supabase`) are
// excluded to avoid false positives.
function distinctiveTokens(title: string): string[] {
  const out = new Set<string>();
  const tokenRe = /[A-Za-z_][A-Za-z0-9_.-]{3,}/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(title)) !== null) {
    const t = m[0];
    if (/[_.\-]/.test(t)) out.add(t.toLowerCase());
    else if (t.length >= 9 && /[A-Z]/.test(t) && /[a-z]/.test(t)) out.add(t.toLowerCase());
  }
  return [...out];
}

function referencesFinding(itemText: string, f: FindingRef): boolean {
  const hay = norm(itemText);
  const fp = norm(f.file_path);
  if (fp && hay.includes(fp)) return true;
  const title = String(f.title ?? "").trim();
  if (title) {
    const fullTitle = norm(title);
    if (fullTitle.length >= 12 && hay.includes(fullTitle)) return true;
    for (const t of distinctiveTokens(title)) {
      if (t && hay.includes(t)) return true;
    }
  }
  return false;
}

function anyReferences(itemText: string, list: FindingRef[]): boolean {
  for (const f of list) if (referencesFinding(itemText, f)) return true;
  return false;
}

// Split a block of text into numbered items. Everything before the first
// numbered line is returned as `preamble`. Each item text includes trailing
// (non-numbered) continuation lines up to the next numbered line.
function splitNumberedItems(block: string): { preamble: string; items: string[] } {
  const lines = block.split("\n");
  const items: string[] = [];
  let preamble: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (NUMBERED_RE.test(line)) {
      if (current) items.push(current.join("\n").trimEnd());
      current = [line.replace(NUMBERED_RE, "").trimStart()];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) items.push(current.join("\n").trimEnd());
  return { preamble: preamble.join("\n").trimEnd(), items };
}

function locateFooterStart(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().toLowerCase().startsWith(FOOTER_KEEP.toLowerCase())) return i;
  }
  return -1;
}

function locateAcceptance(lines: string[], upTo: number): number {
  for (let i = 0; i < (upTo < 0 ? lines.length : upTo); i++) {
    if (ACCEPTANCE_HEADER_RE.test(lines[i])) return i;
  }
  return -1;
}

function renumber(items: string[]): string {
  return items.map((it, i) => `${i + 1}. ${it.trimStart()}`).join("\n\n");
}

export function sanitizeFixPrompt(
  rawPrompt: string,
  supported: FindingRef[],
  rejected: FindingRef[],
): SanitizeResult {
  const src = String(rawPrompt ?? "").trim();
  if (!src) {
    return { prompt: null, keptItemCount: 0, droppedRejected: 0, droppedUnmatched: 0, reason: "empty_input" };
  }
  if (!supported.length) {
    return { prompt: null, keptItemCount: 0, droppedRejected: 0, droppedUnmatched: 0, reason: "no_supported" };
  }

  const lines = src.split("\n");
  const footerStart = locateFooterStart(lines);
  const boundary = footerStart >= 0 ? footerStart : lines.length;
  const acceptanceIdx = locateAcceptance(lines, boundary);

  const headerAndItemsEnd = acceptanceIdx >= 0 ? acceptanceIdx : boundary;
  const headerAndItemsBlock = lines.slice(0, headerAndItemsEnd).join("\n");
  const acceptanceBlock = acceptanceIdx >= 0
    ? lines.slice(acceptanceIdx + 1, boundary).join("\n")
    : "";

  const { preamble, items } = splitNumberedItems(headerAndItemsBlock);

  let droppedRejected = 0;
  let droppedUnmatched = 0;
  const keptItems: string[] = [];
  for (const it of items) {
    if (anyReferences(it, rejected)) {
      droppedRejected++;
      continue;
    }
    if (!anyReferences(it, supported)) {
      droppedUnmatched++;
      continue;
    }
    keptItems.push(it);
  }

  if (!keptItems.length) {
    return { prompt: null, keptItemCount: 0, droppedRejected, droppedUnmatched, reason: "no_items_retained" };
  }

  // Acceptance checks: keep only those tied to a retained supported finding.
  // If none survive, emit a single generic acceptance so the skeleton stays valid.
  let acceptanceItems: string[] = [];
  if (acceptanceBlock.trim()) {
    const split = splitNumberedItems(acceptanceBlock);
    for (const a of split.items) {
      if (anyReferences(a, rejected)) continue;
      if (anyReferences(a, supported)) acceptanceItems.push(a);
    }
  }
  if (!acceptanceItems.length) {
    acceptanceItems = ["Verify each numbered fix above resolves its cited finding."];
  }

  // Preserve the footer verbatim if the input had one; otherwise emit the
  // canonical Lovable batch footer.
  let footerText = "";
  if (footerStart >= 0) {
    footerText = lines.slice(footerStart).join("\n").trimEnd();
  } else {
    footerText = `${FOOTER_KEEP}\n${FOOTER_TYPECHECK}`;
  }

  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble.trimEnd());
  parts.push(renumber(keptItems));
  parts.push(`Acceptance checks:\n${renumber(acceptanceItems)}`);
  parts.push(footerText);

  return {
    prompt: parts.join("\n\n").trim(),
    keptItemCount: keptItems.length,
    droppedRejected,
    droppedUnmatched,
    reason: "ok",
  };
}
