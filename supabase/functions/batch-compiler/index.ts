// deno-lint-ignore-file no-explicit-any
// The JIT Prompt Compiler — F1 authority repair.
//
// A batch's original prompt_md was written at plan-lock time against a
// codebase that did not yet exist. This function recompiles the CURRENT
// batch row (authoritative for scope + sequence) against the live repo
// (authoritative for reality), the student's outcome reports, and any open
// audit findings. It never substitutes an older plan's same-number batch,
// and it emits an evidence-backed, deterministic contract the UI can trust.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  adminClient,
  callSeat,
  DailyCapExceeded,
  NoUserKey,
  SeatUnavailable,
} from "../_shared/openrouter-proxy.ts";
import { assembleFromGithub, fetchTargetMigrations, formatFiles, ghToken, redactSecrets } from "../_shared/github-payload.ts";
import { detectStackFromRepo, loadFieldManual, renderStackBlock } from "../_shared/lovable-field-manual.ts";
import { injectOwnerAuthority, loadOwnerAuthority, OWNER_AUTHORITY_RULES } from "../_shared/owner-authority.ts";
import { batchAuthorityError, shapeError, type Parsed } from "./validators.ts";
import {
  batchTouchesSchema,
  decideLedgerAuthority,
  MIGRATION_PROVENANCE_MAX_ENTRIES,
  parseMigrationsToInventory,
  renderTargetInventory,
  toCollisionSet,
  type ProvenanceEntry,
  type TargetSchemaInventory,
} from "../_shared/target-schema-inventory.ts";

const BUILD_VERSION = "2026-07-30.target-schema-ledger.r2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const MAX_PASTE_BYTES = 200 * 1024;

function j(status: number, body: any) {
  return new Response(JSON.stringify({ build_version: BUILD_VERSION, ...body }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fitPasted(text: string): string {
  const t = redactSecrets(String(text ?? ""));
  return t.length > MAX_PASTE_BYTES ? t.slice(0, MAX_PASTE_BYTES) + "\n\n[TRUNCATED]" : t;
}

async function loadPlan(admin: any, projectId: string) {
  const { data } = await admin
    .from("plan_versions")
    .select("content_md, prd_md, features, source_run_id")
    .eq("project_id", projectId)
    .eq("kind", "plan")
    .eq("is_build_safe", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}


// Assemble the compiler's owner-authored founder_notes pool. We pull notes
// ONLY from runs deterministically relevant to THIS batch:
//   1. plan_versions.source_run_id — the run that produced the locked plan.
//   2. The latest boardroom_runs where kind='batches' AND status IN terminal
//      successful set ('consensus','chair_ruled') AND created_at <= this
//      batch's created_at. A failed/running/future unrelated run is ignored.
// All owner-authored notes are concatenated into a SINGLE allowed source
// labeled "founder_notes", so the existing marker grammar
// [OWNER-AUTHORIZED: source="founder_notes" quote="..."] keeps working.
async function loadRelevantFounderNotes(
  admin: any,
  projectId: string,
  planSourceRunId: string | null,
  batchCreatedAt: string | null,
): Promise<Array<{ source: string; text: string }>> {
  const runIds = new Set<string>();
  if (planSourceRunId) runIds.add(planSourceRunId);
  try {
    let q = admin
      .from("boardroom_runs")
      .select("id, created_at")
      .eq("project_id", projectId)
      .eq("kind", "batches")
      .in("status", ["consensus", "chair_ruled"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (batchCreatedAt) q = q.lte("created_at", batchCreatedAt);
    const { data: latest } = await q.maybeSingle();
    if (latest?.id) runIds.add(latest.id);
  } catch { /* ignore */ }
  if (!runIds.size) return [];
  const combined: string[] = [];
  try {
    const { data: runs } = await admin
      .from("boardroom_runs")
      .select("id, founder_notes")
      .in("id", Array.from(runIds));
    for (const r of runs ?? []) {
      const t = String(r?.founder_notes ?? "").trim();
      if (t && !combined.includes(t)) combined.push(t);
    }
  } catch { /* ignore */ }
  if (!combined.length) return [];
  // Single combined authority block, keyed as "founder_notes" so a marker
  // source="founder_notes" quote="…" is verbatim-checked against all
  // relevant notes at once. No namespaced grammar change required.
  return [{ source: "founder_notes", text: combined.join("\n\n") }];
}


async function loadDesignBrief(admin: any, projectId: string): Promise<string | null> {
  const { data } = await admin
    .from("plan_versions")
    .select("content_md")
    .eq("project_id", projectId)
    .eq("kind", "design")
    .eq("is_build_safe", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.content_md ?? null;
}


async function loadOutcomes(admin: any, projectId: string, uptoBatchNo: number) {
  const { data } = await admin
    .from("batches")
    .select("batch_no, title, channel, status, outcome_md")
    .eq("project_id", projectId)
    .not("outcome_md", "is", null)
    .lte("batch_no", uptoBatchNo)
    .order("batch_no", { ascending: true });
  return (data ?? []).filter((b: any) => String(b.outcome_md ?? "").trim());
}

async function loadOpenFindings(admin: any, projectId: string) {
  const { data: audits } = await admin
    .from("audits")
    .select("id")
    .eq("project_id", projectId);
  const auditIds = (audits ?? []).map((a: any) => a.id);
  if (!auditIds.length) return [];
  const { data } = await admin
    .from("audit_findings")
    .select("severity, title, file_path, description")
    .in("audit_id", auditIds)
    .in("status", ["open", "fix_drafted"])
    .order("severity", { ascending: true })
    .limit(30);
  return data ?? [];
}

// Load the current Runway batch sequence so the model sees THIS batch inside
// its actual siblings — not the older locked-plan sequence.
async function loadCurrentBatches(admin: any, projectId: string) {
  const { data } = await admin
    .from("batches")
    .select("batch_no, title, channel, status")
    .eq("project_id", projectId)
    .order("batch_no", { ascending: true });
  return data ?? [];
}

// Target-repo schema authority (see _shared/target-schema-inventory.ts) is
// the sole source of truth. The prior platform-DB inventory helpers were
// removed with the target-schema-authority pass — they always described
// App Blueprint's own database, never the linked project's.




const SHAPE = `Return ONLY valid JSON:
{
  "status": "ready" | "already_done" | "blocked",
  "compiled_prompt_md": "the fresh Lovable prompt (REQUIRED and non-empty when status is 'ready'; empty string otherwise). Its first heading MUST semantically match the CURRENT batch title. Its stated channel MUST match the current batch channel.",
  "compiled_verification_prompt_md": "a SEPARATE follow-up prompt the founder pastes AFTER Lovable finishes the implementation. REQUIRED (250–1500 chars) when status is 'ready' AND channel is 'lovable' or 'supabase'. MUST start EXACTLY with: 'Verify Batch N after implementation. Do not change product scope.' For 'lovable' batches: instruct Lovable to run its built-in browser testing on the exact user flow (clicks / user-observable). For 'supabase' batches, the verification MUST be layer-scope-aware relative to touched_paths: (a) DB-only (touched paths only under supabase/migrations/ or supabase/tests/, no RPC/CREATE FUNCTION in the prompt) → run the exact migration/pgTAP checks plus EXPLICIT positive AND negative RLS cases (owner allowed; anon or cross-tenant blocked); DO NOT require edge-function invocations or Deno edge tests. (b) Edge/RPC batches → directly invoke each affected edge function / RPC with success AND failure/auth cases. (c) Mixed → verify BOTH layers separately. NEVER instruct Lovable to weaken, rewrite, disable, skip, or 'fix tests to match' existing (RLS) policies or insecure behavior. A failing security invariant that this batch is not permitted to change must be REPORTED and STOP for a separate owner-reviewed fix batch; the verifier may only repair harness/setup defects that do not change the stated expected invariant. For 'human' channel: this field MUST be omitted or empty string.",
  "primary_intent_summary": "one sentence: the CURRENT batch's primary intent in your own words, so the caller can confirm scope was preserved.",
  "rationale": "one paragraph: what you changed vs the original and why (REQUIRED, always concrete).",
  "drift_notes": [ "specific ways the live code diverged from the plan's guessed names" ],
  "preserved_intents": [ "each numbered item from the original prompt that still needs doing, restated concisely" ],
  "satisfied_items": [ { "item": "original intent already done", "evidence": "concrete path/table/object that proves it" } ],
  "added_prerequisites": [ { "item": "smallest prerequisite you had to add", "reason": "why the current batch cannot complete without it", "evidence": "path/object grounding the need" } ],
  "touched_paths": [
    { "path": "src/routes/example.tsx", "action": "update" | "create" | "verify", "reason": "why this file must change" }
  ],
  "evidence": [
    { "claim": "one thing the prompt asserts about the live app", "path": "src/routes/example.tsx", "detail": "what in that file grounds the claim" }
  ]
}

RULES (ENFORCED — invalid output is rejected):
- The CURRENT batch row (title / channel / prompt_md / batch_no) is the ONLY sequencing identity. Never adopt scope, title, or numbered items from any OTHER artifact's "Batch N".
- Every "update" or "verify" path MUST appear verbatim in the LIVE REPO CONTRACT file tree.
- Every "create" path MUST NOT already appear in the file tree; if it does, use "update" or "verify", or move the item to satisfied_items.
- Every evidence.path MUST appear verbatim in the file tree.
- Do NOT tell Lovable to CREATE a database object (table/function/policy/index) that already exists in the DB SCHEMA INVENTORY — convert to ALTER/VERIFY or move to satisfied_items.
- Do NOT introduce unrelated features, refactors, CI/GitHub-Actions scripts, package.json scripts, or repo-wide sweeps that are not proved prerequisites of the current batch intent.
- Any shell/SQL command you include MUST actually fail when the check fails. Commands ending in "|| exit 0", "|| true", or "; true" are REJECTED as unsafe non-checks.
- Do NOT use absolute paths, "..", or duplicate the same (path, action) pair.
- The compiled implementation prompt MUST NOT ask Lovable to run browser tests in the SAME prompt as the build — verification belongs in compiled_verification_prompt_md and is pasted as a separate follow-up.
- Never write "React + Vite" as a universal stack rule — use the DETECTED STACK block; unknown/greenfield → say "Lovable's current default stack".
- status "already_done" and "blocked" MAY use empty touched_paths / evidence / preserved_intents, but rationale MUST cite a concrete file/table/route that grounds the decision.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return j(405, { error: "Method not allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return j(401, { error: "Missing or invalid user JWT" });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: uerr } = await userClient.auth.getUser();
  if (uerr || !userData.user) return j(401, { error: "Unauthorized" });
  const userId = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return j(400, { error: "Invalid JSON" }); }
  const batchId = String(body?.batch_id ?? "");
  if (!batchId) return j(400, { error: "Missing batch_id" });
  const source = body?.source === "paste" ? "paste" : "github";
  const pastedCode = source === "paste" ? String(body?.pasted_code ?? "") : null;

  const admin = adminClient();

  const { data: batch } = await admin
    .from("batches")
    .select("id, project_id, user_id, batch_no, title, channel, prompt_md, status, created_at")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch || batch.user_id !== userId) return j(404, { error: "Batch not found" });
  if (batch.channel === "human") return j(400, { error: "Human batches are console steps — nothing to compile." });

  const { data: project } = await admin
    .from("projects")
    .select("id, user_id, github_repo")
    .eq("id", batch.project_id)
    .maybeSingle();
  if (!project || project.user_id !== userId) return j(404, { error: "Project not found" });

  // Assemble the live code — the point of the whole exercise.
  let codePayload = "";
  let headSha: string | null = null;
  let filesAnalyzed = 0;
  let fileTree: string[] = [];
  if (source === "github") {
    if (!project.github_repo) return j(400, { error: "Link a repo, or paste your code, to compile against live code." });
    const ghtok = await ghToken(admin, userId);
    if (!ghtok) return j(400, { error: "GitHub not connected." });
    try {
      const res = await assembleFromGithub(ghtok, project.github_repo, {
        maxFiles: 45,
        maxFileBytes: 100 * 1024,
        maxTotalBytes: 500 * 1024,
        preferKeyFiles: true,
      });
      codePayload = formatFiles(res.files);
      headSha = res.headSha;
      filesAnalyzed = res.files.length;
      fileTree = res.fileTree;
    } catch (e) {
      return j(400, { error: (e as Error).message });
    }
  } else {
    if (!pastedCode || !pastedCode.trim()) return j(400, { error: "Empty pasted code." });
    codePayload = fitPasted(pastedCode);
    filesAnalyzed = 1;
  }

  const [plan, designBrief, outcomes, findings, manual, currentBatches, { count: totalBatches }] = await Promise.all([
    loadPlan(admin, batch.project_id),
    loadDesignBrief(admin, batch.project_id),
    loadOutcomes(admin, batch.project_id, Number(batch.batch_no)),
    loadOpenFindings(admin, batch.project_id),
    loadFieldManual(admin),
    loadCurrentBatches(admin, batch.project_id),
    admin.from("batches").select("id", { count: "exact", head: true }).eq("project_id", batch.project_id),
  ]);

  // TARGET-SCHEMA AUTHORITY (2026-07-29.r1): for GitHub compiles derive a
  // bounded schema inventory from the TARGET repo's own supabase/migrations
  // ledger — never from the App Blueprint platform DB. UI-only batches may
  // proceed with an empty inventory; batches that touch schema fail closed
  // when the ledger is missing or oversized.
  let targetInv: TargetSchemaInventory = { tables: new Set(), functions: new Set(), policies: new Set(), indexes: new Set(), views: new Set(), columns: new Map() };
  let ledgerOk = false;
  let ledgerFileCount = 0;
  let ledgerHeadSha: string | null = null;
  let ledgerTotalBytes = 0;
  let ledgerProvenance: ProvenanceEntry[] = [];
  let targetInvReason: string | null =
    source === "github" ? null : "paste source: target schema inventory not fetched";
  if (source === "github") {
    const ghtok = await ghToken(admin, userId);
    if (!ghtok) return j(400, { error: "GitHub not connected." });
    const ledger = await fetchTargetMigrations(ghtok, project.github_repo!);
    if (ledger.ok) {
      targetInv = parseMigrationsToInventory(ledger.files);
      ledgerOk = true;
      ledgerFileCount = ledger.files.length;
      ledgerHeadSha = ledger.headSha;
      ledgerTotalBytes = ledger.totalBytes;
      ledgerProvenance = ledger.provenance;
    } else {
      targetInvReason = ledger.message;
    }
  }

  const extraFounderNotes = await loadRelevantFounderNotes(
    admin,
    batch.project_id,
    (plan as any)?.source_run_id ?? null,
    (batch as any)?.created_at ?? null,
  );
  const authority = await loadOwnerAuthority(admin, {
    projectId: batch.project_id,
    extraFounderNotes,
  });


  const outcomesBlock = outcomes.length
    ? outcomes.map((o: any) => `--- Batch ${o.batch_no} "${o.title}" [${o.status}] ---\n${String(o.outcome_md).trim()}`).join("\n\n")
    : "(the student has not reported any build outcomes yet)";
  const findingsBlock = findings.length
    ? findings.map((f: any) => `- [${f.severity}] ${f.title}${f.file_path ? ` (${f.file_path})` : ""}: ${String(f.description ?? "").slice(0, 300)}`).join("\n")
    : "(no open findings)";
  const treeBlock = fileTree.length
    ? `\n\nLIVE REPO CONTRACT — the complete file tree below is authoritative for what CURRENTLY exists in this repo. Plan/PRD intent NEVER proves a current path, table, column, secret exposure, or deployed behavior. Only the file tree and file contents do.\n${fileTree.slice(0, 400).join("\n")}`
    : "";
  const featuresBlock = Array.isArray(plan?.features) && plan!.features.length
    ? plan!.features.map((f: any) => `- [${f.priority}] ${f.name}: ${f.description}`).join("\n")
    : "(none listed)";
  const currentBatchesBlock = currentBatches.length
    ? currentBatches.map((b: any) => `${b.batch_no === batch.batch_no ? "→" : " "} Batch ${b.batch_no} "${b.title}" · channel ${b.channel} · ${b.status}`).join("\n")
    : "(no batches yet)";

  // Decide whether this batch's intent depends on the target schema at all.
  const roadmapText = String((batch as any).prompt_md ?? "");
  const schemaTouching = batchTouchesSchema({ channel: String(batch.channel), compiledOrRoadmap: roadmapText });
  const authorityDecision = decideLedgerAuthority({
    source,
    schemaTouching,
    ledgerOk,
    ledgerFileCount,
  });
  const targetInvOk = authorityDecision.targetInvOk;

  // Compact ordered provenance persisted to compile_meta (capped).
  const provenanceKept = ledgerProvenance.slice(0, MIGRATION_PROVENANCE_MAX_ENTRIES);
  const provenanceOmitted = Math.max(0, ledgerProvenance.length - provenanceKept.length);
  const targetMigrationsMeta = ledgerOk
    ? {
        source_commit: ledgerHeadSha,
        files: ledgerFileCount,
        total_bytes: ledgerTotalBytes,
        provenance: provenanceKept,
        provenance_omitted: provenanceOmitted,
      }
    : null;

  // Fail closed only when the batch NEEDS the schema ledger to be safe.
  if (authorityDecision.blocked) {
    const meta = {
      status: "blocked",
      head_sha: headSha,
      files_analyzed: filesAnalyzed,
      source,
      original_batch_no: Number(batch.batch_no),
      original_title: batch.title,
      original_channel: batch.channel,
      reason: "Target-repo schema ledger unavailable for a schema-touching batch",
      target_repo_migrations: targetMigrationsMeta,
      target_repo_migrations_reason: targetInvReason,
      schema_touching_batch: schemaTouching,
      build_version: BUILD_VERSION,
    };
    await admin
      .from("batches")
      .update({ compiled_prompt_md: null, compiled_at: null, compile_meta: meta })
      .eq("id", batch.id);
    return j(503, {
      status: "blocked",
      error: "Cannot compile a schema-touching batch without the target repo's supabase/migrations ledger. Add or restore that folder in the linked GitHub repo and retry — the batch has been reset for recompile.",
      target_repo_migrations_reason: targetInvReason,
      retryable: true,
    });
  }

  const schemaBlock = source === "github" && targetInvOk
    ? `TARGET-REPO SCHEMA INVENTORY (derived from supabase/migrations/*, ${ledgerFileCount} files, ${ledgerTotalBytes} bytes, commit ${ledgerHeadSha ?? "unknown"}):\n${renderTargetInventory(targetInv)}`
    : source === "github"
      ? "(target-repo schema inventory not available — UI-only batch; do NOT assert any target DB object exists or is missing)"
      : "(schema inventory not shown for paste source — assume any database object may already exist and BLOCK on uncertainty rather than emitting a CREATE)";

  const system = `You are the Chair, compiling the NEXT build prompt for a non-technical founder's Lovable project. You do not write a plan from scratch — you take THIS ONE Runway batch (the arrow-marked row in CURRENT RUNWAY SEQUENCE) and re-express it against the code that now actually exists.

${manual}

Authority rules (F1):
- The CURRENT BATCH ROW (title, channel, prompt_md, batch_no) is the ONLY authority for THIS batch's scope and sequence identity. Do NOT swap in the same-number batch from the locked plan; the locked plan may still list an older, longer sequence — it is context and rationale only.
- LIVE REPO / DB SCHEMA INVENTORY are the authority for reality. Convert CREATE → UPDATE/VERIFY when the object already exists. Remove already-satisfied / no-op items and record them in satisfied_items with evidence. Correct exact paths/names to match the live code.
- Add only the smallest prerequisite strictly required to complete THIS batch's intent. Every added item goes in added_prerequisites with reason + evidence.
- Never introduce unrelated features, refactors, CI/GitHub Actions scripts, package.json scripts, or repo-wide sweeps unless they are a proved dependency of the current batch intent.
- Preserve every still-needed numbered item from the original prompt_md in preserved_intents; deliberately omitted items go in satisfied_items with concrete evidence.
- Keep the batch skeleton exactly (ENFORCED):
  * First line: \`Batch ${batch.batch_no} — <title semantically matching the current title>. Numbered items only, no scope creep.\`
  * Then the numbered items, each starting with \`1.\`, \`2.\`, … — no bullets, no free-form paragraphs.
  * For code channels ("lovable" and "supabase"): include an "Acceptance" section with 2–4 layer-appropriate checks (one per line). channel="lovable" → observable preview interactions (clicks, form submits, visible copy/state) plus console/network checks when relevant. channel="supabase" → concrete BACKEND checks (migration applied / schema query result, RLS positive AND negative case, edge-function request/response, DB constraint or trigger behavior, logs, or automated test). Never require preview clicks as the only proof on a supabase-only batch. A mixed UI-wired-to-backend batch MUST include BOTH layers as separate checks.
  * Ends EXACTLY with the two lines:\n    Keep everything else identical.\n    Typecheck when done.
  * Total length 900–3200 characters.
  * NEVER merely echo the original prompt when live reality (repo/schema) contradicts it — rewrite to match the live code.

Ground every claim:
- Every UPDATE/VERIFY path must be listed in touched_paths and exist verbatim in the LIVE REPO CONTRACT file tree.
- Every CREATE path must NOT already exist in the file tree.
- Every asserted fact about how the app currently behaves must have an evidence item citing a real file path and what in that file grounds the claim.
- A filename alone is NEVER proof of an exposed secret. Public Supabase anon/publishable keys are NOT secrets.
- Any shell or SQL command you include MUST fail loudly when its check fails. Reject any command containing "|| exit 0", "|| true", or "; true".
- If the DB SCHEMA INVENTORY lists a table/function/policy the batch wants to CREATE, you MUST convert it to ALTER/VERIFY or move it to satisfied_items with current-column evidence. This applies to bare, schema-qualified, quoted, and backticked identifiers alike, and to narrative phrasings like "Create a Postgres RPC name(...)".

Decide a status:
- "ready": emit compiled_prompt_md that satisfies the skeleton above, with non-empty touched_paths, evidence, and preserved_intents.
- "already_done": the live code already satisfies THIS batch's intent — empty prompt/paths/evidence, rationale cites the concrete files that already implement it; satisfied_items lists each intent with evidence.
- "blocked": a prerequisite the batch depends on is missing — empty prompt/paths/evidence, rationale names exactly what must exist first.

${SHAPE}

Write compiled_prompt_md at FULL length — never compress it because it is inside a JSON string.`;

  const user = `CURRENT BATCH ROW (authoritative for scope + sequence)
- batch_no: ${batch.batch_no}
- title: ${batch.title}
- channel: ${batch.channel}
- status: ${batch.status}

CURRENT RUNWAY SEQUENCE (the ONLY sequence identity — ignore any other artifact's numbering)
${currentBatchesBlock}

ORIGINAL BATCH PROMPT (this batch's intent, written before code existed — preserve each still-needed numbered item)
${batch.prompt_md}

LOCKED PLAN (constraints / rationale only — NEVER substitute its "Batch ${batch.batch_no}" for the current batch above)
${plan?.content_md ?? "(none)"}

PRD
${plan?.prd_md ?? "(none)"}

FEATURES
${featuresBlock}

DESIGN BRIEF
${designBrief ?? "(none)"}

STUDENT'S BUILD REPORTS (what Lovable actually did)
${outcomesBlock}

OPEN AUDIT FINDINGS
${findingsBlock}

DB SCHEMA INVENTORY (authoritative — never CREATE an object listed here)
${schemaBlock}

LIVE CODE (current repo state)${treeBlock}
${codePayload}

${renderStackBlock(detectStackFromRepo({
  fileTree,
  packageJson: source === "github"
    ? (fileTree.includes("package.json") ? (codePayload.match(/=== FILE: package\.json ===([\s\S]*?)(?:=== FILE:|$)/)?.[1] ?? null) : null)
    : (pastedCode ?? null),
  hasLiveRepo: source === "github" ? fileTree.length > 0 : !!pastedCode,
}))}

Compile THIS batch (batch_no=${batch.batch_no}, title="${batch.title}", channel=${batch.channel}) now. Produce your JSON.`;

  const fileTreeSet = new Set(fileTree);
  // Inject the OWNER AUTHORITY rules + compact owner-source block. The
  // deterministic post-validator below runs regardless of what the model
  // returns, so this is defense-in-depth, not the only gate.
  const injected = injectOwnerAuthority(system, user, authority);
  // Bounded cost: one primary call plus at most one structured correction pass.
  let messages: any[] = [
    { role: "system", content: injected.system },
    { role: "user", content: injected.user },
  ];
  let parsed: Parsed | null = null;
  let lastErr: string | null = null;
  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !parsed; attempt++) {
    try {
      const res = await callSeat(userId, "chair", messages, {
        json: true,
        temperature: 0.2,
        reasoningEffort: "medium",
        maxTokens: 8000,
        projectId: batch.project_id,
      });
      let candidate: any = null;
      try { candidate = JSON.parse(res.content); } catch { candidate = null; }
      let err: string | null = candidate ? shapeError(candidate) : "Response was not parseable JSON.";
      if (!err && candidate) {
        err = batchAuthorityError(candidate as Parsed, {
          title: batch.title,
          channel: batch.channel,
          batch_no: Number(batch.batch_no),
        }, fileTreeSet, { source, schemaObjects: toCollisionSet(targetInv), authority });
      }
      if (!err) {
        parsed = candidate as Parsed;
        break;
      }
      lastErr = err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      messages = [
        ...messages,
        { role: "assistant", content: res.content },
        { role: "user", content: `Your previous response failed validation: ${err}\nReturn ONLY the corrected JSON object, no prose, no code fences. Remember: the CURRENT batch row is the only sequencing identity — never substitute another artifact's "Batch ${batch.batch_no}" for it. Every UPDATE/VERIFY path must exist in the LIVE REPO CONTRACT; every CREATE path must NOT exist and must not be an existing DB object; no failure-swallowing commands ("|| exit 0", "|| true", "; true"); no unrelated CI / package.json script scope.` },
      ];
    } catch (e) {
      if (e instanceof NoUserKey) return j(200, { status: "no_key" });
      if (e instanceof DailyCapExceeded) return j(402, { error: "Daily spend cap reached — try again after 00:00 UTC or raise the cap." });
      if (e instanceof SeatUnavailable) return j(500, { error: (e as Error).message });
      return j(502, { error: "The compiler hit an upstream error. Try again in a moment." });
    }
  }

  if (!parsed) {
    // Validation failed after model calls — clear any prior compiled fields so
    // the UI cannot keep showing a stale, unsafe prompt from an earlier build.
    // Persist compile_meta with status='blocked' + build_version + detail for
    // observability. Idempotent even if the row was already null.
    const blockedMeta = {
      status: "blocked",
      head_sha: headSha,
      files_analyzed: filesAnalyzed,
      source,
      original_batch_no: Number(batch.batch_no),
      original_title: batch.title,
      original_channel: batch.channel,
      reason: "compiler_validation_failed",
      validation_detail: lastErr ?? "validation failed",
      build_version: BUILD_VERSION,
      invalidated_at: new Date().toISOString(),
    };
    await admin
      .from("batches")
      .update({
        compiled_prompt_md: null,
        compiled_verification_prompt_md: null,
        compiled_at: null,
        compile_meta: blockedMeta,
      })
      .eq("id", batch.id);
    return j(422, {
      status: "blocked",
      error: "The Chair couldn't produce an evidence-backed compile against the live code.",
      detail: lastErr ?? "validation failed",
      build_version: BUILD_VERSION,
    });
  }


  const compileMeta = {
    status: parsed.status,
    head_sha: headSha,
    files_analyzed: filesAnalyzed,
    source,
    based_on: { outcomes: outcomes.length, findings: findings.length },
    original_batch_no: Number(batch.batch_no),
    original_title: batch.title,
    original_channel: batch.channel,
    primary_intent_summary: parsed.primary_intent_summary,
    preserved_intents: parsed.preserved_intents,
    satisfied_items: parsed.satisfied_items,
    added_prerequisites: parsed.added_prerequisites,
    drift_notes: parsed.drift_notes,
    rationale: parsed.rationale,
    touched_paths: parsed.touched_paths,
    evidence: parsed.evidence,
    target_repo_migrations: targetMigrationsMeta,
    target_inventory_ok: targetInvOk,
    target_inventory_reason: targetInvReason,
    schema_touching_batch: schemaTouching,
    build_version: BUILD_VERSION,
  };

  await admin
    .from("batches")
    .update({
      compiled_prompt_md: parsed.status === "ready" ? parsed.compiled_prompt_md : null,
      compiled_verification_prompt_md:
        parsed.status === "ready" && (batch.channel === "lovable" || batch.channel === "supabase")
          ? (parsed.compiled_verification_prompt_md ?? null)
          : null,
      compiled_at: new Date().toISOString(),
      compile_meta: compileMeta,
    })
    .eq("id", batch.id);

  return j(200, {
    status: parsed.status,
    compiled_prompt_md: parsed.status === "ready" ? parsed.compiled_prompt_md : "",
    compiled_verification_prompt_md:
      parsed.status === "ready" && (batch.channel === "lovable" || batch.channel === "supabase")
        ? (parsed.compiled_verification_prompt_md ?? "")
        : "",
    rationale: parsed.rationale,
    drift_notes: parsed.drift_notes,
    preserved_intents: parsed.preserved_intents,
    satisfied_items: parsed.satisfied_items,
    added_prerequisites: parsed.added_prerequisites,
    primary_intent_summary: parsed.primary_intent_summary,
    touched_paths: parsed.touched_paths,
    evidence: parsed.evidence,
    meta: { head_sha: headSha, files_analyzed: filesAnalyzed, source, original_batch_no: batch.batch_no, original_title: batch.title },
  });
});
