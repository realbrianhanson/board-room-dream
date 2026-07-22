// Deterministic tests for final-audit contract selection.
// Run: cd supabase/functions && deno test _shared/audit-contract.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildImplementedBatchesContext,
  type ContractBatch,
  MAX_EXTRA_CONTRACT_CHARS,
  renderContractSection,
  resolveAuditContractMode,
  resolveFinalAuditContract,
  selectImplementedBatches,
  UNBUILT_LEAK_SENTINELS,
} from "./audit-contract.ts";

function b(
  no: number,
  status: string,
  over: Partial<ContractBatch> = {},
): ContractBatch {
  return {
    id: `batch-${no}`,
    batch_no: no,
    title: `Batch ${no} Title`,
    channel: "lovable",
    status,
    prompt_md: `Do work ${no}\nWith numbered steps.`,
    compiled_prompt_md: null,
    ...over,
  };
}

const FUTURE_PLAN = "PLAN: build new dashboard, add billing, redesign nav.";
const FUTURE_PRD = "PRD: dashboard product requirements";
const FUTURE_DESIGN = "DESIGN: brass gradient hero, redesigned nav";
const INTAKE = {
  content_md: "IMPORTED APP intake: today's shipped feature set.",
  prd_md: "IMPORTED APP intake: today's shipped feature set.",
};
const PLAN = { content_md: FUTURE_PLAN, prd_md: FUTURE_PRD };

Deno.test("resolveAuditContractMode: non-import always full_blueprint", () => {
  assertEquals(resolveAuditContractMode(false, []), "full_blueprint");
  assertEquals(
    resolveAuditContractMode(false, [{ status: "pending" }]),
    "full_blueprint",
  );
});

Deno.test("resolveAuditContractMode: import + no batches → current milestone", () => {
  assertEquals(resolveAuditContractMode(true, []), "import_current_milestone");
});

Deno.test("resolveAuditContractMode: import + all passed → full_blueprint", () => {
  assertEquals(
    resolveAuditContractMode(true, [{ status: "passed" }, { status: "passed" }]),
    "full_blueprint",
  );
});

Deno.test("resolveAuditContractMode: import + any non-passed (pending/skipped/built) → milestone", () => {
  for (const s of ["pending", "sent", "built", "auditing", "fix_needed", "skipped"]) {
    assertEquals(
      resolveAuditContractMode(true, [{ status: "passed" }, { status: s }]),
      "import_current_milestone",
      `status ${s} should force milestone`,
    );
  }
});

Deno.test("selectImplementedBatches filters to built/auditing/fix_needed/passed and orders by batch_no", () => {
  const rows = [
    b(3, "passed"),
    b(1, "pending"),
    b(2, "built"),
    b(4, "sent"),
    b(5, "skipped"),
    b(6, "fix_needed"),
    b(7, "auditing"),
  ];
  const sel = selectImplementedBatches(rows).map((r) => `${r.batch_no}:${r.status}`);
  assertEquals(sel, ["2:built", "3:passed", "6:fix_needed", "7:auditing"]);
});

Deno.test("import + all pending: full contract excludes locked plan/design and pending prompt text", () => {
  const batches = [
    b(1, "pending", { prompt_md: "SECRET_PENDING_ONE do future work" }),
    b(2, "pending", { prompt_md: "SECRET_PENDING_TWO more future" }),
  ];
  const c = resolveFinalAuditContract({
    isImport: true,
    batches,
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: INTAKE,
  });
  assertEquals(c.mode, "import_current_milestone");
  assertEquals(c.designBrief, null);
  assertEquals(c.includedBatchIds, []);
  assertEquals(c.extraContext, "");
  const rendered = renderContractSection(c);
  assert(!rendered.includes(FUTURE_PLAN), "leaked future plan");
  assert(!rendered.includes(FUTURE_DESIGN), "leaked future design");
  assert(!rendered.includes("SECRET_PENDING_ONE"), "leaked pending batch prompt");
  assert(!rendered.includes("SECRET_PENDING_TWO"), "leaked pending batch prompt");
  // Sentinel that the milestone request must never carry a locked DESIGN BRIEF header.
  for (const s of UNBUILT_LEAK_SENTINELS) {
    assert(!rendered.includes(s), `leaked sentinel ${JSON.stringify(s)}`);
  }
});

Deno.test("import + partial: only implemented statuses appear; pending/sent/skipped excluded", () => {
  const batches = [
    b(1, "passed", { prompt_md: "IMPL_ONE actionable steps" }),
    b(2, "built", { prompt_md: "IMPL_TWO shipped" }),
    b(3, "pending", { prompt_md: "PENDING_THREE future" }),
    b(4, "sent", { prompt_md: "SENT_FOUR in-flight" }),
    b(5, "skipped", { prompt_md: "SKIPPED_FIVE dropped" }),
    b(6, "fix_needed", { prompt_md: "FIX_SIX needs work" }),
  ];
  const c = resolveFinalAuditContract({
    isImport: true,
    batches,
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: INTAKE,
  });
  assertEquals(c.mode, "import_current_milestone");
  assertEquals(c.includedBatchIds, ["batch-1", "batch-2", "batch-6"]);
  assertStringIncludes(c.extraContext, "IMPL_ONE");
  assertStringIncludes(c.extraContext, "IMPL_TWO");
  assertStringIncludes(c.extraContext, "FIX_SIX");
  assert(!c.extraContext.includes("PENDING_THREE"));
  assert(!c.extraContext.includes("SENT_FOUR"));
  assert(!c.extraContext.includes("SKIPPED_FIVE"));
  const rendered = renderContractSection(c);
  assert(!rendered.includes(FUTURE_PLAN));
  assert(!rendered.includes(FUTURE_DESIGN));
});

Deno.test("import + all passed: full blueprint is used", () => {
  const batches = [b(1, "passed"), b(2, "passed")];
  const c = resolveFinalAuditContract({
    isImport: true,
    batches,
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: INTAKE,
  });
  assertEquals(c.mode, "full_blueprint");
  assertEquals(c.planContentMd, FUTURE_PLAN);
  assertEquals(c.designBrief, FUTURE_DESIGN);
  assertEquals(c.includedBatchIds, []);
  const rendered = renderContractSection(c);
  assertStringIncludes(rendered, FUTURE_PLAN);
  assertStringIncludes(rendered, FUTURE_DESIGN);
});

Deno.test("import + any skipped stays current milestone and excludes skipped", () => {
  const batches = [b(1, "passed"), b(2, "skipped", { prompt_md: "OUT_OF_SCOPE" })];
  const c = resolveFinalAuditContract({
    isImport: true,
    batches,
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: INTAKE,
  });
  assertEquals(c.mode, "import_current_milestone");
  assertEquals(c.includedBatchIds, ["batch-1"]);
  assert(!c.extraContext.includes("OUT_OF_SCOPE"));
});

Deno.test("import + zero batches: intake is base contract, no plan/design", () => {
  const c = resolveFinalAuditContract({
    isImport: true,
    batches: [],
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: INTAKE,
  });
  assertEquals(c.mode, "import_current_milestone");
  assertEquals(c.planContentMd, INTAKE.content_md);
  assertEquals(c.designBrief, null);
  assertEquals(c.includedBatchIds, []);
  const rendered = renderContractSection(c);
  assert(!rendered.includes(FUTURE_PLAN));
  assert(!rendered.includes(FUTURE_DESIGN));
});

Deno.test("non-import: full blueprint with plan and design", () => {
  const c = resolveFinalAuditContract({
    isImport: false,
    batches: [b(1, "passed")],
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: null,
  });
  assertEquals(c.mode, "full_blueprint");
  const rendered = renderContractSection(c);
  assertStringIncludes(rendered, FUTURE_PLAN);
  assertStringIncludes(rendered, FUTURE_PRD);
  assertStringIncludes(rendered, FUTURE_DESIGN);
});

Deno.test("identical PRD/PLAN deduped in rendered section", () => {
  const same = "Identical intake contract text.";
  const rendered = renderContractSection({
    planContentMd: same,
    prdMd: same,
    designBrief: null,
    extraContext: "",
    mode: "import_current_milestone",
  });
  const occurrences = rendered.split(same).length - 1;
  assertEquals(occurrences, 1, "identical PRD/PLAN should render once");
  assertStringIncludes(rendered, "PRD / PLAN (identical)");
  // Milestone mode must not emit a DESIGN BRIEF section at all.
  assert(!rendered.includes("DESIGN BRIEF"));
});

Deno.test("30k bound: enormous implemented batches truncated safely and marked", () => {
  const bigPrompt = "X".repeat(20_000);
  const batches = [
    b(1, "passed", { prompt_md: bigPrompt }),
    b(2, "passed", { prompt_md: bigPrompt }),
    b(3, "passed", { prompt_md: bigPrompt }),
  ];
  const { text, includedIds, truncated } = buildImplementedBatchesContext(batches);
  assert(text.length <= MAX_EXTRA_CONTRACT_CHARS, `extra context ${text.length} > cap`);
  assert(truncated, "expected truncation flag");
  assert(includedIds.length >= 1);
  // Every included batch still carries its identity header, even if body was cut.
  for (const id of includedIds) {
    const no = id.replace("batch-", "");
    assertStringIncludes(text, `Batch ${no}`);
  }
});

Deno.test("unbuilt sentinel strings absent from milestone seat request text", () => {
  const c = resolveFinalAuditContract({
    isImport: true,
    batches: [b(1, "pending", { prompt_md: FUTURE_PLAN })],
    plan: PLAN,
    designBrief: FUTURE_DESIGN,
    importIntake: INTAKE,
  });
  const rendered = renderContractSection(c);
  for (const s of UNBUILT_LEAK_SENTINELS) {
    assert(!rendered.includes(s), `sentinel ${JSON.stringify(s)} leaked into milestone prompt`);
  }
});
