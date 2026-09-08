// RC-6 prompt diet: every map call used to carry the raw plan + PRD + design
// brief, the whole file tree, the field manual and a second copy of the
// fragment rule. Fixture sizes are the live reference artifacts
// (plan 22,435 / PRD 20,969 / design 24,060 chars, 400-path tree, 64 KiB chunk).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AUDIT_CONTRARIAN_PRD_CAP,
  AUDIT_DESIGN_CAP,
  AUDIT_PLAN_CAP,
  AUDIT_PRD_CAP,
  buildAuditMapRows,
  CHUNK_BYTES,
  chunkFiles,
  chunkHasUiSurface,
  directorySummary,
  mapSeatsForChunk,
  seatContractSection,
  strategistInScope,
} from "./index.ts";
import { deriveImportWorkflow } from "../_shared/import-workflow.ts";

function markdownOf(label: string, chars: number): string {
  const parts: string[] = [`# ${label}`];
  let i = 0;
  while (parts.join("\n").length < chars) {
    parts.push(`## ${label} section ${++i}`);
    parts.push(`${label} body ${i}: `.padEnd(400, "lorem ipsum dolor sit amet "));
  }
  return parts.join("\n").slice(0, chars);
}

const PLAN = markdownOf("Plan", 22_435);
const PRD = markdownOf("PRD", 20_969);
const DESIGN = markdownOf("Design", 24_060);
assertEquals([PLAN.length, PRD.length, DESIGN.length], [22_435, 20_969, 24_060]);

const TREE = Array.from({ length: 400 }, (_, i) => {
  const dirs = ["src/routes", "src/components", "src/lib", "supabase/functions", "supabase/migrations", "public", "docs"];
  return `${dirs[i % dirs.length]}/file${i}.ts`;
});

function files(prefix: string, n: number, bytes: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `${prefix}/file${i}.ts`,
    content: `export const v${i} = "`.padEnd(bytes - 2, "x") + `";`,
    bytes,
  }));
}

// Three backend files overflow chunk 1 (exactly 64 KiB, the third file is
// fragmented); chunk 2 holds the tail plus a route (UI).
const BACKEND = files("supabase/functions/_shared", 3, 30_000);
const UI = [{ path: "src/routes/index.tsx", content: "export default function Page() { return <div/>; }", bytes: 49 }];
const packed = chunkFiles([...BACKEND, ...UI]);

function rowsFor(over: Partial<Parameters<typeof buildAuditMapRows>[0]> = {}) {
  return buildAuditMapRows({
    runId: "run-1",
    userId: "user-1",
    chunks: packed.rendered,
    chunkPaths: packed.paths,
    batchPrompt: null,
    finalContract: {
      mode: "full_blueprint",
      planContentMd: PLAN,
      prdMd: PRD,
      designBrief: DESIGN,
      includedBatchIds: [],
      extraContext: "",
      extraTruncated: false,
    },
    batchPlan: null,
    batchDesignBrief: null,
    isFinal: true,
    batchOutcome: null,
    fileTree: TREE,
    scopeContract: null,
    smoke: false,
    source: "github",
    strategist: true,
    ...over,
  });
}

function userOf(row: Record<string, unknown>): string {
  const msgs = (row.request as { messages: Array<{ role: string; content: string }> }).messages;
  return msgs[1].content;
}

Deno.test("fixture: the first chunk really is a ~64 KiB rendered chunk and the tree has 400 paths", () => {
  assert(packed.rendered.length >= 2, `expected >= 2 chunks, got ${packed.rendered.length}`);
  const bytes = new TextEncoder().encode(packed.rendered[0]).length;
  assert(bytes > CHUNK_BYTES * 0.9 && bytes <= CHUNK_BYTES, `chunk 1 is ${bytes} bytes`);
  assertEquals(TREE.length, 400);
});

Deno.test("every seat's non-code portion stays under 20K chars on the reference artifacts", () => {
  const rows = rowsFor();
  assert(rows.length > 0);
  for (const row of rows) {
    const user = userOf(row);
    const idx = Number(String(row.step_key).match(/_c(\d+)$/)?.[1] ?? 1) - 1;
    const code = packed.rendered[idx];
    assert(user.includes(code), `${row.step_key} must carry its chunk`);
    const nonCode = user.length - code.length;
    assert(nonCode < 20_000, `${row.step_key}: non-code portion is ${nonCode} chars`);
  }
});

Deno.test("no field manual, no duplicated fragment rule, no raw file tree in any map user message", () => {
  for (const row of rowsFor()) {
    const user = userOf(row);
    assert(!user.includes("LOVABLE EXECUTION CONTRACT"), "field manual must not ship in map calls");
    assert(!user.includes("FRAGMENT BOUNDARY RULE"), "fragment rule lives in MAP_FINDING_SCHEMA_DOC only");
    assert(!user.includes("docs/file6.ts"), "raw tree paths outside the chunk must not ship");
    assert(user.includes("Flag only issues you can verify in THIS chunk's code; do not report files you cannot see as missing."));
    assert(user.includes("supabase/functions/ (") || user.includes("src/routes/ ("), "directory summary present");
  }
});

Deno.test("run-constant blocks precede the chunk-specific orientation and CODE", () => {
  const user = userOf(rowsFor()[0]);
  const contract = user.indexOf("FINAL A-Z AUDIT");
  const prd = user.indexOf("PRD");
  const chunk = user.indexOf("CHUNK 1 OF");
  const code = user.indexOf("\nCODE\n");
  assert(contract >= 0 && prd > contract && chunk > prd && code > chunk, `order ${contract} ${prd} ${chunk} ${code}`);
  assert(user.includes("Files in THIS chunk:\nsupabase/functions/_shared/file0.ts"));
});

Deno.test("seat artifacts: inspector PRD+plan, contrarian short PRD, strategist design+plan; omissions are labelled", () => {
  const base = { planContentMd: PLAN, prdMd: PRD, designBrief: DESIGN, extraContext: "", mode: "full_blueprint" as const };
  const inspector = seatContractSection("inspector", base);
  assert(inspector.includes("## PRD section 1") && inspector.includes("## Plan section 1"));
  assert(inspector.includes("DESIGN BRIEF\n(omitted for this seat)"));
  assert(!inspector.includes("Design body"));
  assert(inspector.length < AUDIT_PRD_CAP + AUDIT_PLAN_CAP + 200, `inspector ${inspector.length}`);

  const contrarian = seatContractSection("contrarian", base);
  assert(contrarian.includes("## PRD section 1"));
  assert(contrarian.includes("PLAN\n(omitted for this seat)") && contrarian.includes("DESIGN BRIEF\n(omitted for this seat)"));
  assert(contrarian.length < AUDIT_CONTRARIAN_PRD_CAP + 200, `contrarian ${contrarian.length}`);

  const strategist = seatContractSection("strategist", base);
  assert(strategist.includes("## Design section 1") && strategist.includes("## Plan section 1"));
  assert(strategist.includes("PRD\n(omitted for this seat)"));
  assert(strategist.length < AUDIT_PLAN_CAP + AUDIT_DESIGN_CAP + 200, `strategist ${strategist.length}`);

  // A genuinely absent artifact still reads "(none)".
  const noDesign = seatContractSection("strategist", { ...base, designBrief: null });
  assert(noDesign.includes("DESIGN BRIEF\n(none)"));
});

Deno.test("identical PRD/plan (import intake) is compacted once and deduped by the renderer", () => {
  const intake = markdownOf("Intake", 30_000);
  const section = seatContractSection("inspector", {
    planContentMd: intake,
    prdMd: intake,
    designBrief: null,
    extraContext: "",
    mode: "import_current_milestone",
  });
  assert(section.startsWith("PRD / PLAN (identical)"));
  assert(section.length <= AUDIT_PRD_CAP + 40, `${section.length}`);
});

Deno.test("directorySummary collapses to first-two-segment directories with counts, capped at 60 lines", () => {
  const summary = directorySummary(TREE);
  const lines = summary.split("\n");
  assertEquals(lines.length, 7);
  assert(lines.includes("src/routes/ (58 files)"), summary);
  const wide = Array.from({ length: 90 }, (_, i) => `dir${String(i).padStart(3, "0")}/sub/x.ts`);
  const capped = directorySummary(wide).split("\n");
  assertEquals(capped.length, 61);
  assert(capped[60].includes("+30 more directories"));
  assertEquals(directorySummary(["index.html", "src/a.ts"]), "./ (1 file)\nsrc/ (1 file)");
});

Deno.test("strategist runs only on chunks with a UI surface, on pasted code, and never on an audit-only import", () => {
  assert(chunkHasUiSurface(["src/routes/index.tsx"]));
  assert(chunkHasUiSurface(["supabase/functions/x.ts", "src/styles/app.css"]));
  assert(chunkHasUiSurface(["index.html"]));
  assert(chunkHasUiSurface(["tailwind.config.ts"]));
  assert(!chunkHasUiSurface(["supabase/functions/_shared/a.ts", "supabase/migrations/1.sql"]));

  const backend = ["supabase/functions/_shared/a.ts"];
  const ui = ["src/components/Button.tsx"];
  assertEquals([...mapSeatsForChunk({ smoke: false, source: "github", chunkPaths: backend, strategist: true })], ["inspector", "contrarian"]);
  assertEquals([...mapSeatsForChunk({ smoke: false, source: "github", chunkPaths: ui, strategist: true })], ["inspector", "contrarian", "strategist"]);
  assertEquals([...mapSeatsForChunk({ smoke: false, source: "paste", chunkPaths: ["pasted-code"], strategist: true })], ["inspector", "contrarian", "strategist"]);
  assertEquals([...mapSeatsForChunk({ smoke: false, source: "paste", chunkPaths: ["pasted-code"], strategist: false })], ["inspector", "contrarian"]);
  assertEquals([...mapSeatsForChunk({ smoke: false, source: "github", chunkPaths: ui, strategist: false })], ["inspector", "contrarian"]);
  // Smoke: inspector alone, whatever the chunk holds.
  assertEquals([...mapSeatsForChunk({ smoke: true, source: "github", chunkPaths: ui, strategist: true })], ["inspector"]);

  assertEquals(strategistInScope(null), true, "non-import projects keep the strategist");
  assertEquals(strategistInScope(deriveImportWorkflow(["code_audit"])), false, "audit-only import");
  assertEquals(strategistInScope(deriveImportWorkflow(["code_audit", "design_review"])), true);
  assertEquals(strategistInScope(deriveImportWorkflow(["code_audit", "improvements"])), true);
});

Deno.test("buildAuditMapRows: deterministic seat rows per chunk; backend chunk gets two seats, UI chunk three", () => {
  const rows = rowsFor();
  const keys = rows.map((r) => String(r.step_key));
  assertEquals(keys.filter((k) => k.endsWith("_c1")), ["audit_inspector_c1", "audit_contrarian_c1"]);
  const last = packed.rendered.length;
  assertEquals(keys.filter((k) => k.endsWith(`_c${last}`)), [`audit_inspector_c${last}`, `audit_contrarian_c${last}`, `audit_strategist_c${last}`]);
  // Same input, same rows.
  assertEquals(rowsFor().map((r) => r.step_key), keys);
  // Audit-only import: no strategist anywhere.
  assert(rowsFor({ strategist: false }).every((r) => r.seat !== "strategist"));
});

Deno.test("smoke audit keeps working with the new selection: one chunk, inspector only, still a real user message", () => {
  const rows = rowsFor({ chunks: packed.rendered.slice(0, 1), chunkPaths: packed.paths.slice(0, 1), smoke: true });
  assertEquals(rows.map((r) => r.step_key), ["audit_inspector"]);
  const user = userOf(rows[0]);
  assert(user.includes("\nCODE\n") && user.includes("FINAL A-Z AUDIT"));
  assert(!user.includes("CHUNK 1 OF"), "single-chunk runs carry no chunk note");
});
