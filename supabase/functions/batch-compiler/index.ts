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
import { assembleFromGithub, formatFiles, ghToken, redactSecrets } from "../_shared/github-payload.ts";
import { loadFieldManual } from "../_shared/lovable-field-manual.ts";
import { batchAuthorityError, shapeError, type Parsed } from "./validators.ts";

const BUILD_VERSION = "2026-07-22.compile-authority.f1b";

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
    .select("content_md, prd_md, features")
    .eq("project_id", projectId)
    .eq("kind", "plan")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function loadDesignBrief(admin: any, projectId: string): Promise<string | null> {
  const { data } = await admin
    .from("plan_versions")
    .select("content_md")
    .eq("project_id", projectId)
    .eq("kind", "design")
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

// Live DB inventory via SECURITY DEFINER RPC (service-role-only). Powers the
// schema authority check: existing objects can never be told to CREATE. This
// path MUST fail closed — an empty/malformed inventory blocks ready compiles.
export type SchemaInventory = {
  tables: { name: string; columns: { name: string; type: string; nullable: boolean; default: string | null }[] }[];
  routines: { name: string; args: string; result: string }[];
  objectsLower: Set<string>;
  ok: boolean;
  reason?: string;
};

async function loadSchemaInventory(admin: any): Promise<SchemaInventory> {
  const empty: SchemaInventory = { tables: [], routines: [], objectsLower: new Set(), ok: false };
  let data: any = null;
  try {
    const res = await admin.rpc("get_compiler_schema_inventory");
    if (res.error) return { ...empty, reason: `RPC error: ${res.error.message}` };
    data = res.data;
  } catch (e) {
    return { ...empty, reason: `RPC threw: ${(e as Error).message}` };
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.tables) || !Array.isArray(data.routines)) {
    return { ...empty, reason: "inventory RPC returned malformed payload" };
  }
  const tables = data.tables.filter((t: any) => t && typeof t.name === "string" && Array.isArray(t.columns)) as SchemaInventory["tables"];
  const routines = data.routines.filter((r: any) => r && typeof r.name === "string") as SchemaInventory["routines"];
  const objectsLower = new Set<string>();
  for (const t of tables) objectsLower.add(t.name.toLowerCase());
  for (const r of routines) objectsLower.add(r.name.toLowerCase());
  // Sanity floor: this app must at minimum have public.batches + public.audit_findings + ≥1 known public routine.
  const has = (n: string) => objectsLower.has(n);
  if (!has("batches") || !has("audit_findings") || routines.length < 1) {
    return { ...empty, tables, routines, objectsLower, reason: `inventory too small (tables=${tables.length}, routines=${routines.length}, has_batches=${has("batches")}, has_audit_findings=${has("audit_findings")})` };
  }
  // Every table must have at least one column.
  for (const t of tables) {
    if (!t.columns.length) return { ...empty, tables, routines, objectsLower, reason: `table "${t.name}" reported zero columns` };
  }
  return { tables, routines, objectsLower, ok: true };
}

function renderInventory(inv: SchemaInventory): string {
  if (!inv.ok) return "(unavailable)";
  const tables = inv.tables.map((t) => {
    const cols = t.columns.slice(0, 24).map((c) => `${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}${c.default ? ` DEFAULT ${String(c.default).slice(0, 40)}` : ""}`).join(", ");
    const more = t.columns.length > 24 ? `, … (+${t.columns.length - 24} more)` : "";
    return `- public.${t.name}(${cols}${more})`;
  }).join("\n");
  const rpcs = inv.routines.map((r) => `- public.${r.name}(${r.args}) → ${r.result}`).join("\n");
  return `TABLES (${inv.tables.length}):\n${tables}\n\nRPCs (${inv.routines.length}):\n${rpcs}`;
}



const SHAPE = `Return ONLY valid JSON:
{
  "status": "ready" | "already_done" | "blocked",
  "compiled_prompt_md": "the fresh Lovable prompt (REQUIRED and non-empty when status is 'ready'; empty string otherwise). Its first heading MUST semantically match the CURRENT batch title. Its stated channel MUST match the current batch channel.",
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
    .select("id, project_id, user_id, batch_no, title, channel, prompt_md, status")
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

  const [plan, designBrief, outcomes, findings, manual, currentBatches, schemaInv, { count: totalBatches }] = await Promise.all([
    loadPlan(admin, batch.project_id),
    loadDesignBrief(admin, batch.project_id),
    loadOutcomes(admin, batch.project_id, Number(batch.batch_no)),
    loadOpenFindings(admin, batch.project_id),
    loadFieldManual(admin),
    loadCurrentBatches(admin, batch.project_id),
    source === "github" ? loadSchemaInventory(admin) : Promise.resolve({ tables: [], routines: [], objectsLower: new Set<string>(), ok: false, reason: "paste source: schema inventory not loaded" } as SchemaInventory),
    admin.from("batches").select("id", { count: "exact", head: true }).eq("project_id", batch.project_id),
  ]);

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
  // Fail closed: GitHub compiles REQUIRE a healthy inventory. Never let a
  // zero/malformed inventory silently degrade to a ready compile.
  if (source === "github" && !schemaInv.ok) {
    const meta = {
      status: "blocked",
      head_sha: headSha,
      files_analyzed: filesAnalyzed,
      source,
      original_batch_no: Number(batch.batch_no),
      original_title: batch.title,
      original_channel: batch.channel,
      reason: "Live database schema inventory unavailable",
      inventory_reason: schemaInv.reason ?? "unknown",
      build_version: BUILD_VERSION,
    };
    await admin
      .from("batches")
      .update({ compiled_prompt_md: null, compiled_at: null, compile_meta: meta })
      .eq("id", batch.id);
    return j(503, {
      status: "blocked",
      error: "Live database schema inventory unavailable — the compiler will not emit a prompt without it. Please retry in a moment; the batch has been reset for recompile.",
      inventory_reason: schemaInv.reason ?? "unknown",
      retryable: true,
    });
  }
  const schemaBlock = source === "github"
    ? renderInventory(schemaInv)
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
  * If channel is "code": include an "Acceptance" section with 2–4 click-only checks (one per line).
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

Compile THIS batch (batch_no=${batch.batch_no}, title="${batch.title}", channel=${batch.channel}) now. Produce your JSON.`;

  const fileTreeSet = new Set(fileTree);
  // Bounded cost: one primary call plus at most one structured correction pass.
  let messages: any[] = [
    { role: "system", content: system },
    { role: "user", content: user },
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
        }, fileTreeSet, { source, schemaObjects: schemaInv.objectsLower });
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
    return j(422, {
      error: "The Chair couldn't produce an evidence-backed compile against the live code.",
      detail: lastErr ?? "validation failed",
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
    schema_inventory_size: { tables: schemaInv.tables.length, rpcs: schemaInv.rpcs.length },
    build_version: BUILD_VERSION,
  };

  await admin
    .from("batches")
    .update({
      compiled_prompt_md: parsed.status === "ready" ? parsed.compiled_prompt_md : null,
      compiled_at: new Date().toISOString(),
      compile_meta: compileMeta,
    })
    .eq("id", batch.id);

  return j(200, {
    status: parsed.status,
    compiled_prompt_md: parsed.status === "ready" ? parsed.compiled_prompt_md : "",
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
