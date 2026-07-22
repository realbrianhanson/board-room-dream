// deno-lint-ignore-file no-explicit-any
// Compact context helpers for batch draft/review/revise. The batch-generation
// trio does not need the same 400 KiB live-repo dump the audit-runner and the
// JIT batch-compiler use — reviewers only need enough repo evidence to spot
// invented paths and stack mismatches. The compiler regrounds each specific
// batch against the full live repo/schema before Copy is enabled, so this
// stage is intentionally lean and hard-capped.

export const MAX_BATCH_REQUEST_CHARS = 100_000;
export const COMPACT_ARTIFACT_CAP = 10_000;
export const COMPACT_REPO_KEY_BYTES = 24 * 1024;
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

// Heading-balanced compaction. We preserve every H1/H2/H3 heading verbatim
// and take a bounded excerpt from each section rather than truncating the
// whole document at the head — otherwise "Security", "Data model", and any
// other late section vanishes silently in a way reviewers can't detect.
export function compactMarkdown(md: string | null | undefined, capChars: number): string {
  const text = String(md ?? "");
  if (text.length <= capChars) return text;
  const MARKER = "> [COMPACTED — consult locked artifact or JIT compiler for the full text]\n\n";
  const budget = Math.max(1000, capChars - MARKER.length);

  type Section = { heading: string; body: string[] };
  const sections: Section[] = [{ heading: "", body: [] }];
  for (const line of text.split("\n")) {
    if (/^#{1,3}\s+/.test(line)) sections.push({ heading: line, body: [] });
    else sections[sections.length - 1].body.push(line);
  }

  const headingCost = sections.reduce(
    (n, s) => n + (s.heading ? s.heading.length + 1 : 0),
    0,
  );
  const bodyBudget = Math.max(0, budget - headingCost);
  const totalBody = Math.max(
    1,
    sections.reduce((n, s) => n + s.body.join("\n").length, 0),
  );

  const parts: string[] = [MARKER];
  for (const s of sections) {
    if (s.heading) parts.push(s.heading);
    const bodyStr = s.body.join("\n").replace(/^\n+|\n+$/g, "");
    if (!bodyStr) continue;
    const share = Math.max(160, Math.floor(bodyBudget * (bodyStr.length / totalBody)));
    if (bodyStr.length <= share) {
      parts.push(bodyStr);
    } else {
      const cut = bodyStr.slice(0, share).replace(/\s+\S*$/, "");
      parts.push(`${cut} …`);
    }
  }
  let out = parts.join("\n");
  if (out.length > capChars) {
    out = safeUtf8Cut(out, capChars * 4); // approximate — chars, not bytes
    if (out.length > capChars) out = out.slice(0, Math.max(0, capChars - 4)) + " …";
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

export function renderCompactRepoContract(input: CompactRepoInput): string {
  const treeSlice = input.fileTree.slice(0, COMPACT_REPO_TREE_PATHS);
  const treeBlock = treeSlice.length ? treeSlice.join("\n") : "(no repo files listed)";
  const stackBlock = detectStackEvidence(input.fileTree);

  const scored = input.files
    .map((f) => ({ f, s: keyEvidenceScore(f.path) }))
    .sort((a, b) => b.s - a.s || a.f.path.localeCompare(b.f.path));

  const evidenceParts: string[] = [];
  let usedBytes = 0;
  const cap = COMPACT_REPO_KEY_BYTES;
  for (const { f } of scored) {
    if (usedBytes >= cap) break;
    const header = `\n=== ${f.path} ===\n`;
    const headerBytes = utf8Bytes(header);
    const remaining = cap - usedBytes - headerBytes;
    if (remaining <= 200) break;
    // 4 KiB per-file soft cap keeps a single fat file from crowding out others.
    const perFileCap = Math.min(remaining, 4096);
    const excerpt = safeUtf8Cut(f.content, perFileCap);
    if (!excerpt) break;
    const chunk = header + excerpt;
    evidenceParts.push(chunk);
    usedBytes += utf8Bytes(chunk);
  }
  const keyBlock = evidenceParts.join("") || "(no readable key files)";

  return `LIVE REPO CONTRACT (COMPACT — batch-generation stage only). The JIT batch-compiler regrounds each individual batch against the full live repo and schema BEFORE Copy is enabled, so this stage is deliberately lean.

Rules for reviewers:
- The FILE TREE is authoritative for what currently exists. Any path/route/component/table/function that appears here is an UPDATE target and MUST match verbatim.
- Anything absent from the FILE TREE is CREATE/ADD; dependency ordering is the Chair's job.
- The KEY EVIDENCE excerpts are bounded architecture snippets, NOT full implementation bodies. Do not demand deep line-level changes against them; escalate that to the compiler.

REPO: ${input.repo}

STACK EVIDENCE
${stackBlock}

FILE TREE (top ${treeSlice.length} paths)
${treeBlock}

KEY EVIDENCE (<=${COMPACT_REPO_KEY_BYTES} bytes total, architectural files only)
${keyBlock}`;
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
