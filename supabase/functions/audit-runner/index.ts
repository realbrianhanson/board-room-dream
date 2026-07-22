// deno-lint-ignore-file no-explicit-any
// Assembles the code payload, creates the audit + boardroom_run + parallel steps,
// then kicks the orchestrator. Chair merge + finalization happen in the orchestrator.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assembleFromGithub, formatFiles, ghToken, redactSecrets } from "../_shared/github-payload.ts";
import { loadFieldManual } from "../_shared/lovable-field-manual.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const PIPELINE_SECRET = Deno.env.get("PIPELINE_SECRET")!;
const ORCH_URL = `${SUPABASE_URL}/functions/v1/boardroom-orchestrator`;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const MAX_PASTE_BYTES = 200 * 1024;

function fitPasted(text: string): string {
  const t = redactSecrets(String(text ?? ""));
  return t.length > MAX_PASTE_BYTES ? t.slice(0, MAX_PASTE_BYTES) + "\n\n[TRUNCATED]" : t;
}

async function loadLockedPlan(admin: any, projectId: string) {
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

async function loadImportContract(admin: any, projectId: string): Promise<{ content_md: string; prd_md: string } | null> {
  const { data } = await admin
    .from("intakes")
    .select("answers")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const a = data?.answers ?? {};
  if (!a?.imported) return null;
  const goals = Array.isArray(a.goals) ? a.goals.join(", ") : "";
  const contract = `IMPORTED APP — the owner already built this and brought it to the board.\n\nDescription: ${a.description ?? ""}\n\nStated goals for the board: ${goals || "(none stated)"}`;
  return { content_md: contract, prd_md: contract };
}


const SECURITY_CHECKLIST = `SECURITY CHECKLIST (verbatim, must be applied to code):
- Every personal-data table has user_id lineage and owner-scoped RLS; no public policies on personal tables.
- Instructor access ONLY via cohort-scoped security-definer views/policies.
- api_keys: encrypted at rest, NO client-readable RLS ever; used only server-side.
- Edge functions require the owner's JWT and reject the anon key. Cron uses PIPELINE_SECRET.
- No secrets in frontend code, no hardcoded keys. A Supabase anon/publishable key in the frontend bundle is NOT a secret leak — only an actual private credential, service-role key, or unredacted high-entropy secret counts.
- Spend caps and model allowlist enforced server-side.
- Storage buckets private, user-scoped paths, signed URLs only.
- Missing optional config never crashes — graceful designed state.`;

import { FINDING_SCHEMA_DOC, CAPS } from "../_shared/audit-findings.ts";

function seatPrompt(seat: "inspector" | "contrarian" | "strategist", isFinal: boolean): string {
  const jsonShape = `Return ONLY valid JSON:
{
  "findings": [ ...max ${CAPS.seatFindingsMax} objects... ]
}
No findings = { "findings": [] }.

${FINDING_SCHEMA_DOC}

Output discipline (the merge step rejects violators):
- MAX ${CAPS.seatFindingsMax} findings. If you have more, keep the highest-severity ones and merge duplicates.
- Total serialized JSON must be <= ${CAPS.seatSerializedMax} characters.
- Keep description and evidence tight — the Chair will read every one of yours plus two other seats'.`;
  if (seat === "inspector") {
    return `You are the Inspector. Read the code against the batch contract and PRD. Flag: contract misses (batch prompt says X, code does Y or is missing), broken imports, unreferenced code, incoherent naming, dead flows. ${isFinal ? "This is a full A-Z audit — check that the whole app coheres, not just one batch." : ""}
${jsonShape}`;
  }
  if (seat === "contrarian") {
    return `You are the Contrarian. Attack the code with the security checklist. Every violation is at minimum P1 IF you can name the exact vulnerable construct with evidence; a filename alone or "this pattern is risky" is not enough — downgrade to P2/P3 or drop it. Auth/RLS/secret leaks with concrete evidence are P0.

${SECURITY_CHECKLIST}

${jsonShape}`;
  }
  return `You are the Strategist. Review UX, copy, and flows against the design brief and plan. Flag: generic AI-SaaS drift, missing empty/error/loading states, broken user journeys, ugly or off-brand copy, off-token colors/fonts.
${jsonShape}`;
}

// Map-reduce: large repos are split into chunks; every seat reviews every
// chunk in its own step, and the Chair merge dedupes across chunk reports.
// Single-chunk audits keep the legacy step keys (audit_<seat>).
const CHUNK_BYTES = 300 * 1024;
const MAX_CHUNKS = 4;

function chunkFiles(files: { path: string; content: string; bytes: number }[]): string[] {
  const chunks: string[] = [];
  let current: typeof files = [];
  let size = 0;
  for (const f of files) {
    if (current.length && size + f.bytes > CHUNK_BYTES && chunks.length < MAX_CHUNKS - 1) {
      chunks.push(formatFiles(current));
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.bytes;
  }
  if (current.length) chunks.push(formatFiles(current));
  return chunks.length ? chunks : [formatFiles([])];
}

async function insertAuditSteps(
  admin: any,
  run: any,
  chunks: string[],
  batchPrompt: string | null,
  plan: any,
  designBrief: string | null,
  isFinal: boolean,
  batchOutcome: string | null,
  fileTree: string[],
) {
  const contract = isFinal
    ? `FINAL A-Z AUDIT — verify the whole app against the plan + PRD.`
    : `BATCH CONTRACT (what this batch was supposed to do):\n\n${batchPrompt}`;
  const outcomeBlock = batchOutcome?.trim()
    ? `\n\nOWNER-REPORTED OUTCOME (what Lovable actually said or did — errors, drift, surprises; investigate every claim):\n${batchOutcome.trim()}`
    : "";
  const manual = await loadFieldManual(admin);
  const multi = chunks.length > 1;
  const rows: any[] = [];
  chunks.forEach((code, idx) => {
    const chunkNote = multi
      ? `\n\nCHUNK ${idx + 1} OF ${chunks.length} — the app is split across parallel review steps. The full file tree (for orientation only):\n${fileTree.join("\n")}\n\nFlag only issues you can verify in THIS chunk's code; do not report files you cannot see as missing.`
      : "";
    const user = `${contract}${outcomeBlock}${chunkNote}

${manual}

PRD
${plan?.prd_md ?? "(none)"}

PLAN
${plan?.content_md ?? "(none)"}

DESIGN BRIEF
${designBrief ?? "(none)"}

CODE
${code}

Produce your JSON now.`;
    for (const seat of ["inspector", "contrarian", "strategist"] as const) {
      rows.push({
        run_id: run.id,
        user_id: run.user_id,
        step_key: multi ? `audit_${seat}_c${idx + 1}` : `audit_${seat}`,
        round: 1,
        seat,
        status: "queued",
        request: {
          json_output: true,
          messages: [
            { role: "system", content: seatPrompt(seat, isFinal) },
            { role: "user", content: user },
          ],
        },
      });
    }
  });
  await admin.from("run_steps").insert(rows);
}

function fireOrchestrator() {
  try {
    // waitUntil keeps the isolate alive to actually dispatch this kick; a bare
    // un-awaited fetch is dropped when the handler returns, leaving the audit
    // queued but never processed.
    const p = fetch(ORCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pipeline-secret": PIPELINE_SECRET },
      body: JSON.stringify({}),
    }).catch(() => {});
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch { /* ignore */ }
}

async function priorHeadSha(admin: any, projectId: string): Promise<string | null> {
  const { data } = await admin
    .from("audits")
    .select("head_sha")
    .eq("project_id", projectId)
    .in("status", ["clean", "findings"])
    .not("head_sha", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.head_sha ?? null;
}

async function beginAudit(params: {
  admin: any;
  userId: string;
  project: { id: string; github_repo: string | null };
  batchId: string | null;
  kind: "batch" | "final_az";
  loopNo: number;
  source: "github" | "paste";
  pastedCode: string | null;
  budget: number;
}) {
  const { admin, userId, project, batchId, kind, loopNo, source, pastedCode, budget } = params;
  const isFinal = kind === "final_az";

  // Short-circuit: if this owner already has an active audit run for this
  // project, return it instead of creating a duplicate audit + run pair.
  // Active = queued | running | paused | paused_budget.
  {
    const { data: activeRuns } = await admin
      .from("boardroom_runs")
      .select("id, status, consensus, created_at")
      .eq("project_id", project.id)
      .eq("user_id", userId)
      .eq("kind", "audit")
      .in("status", ["queued", "running", "paused", "paused_budget"])
      .order("created_at", { ascending: true });
    const winner = (activeRuns ?? [])[0];
    if (winner) {
      const auditId: string | null = winner.consensus?.audit_id ?? null;
      return { existing: true as const, run_id: winner.id, audit_id: auditId, status: winner.status };
    }
  }

  // For imports without a locked plan, substitute the intake description + goals.
  const plan = (await loadLockedPlan(admin, project.id)) ?? (await loadImportContract(admin, project.id));

  const { data: design } = await admin
    .from("plan_versions")
    .select("content_md")
    .eq("project_id", project.id)
    .eq("kind", "design")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const designBrief: string | null = design?.content_md ?? null;

  let batchPrompt: string | null = null;
  let batchOutcome: string | null = null;
  if (batchId) {
    const { data: b } = await admin.from("batches").select("prompt_md, outcome_md").eq("id", batchId).maybeSingle();
    batchPrompt = b?.prompt_md ?? null;
    batchOutcome = b?.outcome_md ?? null;
  }

  let chunks: string[] = [];
  let fileTree: string[] = [];
  let filesAnalyzed = 0;
  let headSha: string | null = null;
  let baseSha: string | null = null;

  if (source === "github") {
    if (!project.github_repo) return { error: "No GitHub repo linked" as const };
    const token = await ghToken(admin, userId);
    if (!token) return { error: "GitHub not connected" as const };
    baseSha = isFinal ? null : await priorHeadSha(admin, project.id);
    try {
      // The A-Z audit reads the whole app, map-reduce style: up to
      // MAX_CHUNKS × CHUNK_BYTES of code split across parallel seat steps.
      // Per-batch audits stay diff-based and single-chunk.
      const res = await assembleFromGithub(
        token,
        project.github_repo,
        isFinal
          ? { baseSha, maxFiles: 200, maxTotalBytes: MAX_CHUNKS * CHUNK_BYTES, preferKeyFiles: true }
          : { baseSha },
      );
      chunks = isFinal ? chunkFiles(res.files) : [formatFiles(res.files)];
      fileTree = res.fileTree;
      filesAnalyzed = res.files.length;
      headSha = res.headSha;
    } catch (e) {
      return { error: (e as Error).message };
    }

  } else {
    if (!pastedCode || !pastedCode.trim()) return { error: "Empty pasted code" as const };
    chunks = [fitPasted(pastedCode)];
    filesAnalyzed = 1;
  }

  const { data: audit, error: auErr } = await admin
    .from("audits")
    .insert({
      project_id: project.id,
      user_id: userId,
      batch_id: batchId,
      kind,
      loop_no: loopNo,
      source,
      base_sha: baseSha,
      head_sha: headSha,
      files_analyzed: filesAnalyzed,
      status: "running",
    })
    .select("*")
    .single();
  if (auErr || !audit) return { error: auErr?.message ?? "Failed to create audit" };

  const { data: run, error: rErr } = await admin
    .from("boardroom_runs")
    .insert({
      project_id: project.id,
      user_id: userId,
      kind: "audit",
      status: "queued",
      round_no: 1,
      loop_no: 0,
      budget_usd: budget,
      consensus: { audit_id: audit.id, audit_kind: kind, files_analyzed: filesAnalyzed },
    })
    .select("*")
    .single();
  if (rErr || !run) {
    await admin.from("audits").update({ status: "failed" }).eq("id", audit.id);
    return { error: rErr?.message ?? "Failed to create run" };
  }

  await admin.from("audits").update({ run_id: run.id }).eq("id", audit.id);

  if (batchId) await admin.from("batches").update({ status: "auditing" }).eq("id", batchId);
  if (isFinal) await admin.from("projects").update({ status: "auditing" }).eq("id", project.id);

  await insertAuditSteps(admin, run, chunks, batchPrompt, plan, designBrief, isFinal, batchOutcome, fileTree);
  fireOrchestrator();
  return { audit_id: audit.id, run_id: run.id };
}

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
  const action: string = body?.action;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function ownProject(project_id: string) {
    const { data } = await admin
      .from("projects")
      .select("id, user_id, github_repo, is_import")
      .eq("id", project_id)
      .maybeSingle();
    if (!data || data.user_id !== userId) return null;
    return { id: data.id, github_repo: data.github_repo, is_import: !!data.is_import };
  }


  try {
    if (action === "start_batch_audit" || action === "start_reaudit") {
      const batchId = String(body?.batch_id ?? "");
      if (!batchId) return j(400, { error: "Missing batch_id" });
      const source = body?.source === "paste" ? "paste" : "github";
      const pastedCode = source === "paste" ? String(body?.pasted_code ?? "") : null;
      const { data: batch } = await admin
        .from("batches")
        .select("id, project_id, user_id, status, batch_no, parent_batch_id")
        .eq("id", batchId)
        .maybeSingle();
      if (!batch || batch.user_id !== userId) return j(404, { error: "Batch not found" });

      const project = await ownProject(batch.project_id);
      if (!project) return j(404, { error: "Project not found" });

      // Determine loop_no.
      let loopNo = 1;
      if (action === "start_reaudit") {
        // Count prior audits for the parent chain (fix batch's parent, or itself).
        const parentId: string = batch.parent_batch_id ?? batch.id;
        const { data: priors } = await admin
          .from("audits")
          .select("id, loop_no")
          .in("batch_id", [parentId, batch.id])
          .order("created_at", { ascending: false });
        const maxLoop = (priors ?? []).reduce((m: number, r: any) => Math.max(m, Number(r.loop_no ?? 1)), 0);
        loopNo = Math.min(maxLoop + 1, 2);
        if (batch.status !== "built") return j(400, { error: "Fix batch must be marked built before re-audit" });
      } else {
        if (batch.status !== "built") return j(400, { error: "Batch must be marked built first" });
      }

      const res = await beginAudit({
        admin, userId, project, batchId,
        kind: "batch", loopNo, source, pastedCode, budget: 5.0,
      });
      if ("error" in res) return j(400, { error: res.error });
      return j(200, res);
    }

    if (action === "start_final_audit") {
      const projectId = String(body?.project_id ?? "");
      const source = body?.source === "paste" ? "paste" : "github";
      const pastedCode = source === "paste" ? String(body?.pasted_code ?? "") : null;
      const project = await ownProject(projectId);
      if (!project) return j(404, { error: "Project not found" });
      const { data: batches } = await admin
        .from("batches")
        .select("id, status")
        .eq("project_id", projectId);
      const noBatches = !batches?.length;
      if (project.is_import && noBatches) {
        // Imports without a build sequence are immediately eligible.
        if (source === "github" && !project.github_repo) {
          return j(400, { error: "Link your repo or paste your code first." });
        }
      } else {
        if (noBatches) return j(400, { error: "No batches to audit" });
        const unresolved = batches!.filter((b: any) => !["passed", "skipped"].includes(b.status));
        if (unresolved.length) return j(400, { error: "All batches must be passed or skipped before the A-Z audit" });
      }

      const res = await beginAudit({
        admin, userId, project, batchId: null,
        kind: "final_az", loopNo: 1, source, pastedCode, budget: 12.0,
      });
      if ("error" in res) return j(400, { error: res.error });
      return j(200, res);
    }


    return j(400, { error: "Unknown action" });
  } catch (e) {
    return j(500, { error: (e as Error).message });
  }
});
