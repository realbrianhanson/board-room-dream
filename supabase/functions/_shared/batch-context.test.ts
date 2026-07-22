import { assert, assertEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertBatchRequestSize,
  BatchContextTooLarge,
  compactMarkdown,
  isBatchGenerationStep,
  MAX_BATCH_REQUEST_CHARS,
  renderCompactRepoContract,
  utf8Bytes,
} from "./batch-context.ts";

Deno.test("compactMarkdown returns text unchanged when under cap", () => {
  const md = "# H1\n\ncontent";
  assertEquals(compactMarkdown(md, 10_000), md);
});

Deno.test("compactMarkdown preserves every H1/H2/H3 heading and stays under cap", () => {
  const sections = Array.from({ length: 20 }, (_, i) => `## Section ${i}\n${"x".repeat(2000)}`).join("\n\n");
  const md = `# Title\n\n${sections}`;
  const out = compactMarkdown(md, 10_000);
  assert(out.length <= 10_000, `length ${out.length} over cap`);
  assertStringIncludes(out, "# Title");
  for (let i = 0; i < 20; i++) assertStringIncludes(out, `## Section ${i}`);
});

Deno.test("renderCompactRepoContract prioritizes architectural files and caps bytes", () => {
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
  assert(utf8Bytes(out) < 60_000, `contract too large: ${utf8Bytes(out)}`);
});

Deno.test("assertBatchRequestSize fails closed when payload exceeds cap", () => {
  const small = { messages: [{ role: "user", content: "hi" }] };
  assertBatchRequestSize("batches_chair", small); // no throw
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
