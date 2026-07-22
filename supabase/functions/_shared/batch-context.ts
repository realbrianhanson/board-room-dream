// deno-lint-ignore-file no-explicit-any
// Compact context helpers for batch draft/review/revise. The batch-generation
// trio does not need the same 400 KiB live-repo dump the audit-runner and the
// JIT batch-compiler use — reviewers only need enough repo evidence to spot
// invented paths and stack mismatches. The compiler regrounds each specific
// batch against the full live repo/schema before Copy is enabled, so this
// stage is intentionally lean and hard-capped.

export const MAX_BATCH_REQUEST_CHARS = 100_000;
export const COMPACT_ARTIFACT_CAP = 10_000;
export const COMPACT_REPO_TOTAL_BYTES = 24 * 1024; // Total rendered contract, not just key-evidence.
export const COMPACT_REPO_TREE_PATHS = 250;

export class BatchContextTooLarge extends Error {
  readonly stepKey: string;
  readonly chars: number;
  constructor(stepKey: string, chars: number) {
    super(
      `batch_context_too_large: step=${stepKey} chars=${chars} cap=${MAX_BATCH_REQUEST_CHARS} — refuse to silently truncate owner authority, FEATURES, or the draft; shrink locked artifacts / repo evidence instead`,
    );
    this.name = "BatchContextTooLarge";
    this.stepKey = stepKey;
    this.chars = chars;
  }
}

export class MarkdownCompactionImpossible extends Error {
  readonly capChars: number;
  readonly requiredChars: number;
  constructor(capChars: number, requiredChars: number) {
    super(
      `markdown_compaction_impossible: cap=${capChars} chars but the marker plus every H1/H2/H3 heading needs ${requiredChars} chars — cannot preserve every heading verbatim without silently dropping one`,
    );
    this.name = "MarkdownCompactionImpossible";
    this.capChars = capChars;
    this.requiredChars = requiredChars;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export function utf8Bytes(s: string): number {
  return enc.encode(s).length;
}

// Cut a string at a byte boundary that never lands mid-codepoint.
export function safeUtf8Cut(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  let cut = maxBytes;
  // UTF-8 continuation bytes are 10xxxxxx; rewind until we're on a start byte.
  while (cut > 0 && (bytes[cut] & 0b11000000) === 0b10000000) cut--;
  return dec.decode(bytes.subarray(0, cut));
}

// Cut a JS string at a UTF-16 boundary that never splits a surrogate pair.
export function sliceCodepointsSafe(s: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  let cut = maxChars;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
  return s.slice(0, cut);
}

// Heading-balanced compaction. We preserve every H1/H2/H3 heading verbatim
// and take a bounded excerpt from each section rather than truncating the
// whole document at the head — otherwise "Security", "Data model", and any
// other late section vanishes silently in a way reviewers can't detect.
//
// Contract:
//   - marker + every H1/H2/H3 line survives verbatim, or the function throws
//     MarkdownCompactionImpossible (never silently drops a heading).
//   - output.length <= capChars by construction. Never uses a blind slice
//     and never splits a UTF-16 surrogate pair.
export function compactMarkdown(md: string | null | undefined, capChars: number): string {
  const text = String(md ?? "");
  if (text.length <= capChars) return text;
  const MARKER = "> [COMPACTED — consult locked artifact or JIT compiler for the full text]\n\n";

  type Section = { heading: string; body: string[] };
  const sections: Section[] = [{ heading: "", body: [] }];
  for (const line of text.split("\n")) {
    if (/^#{1,3}\s+/.test(line)) sections.push({ heading: line, body: [] });
    else sections[sections.length - 1].body.push(line);
  }

  // Each heading is emitted as "<heading>\n". Reserve that cost verbatim
  // BEFORE any body allocation — headings are non-negotiable.
  const headingSections = sections.filter((s) => s.heading);
  const headingsCost = headingSections.reduce((n, s) => n + s.heading.length + 1, 0);
  // Additional slack: 1 char newline per body-emitting section + " …" per truncated tail.
  const bodySlack = sections.length * 3;
  const required = MARKER.length + headingsCost;
  if (required > capChars) {
    throw new MarkdownCompactionImpossible(capChars, required);
  }

  const bodyBudget = Math.max(0, capChars - required - bodySlack);
  const totalBody = Math.max(
    1,
    sections.reduce((n, s) => n + s.body.join("\n").length, 0),
  );

  // parts is a tagged list so the defensive shave step at the end never
  // touches a heading or the marker.
  type Part = { kind: "marker" | "heading" | "body"; text: string };
  const parts: Part[] = [{ kind: "marker", text: MARKER }];
  for (const s of sections) {
    if (s.heading) parts.push({ kind: "heading", text: s.heading + "\n" });
    const bodyStr = s.body.join("\n").replace(/^\n+|\n+$/g, "");
    if (!bodyStr || bodyBudget === 0) continue;
    const share = Math.floor(bodyBudget * (bodyStr.length / totalBody));
    if (share < 8) continue;
    if (bodyStr.length <= share) {
      parts.push({ kind: "body", text: bodyStr + "\n" });
    } else {
      const cut = sliceCodepointsSafe(bodyStr, share).replace(/\s+\S*$/, "");
      if (cut.length >= 4) parts.push({ kind: "body", text: `${cut} …\n` });
    }
  }

  let total = parts.reduce((n, p) => n + p.text.length, 0);
  // Defensive shave: rounding + body slack can leave us a handful of chars
  // over. Trim from the TAIL of body parts only, never from headings or the
  // marker, and always on a safe codepoint boundary.
  if (total > capChars) {
    for (let i = parts.length - 1; i >= 0 && total > capChars; i--) {
      if (parts[i].kind !== "body") continue;
      const over = total - capChars;
      const p = parts[i].text;
      const keep = Math.max(0, p.length - over);
      const shaved = sliceCodepointsSafe(p, keep);
      total -= (p.length - shaved.length);
      parts[i].text = shaved;
    }
  }
  const out = parts.map((p) => p.text).join("");
  // Post-condition. If we ever exceed capChars here it means a heading alone
  // outweighs the cap AFTER the required check — surface it loudly rather
  // than silently splitting a heading.
  if (out.length > capChars) {
    throw new MarkdownCompactionImpossible(capChars, out.length);
  }
  return out;
}

// Prioritize architectural evidence: manifests, router/framework roots,
// Supabase config + migrations + edge-function entrypoints, shared contracts.
// We intentionally rank "arbitrary implementation body" lowest so a 100 KiB
// business-logic file cannot crowd out package.json.
function keyEvidenceScore(path: string): number {
  const p = path.toLowerCase();
  let s = 0;
  if (p === "package.json") s += 40;
  if (/^supabase\/config\.toml$/.test(p)) s += 30;
  if (/^supabase\/migrations\/[^/]+\.sql$/.test(p)) s += 22;
  if (/^supabase\/functions\/[^/]+\/index\.tsx?$/.test(p)) s += 20;
  if (/^supabase\/functions\/_shared\//.test(p)) s += 18;
  if (/^src\/routes\/__root\.tsx?$/.test(p)) s += 26;
  if (/^src\/(router|start|server)\.tsx?$/.test(p)) s += 20;
  if (/^src\/integrations\//.test(p)) s += 14;
  if (/(vite|tailwind|components)\.(config|json)/.test(p)) s += 12;
  if (/^tsconfig(\.[^/]+)?\.json$/.test(p)) s += 10;
  if (/^src\/routes\//.test(p)) s += 6;
  if (/^src\/(components|hooks|lib)\//.test(p)) s += 2;
  if (/\.(tsx?|json|toml|sql|md)$/.test(p)) s += 1;
  return s;
}

export function detectStackEvidence(fileTree: string[]): string {
  const has = (re: RegExp) => fileTree.some((p) => re.test(p));
  const bits: string[] = [];
  if (has(/^src\/routes\/__root\.tsx?$/)) bits.push("TanStack Start (src/routes/__root)");
  if (has(/^src\/router\.tsx?$/)) bits.push("Router entry at src/router");
  if (has(/^src\/start\.tsx?$/)) bits.push("Start config at src/start");
  if (has(/^supabase\/config\.toml$/)) bits.push("Supabase project (supabase/config.toml)");
  if (has(/^supabase\/functions\//)) bits.push("Supabase edge functions");
  if (has(/^supabase\/migrations\//)) bits.push("Supabase migrations");
  if (has(/tailwind\.config\./)) bits.push("Tailwind config");
  if (has(/^vite\.config\./)) bits.push("Vite config");
  if (has(/^next\.config\./)) bits.push("Next.js config");
  if (has(/^astro\.config\./)) bits.push("Astro config");
  return bits.length ? bits.map((b) => `- ${b}`).join("\n") : "(no stack indicators detected)";
}

export type CompactRepoInput = {
  repo: string;
  fileTree: string[];
  files: { path: string; content: string; bytes: number }[];
};

// Render a strictly-bounded LIVE REPO CONTRACT for batch generation. The
// TOTAL rendered UTF-8 size is capped by COMPACT_REPO_TOTAL_BYTES, not just
// the key-evidence excerpts. A partial file tree carries an explicit
// truncation disclosure so reviewers cannot mistakenly claim "path missing
// from tree ⇒ CREATE/ADD" — the JIT batch-compiler remains the authoritative
// full-tree/full-code gate.
export function renderCompactRepoContract(input: CompactRepoInput): string {
  const TOTAL = COMPACT_REPO_TOTAL_BYTES;
  const stackBlock = detectStackEvidence(input.fileTree);
  const totalPaths = input.fileTree.length;

  const rules = `LIVE REPO CONTRACT (COMPACT — batch-generation stage only). The JIT batch-compiler regrounds each individual batch against the full live repo/schema BEFORE Copy is enabled, so this stage is deliberately lean.

Rules for reviewers:
- The FILE TREE below is a BOUNDED subset. A path missing from the shown subset is NOT proof the file is absent from the repo — do not flag "invented path" on that basis alone.
- Reviewers may flag an UPDATE target only when a SHOWN path or the STACK EVIDENCE contradicts the draft. The JIT batch-compiler is the authoritative full-tree/full-code gate.
- Anything present in the FILE TREE MUST be referenced verbatim when a batch touches it.
- KEY EVIDENCE excerpts are bounded architecture snippets, NOT full implementation bodies. Escalate line-level changes to the compiler.

REPO: ${input.repo}

STACK EVIDENCE
${stackBlock}
`;

  let used = utf8Bytes(rules);
  if (used >= TOTAL) {
    // Rules alone must not swallow the whole budget. This is a static
    // string; if it ever grows past 24 KiB, ship a smaller rules block.
    return safeUtf8Cut(rules, TOTAL);
  }

  // Reserve at least ~6 KiB for KEY EVIDENCE so the tree cannot squeeze it
  // out. Any surplus tree budget rolls back into evidence naturally because
  // we recompute `used` before allocating the evidence budget.
  const EVIDENCE_MIN_RESERVE = 6 * 1024;
  const evidenceHeaderText = `\nKEY EVIDENCE (architectural files only, bounded excerpts)\n`;
  const evidenceHeaderBytes = utf8Bytes(evidenceHeaderText);

  // FILE TREE — include only WHOLE paths that fit, up to COMPACT_REPO_TREE_PATHS.
  const scoredPaths = input.fileTree.slice(0, COMPACT_REPO_TREE_PATHS);
  const treeParts: string[] = [];
  let treeUsed = 0;
  // Reserve max plausible tree-header size (before we know shown count).
  const worstTreeHeader = `\nFILE TREE (showing ${totalPaths} of ${totalPaths} paths, ${totalPaths} omitted for size)\n`;
  const treeBudget = Math.max(
    0,
    TOTAL - used - evidenceHeaderBytes - EVIDENCE_MIN_RESERVE - utf8Bytes(worstTreeHeader),
  );
  for (const p of scoredPaths) {
    const line = (treeParts.length ? "\n" : "") + p;
    const b = utf8Bytes(line);
    if (treeUsed + b > treeBudget) break;
    treeParts.push(p);
    treeUsed += b;
  }
  const shownCount = treeParts.length;
  const omitted = totalPaths - shownCount;
  const treeHeader =
    `\nFILE TREE (showing ${shownCount} of ${totalPaths} paths${omitted > 0 ? `, ${omitted} omitted for size — absence here does not prove the file is missing from the repo` : ""})\n`;
  const treeBody = shownCount ? treeParts.join("\n") : "(no repo files listed)";
  const treeSection = treeHeader + treeBody + "\n";
  used += utf8Bytes(treeSection);

  // KEY EVIDENCE — spend whatever bytes remain, complete headers + UTF-8-safe excerpts.
  used += evidenceHeaderBytes;
  const evidenceBudget = Math.max(0, TOTAL - used);
  const scored = input.files
    .map((f) => ({ f, s: keyEvidenceScore(f.path) }))
    .sort((a, b) => b.s - a.s || a.f.path.localeCompare(b.f.path));
  const evidenceParts: string[] = [];
  let evidenceUsed = 0;
  const PER_FILE_SOFT_CAP = 4096;
  for (const { f } of scored) {
    if (evidenceUsed >= evidenceBudget) break;
    const header = `\n=== ${f.path} ===\n`;
    const headerBytes = utf8Bytes(header);
    const remaining = evidenceBudget - evidenceUsed - headerBytes;
    if (remaining <= 200) break;
    const perFileCap = Math.min(remaining, PER_FILE_SOFT_CAP);
    const excerpt = safeUtf8Cut(f.content, perFileCap);
    if (!excerpt) break;
    const chunk = header + excerpt;
    const chunkBytes = utf8Bytes(chunk);
    if (evidenceUsed + chunkBytes > evidenceBudget) break;
    evidenceParts.push(chunk);
    evidenceUsed += chunkBytes;
  }
  const keyBlock = evidenceParts.join("") || "(no readable key files)";

  const out = rules + treeSection + evidenceHeaderText + keyBlock;
  // Final invariant check.
  if (utf8Bytes(out) > TOTAL) return safeUtf8Cut(out, TOTAL);
  return out;
}

// The single hard cap every batch-generation step must satisfy before insert.
// Fails closed. Owner authority, FEATURES, and the draft are NEVER dropped —
// the caller must shrink locked-artifact excerpts or repo evidence instead.
export function assertBatchRequestSize(stepKey: string, request: unknown): void {
  const chars = JSON.stringify(request ?? {}).length;
  if (chars > MAX_BATCH_REQUEST_CHARS) {
    throw new BatchContextTooLarge(stepKey, chars);
  }
}

export function isBatchGenerationStep(stepKey: string | null | undefined): boolean {
  const k = String(stepKey ?? "");
  return k === "batches_chair" || k === "batches_revise_chair" || k.startsWith("batches_review_");
}

// Audit map/extraction steps (per-chunk per-seat) AND the Chair merge step.
// Echoing the truncated prior response back to the model was letting it
// re-emit the same near-cap output and truncate identically. For these
// steps we always drop the echo and rely on the tightened correction copy
// alone. AUDIT-MERGE-BOUNDED-R3 extends this to audit_chair_merge — the
// live truncation at 6485/6500 tokens repeated when the echo was included.
export function isAuditMapStep(stepKey: string | null | undefined): boolean {
  const k = String(stepKey ?? "");
  return /^audit_(chair|strategist|contrarian|inspector|reserve)(_c\d+)?$/.test(k) && k !== "audit_chair_merge";
}

export function isAuditMergeStep(stepKey: string | null | undefined): boolean {
  return String(stepKey ?? "") === "audit_chair_merge";
}

export function isAuditNoEchoStep(stepKey: string | null | undefined): boolean {
  return isAuditMapStep(stepKey) || isAuditMergeStep(stepKey);
}

// ============================== Validation retry builder ==============================

// Pure, testable retry builder. The correction pass echoes the invalid
// assistant output back for models that need to see it — but that echo can
// push a near-cap base request past MAX_BATCH_REQUEST_CHARS. In that case
// we drop ONLY the assistant echo and enrich the correction text so the
// model still knows both the validation error AND why the echo was omitted.
// OWNER AUTHORITY, FEATURES, and every other base message survive verbatim.
export type ValidationRetryInput = {
  stepKey: string;
  baseRequest: Record<string, unknown>;
  baseMessages: unknown[];
  assistantContent: string;
  validationError: string;
  truncated: boolean;
  correction: string; // Pre-computed via correctionForStep(stepKey).
};

export type ValidationRetryResult = {
  request: Record<string, unknown>;
  mode: "with_echo" | "without_echo";
  chars: number;
};

export function buildValidationRetryRequest(input: ValidationRetryInput): ValidationRetryResult {
  const { stepKey, baseRequest, baseMessages, assistantContent, validationError, truncated, correction } = input;
  const correctionText = truncated
    ? correction
    : `Your previous response failed validation: ${validationError}\nReturn ONLY the required JSON object, no prose, no code fences.`;

  // Audit-map steps: never echo the prior response back. Echoing the
  // truncated near-cap output was letting the model re-emit and re-truncate
  // in the same shape. The correction copy alone (see correctionForStep)
  // asks for a materially smaller schema, so no echo is needed.
  if (isAuditNoEchoStep(stepKey)) {
    const noEchoText = truncated
      ? `${correctionText}\n\n(Retry note: your prior response was truncated at ${assistantContent.length} chars — do NOT reconstruct it verbatim. Emit only complete objects and close the schema properly.)`
      : `${correctionText}\n\n(Retry note: your prior response failed validation at ${assistantContent.length} chars — do NOT reconstruct it verbatim. Emit only complete objects and close the schema properly.)`;
    const req = {
      ...baseRequest,
      messages: [...baseMessages, { role: "user", content: noEchoText }],
    };
    return { request: req, mode: "without_echo", chars: JSON.stringify(req).length };
  }

  const withEcho = {
    ...baseRequest,
    messages: [
      ...baseMessages,
      { role: "assistant", content: assistantContent },
      { role: "user", content: correctionText },
    ],
  };
  const withEchoChars = JSON.stringify(withEcho).length;

  // Non-batch steps do not enforce the 100 KiB cap — legacy behaviour.
  if (!isBatchGenerationStep(stepKey)) {
    return { request: withEcho, mode: "with_echo", chars: withEchoChars };
  }
  if (withEchoChars <= MAX_BATCH_REQUEST_CHARS) {
    return { request: withEcho, mode: "with_echo", chars: withEchoChars };
  }

  // Fallback: drop the invalid assistant echo. State BOTH the original
  // validation error and the reason the echo is omitted so the model has the
  // full failure context.
  const echoLen = assistantContent.length;
  const reason = truncated
    ? `truncated (${echoLen} chars)`
    : `invalid JSON (${echoLen} chars): ${validationError}`;
  const fallbackCorrection = `${correctionText}\n\n(Retry note: your previous response was ${reason}. Echoing it back into this retry request would exceed the ${MAX_BATCH_REQUEST_CHARS}-char batch-context cap, so it has been omitted. Reproduce the required JSON strictly from the base context above — do not restate the prior draft prose.)`;
  const withoutEcho = {
    ...baseRequest,
    messages: [
      ...baseMessages,
      { role: "user", content: fallbackCorrection },
    ],
  };
  const withoutEchoChars = JSON.stringify(withoutEcho).length;
  if (withoutEchoChars > MAX_BATCH_REQUEST_CHARS) {
    throw new BatchContextTooLarge(stepKey, withoutEchoChars);
  }
  return { request: withoutEcho, mode: "without_echo", chars: withoutEchoChars };
}
