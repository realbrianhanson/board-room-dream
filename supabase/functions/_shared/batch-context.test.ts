// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertBatchRequestSize,
  BatchContextTooLarge,
  buildValidationRetryRequest,
  compactMarkdown,
  COMPACT_ARTIFACT_CAP,
  COMPACT_REPO_TOTAL_BYTES,
  isBatchGenerationStep,
  MarkdownCompactionImpossible,
  MAX_BATCH_REQUEST_CHARS,
  renderCompactRepoContract,
  utf8Bytes,
} from "./batch-context.ts";

// ============================== Test-only fixtures ==============================

// Realistic locked-artifact sizes drawn from the reference production run
// (plan 22,435 / PRD 20,969 / design 24,060) so a regression on section
// preservation would fail here in CI even without a live DB.
function makeMarkdownFixture(target: number, headings: string[]): { md: string; headings: string[] } {
  const parts: string[] = [];
  const perSection = Math.max(200, Math.floor(target / headings.length) - headings[0].length);
  for (const h of headings) {
    parts.push(h);
    const filler = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ").repeat(
      Math.ceil(perSection / 56),
    );
    parts.push(filler.slice(0, perSection));
  }
  let md = parts.join("\n\n");
  if (md.length < target) md += " ".repeat(target - md.length);
  else md = md.slice(0, target);
  return { md, headings };
}

const PLAN_HEADINGS = [
  "# Product plan",
  "## Problem",
  "## Buyer & job to be done",
  "## Solution outline",
  "## Business model",
  "## Data model",
  "## Security",
  "## Rollout milestones",
];
const PRD_HEADINGS = [
  "# PRD",
  "## MVP scope",
  "## Later scope",
  "## Routes",
  "## Components",
  "## Tables",
  "## Edge functions",
  "## Acceptance criteria",
];
const DESIGN_HEADINGS = [
  "# Design brief",
  "## Brand voice",
  "## Color tokens",
  "## Typography",
  "## Layout",
  "## Motion",
  "## Components",
  "## Accessibility",
];

const PLAN_FIXTURE = makeMarkdownFixture(22_435, PLAN_HEADINGS);
const PRD_FIXTURE = makeMarkdownFixture(20_969, PRD_HEADINGS);
const DESIGN_FIXTURE = makeMarkdownFixture(24_060, DESIGN_HEADINGS);

function makeFileTree(count: number): string[] {
  const paths: string[] = [
    "package.json",
    "vite.config.ts",
    "tailwind.config.ts",
    "tsconfig.json",
    "supabase/config.toml",
    "src/router.tsx",
    "src/start.ts",
    "src/routes/__root.tsx",
    "src/routes/index.tsx",
    "src/integrations/supabase/client.ts",
  ];
  const bases = ["src/components", "src/routes", "src/lib", "src/hooks", "supabase/functions/_shared"];
  // Include intentionally long / multibyte paths to catch UTF-16 splitting.
  const suffixes = ["long-name-that-really-goes-on-and-on-and-on", "emoji-🚀", "cjk-测试-模块"];
  let i = 0;
  while (paths.length < count) {
    const base = bases[i % bases.length];
    const suffix = suffixes[i % suffixes.length];
    paths.push(`${base}/${suffix}-${i}/index.tsx`);
    i++;
  }
  return paths;
}

function makeKeyFiles(): { path: string; content: string; bytes: number }[] {
  const big = (n: number) => "x".repeat(n);
  const files = [
    { path: "package.json", content: `{"name":"acme-app","dependencies":{"@tanstack/react-router":"^1.0.0"}}` },
    { path: "supabase/config.toml", content: `[api]\nport = 54321\n` },
    { path: "src/routes/__root.tsx", content: `export const Route = createRootRoute({/* root */})` },
    { path: "src/router.tsx", content: `export const router = createRouter({/* … */})` },
    { path: "src/integrations/supabase/client.ts", content: `export const supabase = createClient(...)` },
  ];
  // 20 large arbitrary-content files that must NOT crowd out the manifests.
  for (let i = 0; i < 20; i++) {
    files.push({ path: `src/components/heavy-${i}.tsx`, content: big(12_000) });
  }
  return files.map((f) => ({ ...f, bytes: f.content.length }));
}

// ============================== compactMarkdown ==============================

Deno.test("compactMarkdown returns text unchanged when under cap", () => {
  const md = "# H1\n\ncontent";
  assertEquals(compactMarkdown(md, 10_000), md);
});

Deno.test("compactMarkdown — plan (22,435) preserves every H1/H2/H3 heading under 10K", () => {
  const { md, headings } = PLAN_FIXTURE;
  const out = compactMarkdown(md, COMPACT_ARTIFACT_CAP);
  assert(out.length <= COMPACT_ARTIFACT_CAP, `plan output ${out.length} over cap`);
  for (const h of headings) assertStringIncludes(out, h);
});

Deno.test("compactMarkdown — PRD (20,969) preserves every heading under 10K", () => {
  const { md, headings } = PRD_FIXTURE;
  const out = compactMarkdown(md, COMPACT_ARTIFACT_CAP);
  assert(out.length <= COMPACT_ARTIFACT_CAP);
  for (const h of headings) assertStringIncludes(out, h);
});

Deno.test("compactMarkdown — design (24,060) preserves every heading under 10K", () => {
  const { md, headings } = DESIGN_FIXTURE;
  const out = compactMarkdown(md, COMPACT_ARTIFACT_CAP);
  assert(out.length <= COMPACT_ARTIFACT_CAP);
  for (const h of headings) assertStringIncludes(out, h);
});

Deno.test("compactMarkdown — multibyte CJK/emoji content never introduces U+FFFD or split surrogate", () => {
  const heavy = ("🚀 建立一个产品需要清晰的说明和明确的验收标准。 ").repeat(400);
  const md = `# 概述\n\n${heavy}\n\n## 详细\n\n${heavy}\n\n## 结论\n\n${heavy}`;
  const out = compactMarkdown(md, 2_000);
  assert(out.length <= 2_000);
  assert(!out.includes("\uFFFD"), "must not emit U+FFFD replacement char");
  assertStringIncludes(out, "# 概述");
  assertStringIncludes(out, "## 详细");
  assertStringIncludes(out, "## 结论");
  // No unpaired surrogate.
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = out.charCodeAt(i + 1);
      assert(next >= 0xDC00 && next <= 0xDFFF, `unpaired high surrogate at ${i}`);
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      throw new Error(`unpaired low surrogate at ${i}`);
    }
  }
});

Deno.test("compactMarkdown — heading-only fixture that cannot fit throws MarkdownCompactionImpossible", () => {
  const many = Array.from({ length: 200 }, (_, i) => `## Section ${i} with a fairly long heading name`).join("\n");
  const md = `${many}\n\nbody`;
  assertThrows(() => compactMarkdown(md, 500), MarkdownCompactionImpossible);
});

// ============================== renderCompactRepoContract ==============================

Deno.test("renderCompactRepoContract prioritizes architectural files and stays under total cap (small fixture)", () => {
  const files = [
    { path: "package.json", content: "PACKAGE_JSON_CONTENT", bytes: 20 },
    { path: "supabase/config.toml", content: "CONFIG_TOML", bytes: 11 },
    { path: "src/routes/__root.tsx", content: "ROOT_TSX", bytes: 8 },
    { path: "src/components/random.tsx", content: "x".repeat(50_000), bytes: 50_000 },
  ];
  const fileTree = files.map((f) => f.path);
  const out = renderCompactRepoContract({ repo: "acme/app", fileTree, files });
  assertStringIncludes(out, "REPO: acme/app");
  assertStringIncludes(out, "PACKAGE_JSON_CONTENT");
  assertStringIncludes(out, "CONFIG_TOML");
  assertStringIncludes(out, "ROOT_TSX");
  assert(utf8Bytes(out) <= COMPACT_REPO_TOTAL_BYTES, `contract too large: ${utf8Bytes(out)}`);
});

Deno.test("renderCompactRepoContract — 400-path tree + ~250K key files stays under 24 KiB total and never byte-cuts a path", () => {
  const fileTree = makeFileTree(400);
  const files = makeKeyFiles(); // ~250K total content across 25 files
  const out = renderCompactRepoContract({ repo: "acme/app", fileTree, files });
  const bytes = utf8Bytes(out);
  assert(bytes <= COMPACT_REPO_TOTAL_BYTES, `total rendered ${bytes} > cap ${COMPACT_REPO_TOTAL_BYTES}`);

  // Truncation disclosure MUST be present because 400 > 250 tree cap.
  assertStringIncludes(out, "showing ");
  assertStringIncludes(out, " of 400 paths");
  assertStringIncludes(out, "absence here does not prove");

  // Every emitted path must appear verbatim (no mid-path byte cuts).
  const treeMatch = out.match(/FILE TREE \(showing (\d+) of 400 paths[^)]*\)\n([\s\S]*?)(?=\nKEY EVIDENCE)/);
  assert(treeMatch, "expected FILE TREE section");
  const shown = Number(treeMatch![1]);
  assert(shown > 0 && shown <= 250, `shown count out of range: ${shown}`);
  const lines = treeMatch![2].split("\n").filter((l) => l.length && l !== "(no repo files listed)");
  assertEquals(lines.length, shown);
  for (const line of lines) {
    assert(fileTree.includes(line), `path was cut or mutated: ${JSON.stringify(line)}`);
  }

  // Package.json + TanStack/Supabase evidence must survive.
  assertStringIncludes(out, "package.json");
  assertStringIncludes(out, "src/routes/__root.tsx");
  assertStringIncludes(out, "supabase/config.toml");
});

// ============================== assertBatchRequestSize / isBatchGenerationStep ==============================

Deno.test("assertBatchRequestSize fails closed when payload exceeds cap", () => {
  const small = { messages: [{ role: "user", content: "hi" }] };
  assertBatchRequestSize("batches_chair", small);
  const big = { messages: [{ role: "user", content: "x".repeat(MAX_BATCH_REQUEST_CHARS + 100) }] };
  assertThrows(() => assertBatchRequestSize("batches_chair", big), BatchContextTooLarge);
});

Deno.test("isBatchGenerationStep flags chair/review/revise, ignores others", () => {
  assert(isBatchGenerationStep("batches_chair"));
  assert(isBatchGenerationStep("batches_revise_chair"));
  assert(isBatchGenerationStep("batches_review_inspector"));
  assert(!isBatchGenerationStep("audit_chair"));
  assert(!isBatchGenerationStep("r_final_ruling_chair"));
});

// ============================== buildValidationRetryRequest ==============================

Deno.test("buildValidationRetryRequest — small base + small assistant echo returns with_echo", () => {
  const baseMessages = [
    { role: "system", content: "OWNER AUTHORITY marker" },
    { role: "user", content: "Draft the batches now." },
  ];
  const out = buildValidationRetryRequest({
    stepKey: "batches_chair",
    baseRequest: { model: "chair", messages: baseMessages },
    baseMessages,
    assistantContent: "{ invalid",
    validationError: "Missing batches array.",
    truncated: false,
    correction: "correction body",
  });
  assertEquals(out.mode, "with_echo");
  const msgs = (out.request as any).messages;
  assertEquals(msgs.length, baseMessages.length + 2);
  assertEquals(msgs[msgs.length - 2].role, "assistant");
  assertEquals(msgs[msgs.length - 2].content, "{ invalid");
});

Deno.test("buildValidationRetryRequest — near-cap base + oversized echo drops echo and states both errors", () => {
  const bigOwner = "OWNER AUTHORITY marker\n" + "x".repeat(80_000);
  const draft = "FINAL FEATURE ITEM: launch checklist";
  const baseMessages = [
    { role: "system", content: bigOwner },
    { role: "user", content: `FEATURES\n\n- [mvp] Auth\n- [mvp] Dashboard\n\n${draft}` },
  ];
  const baseRequest = { model: "chair", messages: baseMessages };
  // 30K assistant echo pushes with_echo past MAX (100K).
  const assistant = "y".repeat(30_000);
  const baseMessages = [
    { role: "system", content: bigOwner },
    { role: "user", content: `FEATURES\n\n- [mvp] Auth\n- [mvp] Dashboard\n\n${draft}` },
  ];
  const baseRequest = { model: "chair", messages: baseMessages };
  // 25K assistant echo pushes with_echo well past MAX (100K).
  const assistant = "y".repeat(25_000);
  const out = buildValidationRetryRequest({
    stepKey: "batches_chair",
    baseRequest,
    baseMessages,
    assistantContent: assistant,
    validationError: "Missing batches array.",
    truncated: true,
    correction: "TRUNCATION CORRECTION",
  });
  assertEquals(out.mode, "without_echo");
  assert(out.chars <= MAX_BATCH_REQUEST_CHARS, `fallback chars ${out.chars} over cap`);
  const msgs = (out.request as any).messages;
  // Base survives verbatim (owner + features + final draft item).
  assertEquals(msgs[0].content, bigOwner);
  assertStringIncludes(msgs[1].content, "OWNER AUTHORITY marker".slice(0, 0)); // placeholder — real check below
  assertStringIncludes(msgs[0].content, "OWNER AUTHORITY marker");
  assertStringIncludes(msgs[1].content, "FEATURES");
  assertStringIncludes(msgs[1].content, "- [mvp] Dashboard");
  assertStringIncludes(msgs[1].content, draft);
  // Final message is the enriched correction; no assistant echo remains.
  assertEquals(msgs[msgs.length - 1].role, "user");
  assertStringIncludes(msgs[msgs.length - 1].content, "TRUNCATION CORRECTION");
  assertStringIncludes(msgs[msgs.length - 1].content, "Retry note");
  assertStringIncludes(msgs[msgs.length - 1].content, "truncated");
  assert(!msgs.some((m: any) => m.role === "assistant"), "assistant echo must be dropped");
});

Deno.test("buildValidationRetryRequest — impossible base (already over cap) throws BatchContextTooLarge", () => {
  const oversized = "z".repeat(MAX_BATCH_REQUEST_CHARS + 5_000);
  const baseMessages = [{ role: "system", content: oversized }];
  assertThrows(
    () =>
      buildValidationRetryRequest({
        stepKey: "batches_chair",
        baseRequest: { model: "chair", messages: baseMessages },
        baseMessages,
        assistantContent: "x",
        validationError: "e",
        truncated: false,
        correction: "c",
      }),
    BatchContextTooLarge,
  );
});

Deno.test("buildValidationRetryRequest — non-batch steps bypass 100K cap (legacy)", () => {
  const baseMessages = [{ role: "system", content: "hello" }];
  const out = buildValidationRetryRequest({
    stepKey: "r_final_ruling_chair",
    baseRequest: { messages: baseMessages },
    baseMessages,
    assistantContent: "z".repeat(MAX_BATCH_REQUEST_CHARS + 1000),
    validationError: "bad",
    truncated: true,
    correction: "c",
  });
  assertEquals(out.mode, "with_echo");
});

// ============================== Realistic complete-request shape fixtures ==============================

function buildOwnerAuthorityMarker(): string {
  return "OWNER AUTHORITY\n\n- [approved_change_request:abc123] Add invoicing surface for existing customers.";
}
function buildFeatures(): string {
  return [
    "- [mvp] Auth (email + magic link)",
    "- [mvp] Dashboard project grid",
    "- [mvp] Boardroom session view",
    "- [mvp] Runway batches",
    "- [mvp] Audit center",
    "- [later] Instructor cohort dashboard",
    "- [later] Enhancement: invoicing surface", // FINAL feature item — must survive
  ].join("\n");
}
function buildFakeDraftBatches(): string {
  const batches = Array.from({ length: 6 }, (_, i) => ({
    batch_no: i + 1,
    title: `Batch ${i + 1}`,
    channel: i === 5 ? "human" : "lovable",
    prompt_md: `Batch ${i + 1} body. `.repeat(150),
  }));
  batches[5].title = "FINAL DRAFT BATCH — invoicing";
  return JSON.stringify(batches, null, 2);
}

function assembleUserMessage(kind: "draft" | "review" | "revise", opts: {
  repoContract: string;
  compactPlan: string;
  compactPrd: string;
  compactDesign: string;
  features: string;
  draft?: string;
  reviewIssues?: string;
}): string {
  const designSection = opts.compactDesign
    ? `LOCKED DESIGN BRIEF (compact)\n\n${opts.compactDesign}`
    : `NO LOCKED DESIGN BRIEF.`;
  if (kind === "draft") {
    return `${opts.repoContract}\n\nLOCKED PLAN (compact)\n\n${opts.compactPlan}\n\nPRD (compact)\n\n${opts.compactPrd}\n\nFEATURES\n\n${opts.features}\n\n${designSection}\n\nProduce your JSON now.`;
  }
  if (kind === "review") {
    return `${opts.repoContract}\n\nLOCKED PLAN (compact)\n\n${opts.compactPlan}\n\nPRD (compact)\n\n${opts.compactPrd}\n\nFEATURES\n\n${opts.features}\n\n${designSection}\n\nDRAFT BATCHES\n\n${opts.draft ?? ""}\n\nProduce your JSON now.`;
  }
  return `${opts.repoContract}\n\nLOCKED PLAN (compact)\n\n${opts.compactPlan}\n\nPRD (compact)\n\n${opts.compactPrd}\n\nFEATURES\n\n${opts.features}\n\n${designSection}\n\nYOUR DRAFT\n\n${opts.draft ?? ""}\n\nREVIEW ISSUES\n\n${opts.reviewIssues ?? ""}\n\nProduce the revised JSON now.`;
}

function buildRealisticRequest(kind: "draft" | "review" | "revise") {
  const repoContract = renderCompactRepoContract({
    repo: "acme/app",
    fileTree: makeFileTree(400),
    files: makeKeyFiles(),
  });
  const compactPlan = compactMarkdown(PLAN_FIXTURE.md, COMPACT_ARTIFACT_CAP);
  const compactPrd = compactMarkdown(PRD_FIXTURE.md, COMPACT_ARTIFACT_CAP);
  const compactDesign = compactMarkdown(DESIGN_FIXTURE.md, COMPACT_ARTIFACT_CAP);
  const owner = buildOwnerAuthorityMarker();
  const features = buildFeatures();
  const draft = buildFakeDraftBatches();
  const reviewIssues = JSON.stringify(
    { verdict: "revise", issues: Array.from({ length: 8 }, (_, i) => ({ batch_no: i + 1, severity: "minor", text: "x".repeat(240) })) },
    null,
    2,
  );
  const user = assembleUserMessage(kind, { repoContract, compactPlan, compactPrd, compactDesign, features, draft, reviewIssues });
  return {
    request: {
      model: "chair",
      messages: [
        { role: "system", content: `${owner}\n\nYou are the Chair. ${"System prompt body. ".repeat(80)}` },
        { role: "user", content: user },
      ],
    },
    owner,
    features,
    draft,
  };
}

Deno.test("realistic draft request stays under 100K and preserves owner/features/draft markers", () => {
  const { request, owner, features } = buildRealisticRequest("draft");
  const chars = JSON.stringify(request).length;
  assert(chars <= MAX_BATCH_REQUEST_CHARS, `draft request ${chars} > cap`);
  const joined = JSON.stringify(request);
  assertStringIncludes(joined, "OWNER AUTHORITY");
  assertStringIncludes(joined, "invoicing surface"); // final feature item
  // Sanity: features block last item retained.
  assertStringIncludes(joined, features.split("\n").pop()!);
  // Assert size math sane: leaves headroom for owner authority injection.
  assert(chars < MAX_BATCH_REQUEST_CHARS - 5_000, `draft chars ${chars} leaves too little headroom`);
  // Silence unused-var lint.
  void owner;
});

Deno.test("realistic reviewer (inspector+contrarian) request stays under 100K and preserves final draft batch", () => {
  const { request, draft } = buildRealisticRequest("review");
  const chars = JSON.stringify(request).length;
  assert(chars <= MAX_BATCH_REQUEST_CHARS, `review request ${chars} > cap`);
  const joined = JSON.stringify(request);
  assertStringIncludes(joined, "OWNER AUTHORITY");
  assertStringIncludes(joined, "FINAL DRAFT BATCH");
  // Draft JSON survives verbatim.
  assert(joined.includes(draft.split("\n")[0]), "first draft line missing from review request");
});

Deno.test("realistic revise request stays under 100K and preserves owner + features + review issues", () => {
  const { request } = buildRealisticRequest("revise");
  const chars = JSON.stringify(request).length;
  assert(chars <= MAX_BATCH_REQUEST_CHARS, `revise request ${chars} > cap`);
  const joined = JSON.stringify(request);
  assertStringIncludes(joined, "OWNER AUTHORITY");
  assertStringIncludes(joined, "FINAL DRAFT BATCH");
  assertStringIncludes(joined, "REVIEW ISSUES");
});

Deno.test("oversized artifact injection fails closed via assertBatchRequestSize (never silently drops owner/features/draft)", () => {
  const { request } = buildRealisticRequest("revise");
  const msgs = (request as any).messages as any[];
  // Inject a hypothetical 30 KiB stray blob into the user message to push
  // the request past 100K. assertBatchRequestSize must throw rather than
  // silently drop the owner/features/draft context that already fits.
  msgs[1].content = msgs[1].content + "\n\n" + "P".repeat(30_000);
  assertThrows(() => assertBatchRequestSize("batches_chair", request), BatchContextTooLarge);
});
