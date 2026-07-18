// deno-lint-ignore-file no-explicit-any
// Assembles the code payload, creates the audit + boardroom_run + parallel steps,
// then kicks the orchestrator. Chair merge + finalization happen in the orchestrator.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptSecret } from "../_shared/crypto.ts";

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

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|mp3|mp4|mov|woff2?|ttf|otf|eot|wasm|bin)$/i;
const LOCK_FILES = /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|deno\.lock)$/i;
const IGNORE_DIR = /(^|\/)(node_modules|dist|build|\.next|\.git|\.turbo|coverage)(\/|$)/;

const MAX_FILES = 25;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024;
const MAX_PASTE_BYTES = 200 * 1024;

async function ghToken(admin: any, userId: string): Promise<string | null> {
  const { data } = await admin
    .from("api_keys")
    .select("encrypted_key, status")
    .eq("user_id", userId)
    .eq("provider", "github")
    .maybeSingle();
  if (!data || data.status === "invalid") return null;
  return await decryptSecret(data.encrypted_key);
}

async function gh(token: string, path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "boardroom-audit",
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

type FilePayload = { path: string; content: string; bytes: number };

async function assembleFromGithub(
  token: string,
  repo: string,
  baseSha: string | null,
): Promise<{ files: FilePayload[]; headSha: string; branch: string; skipped: number }> {
  const repoRes = await gh(token, `/repos/${repo}`);
  if (repoRes.status >= 300) throw new Error(`repo: ${repoRes.body?.message ?? repoRes.status}`);
  const branch = repoRes.body?.default_branch ?? "main";
  const headRes = await gh(token, `/repos/${repo}/commits/${branch}`);
  if (headRes.status >= 300) throw new Error(`head: ${headRes.body?.message ?? headRes.status}`);
  const headSha: string = headRes.body?.sha;

  let candidates: { path: string }[] = [];
  if (baseSha) {
    const cmp = await gh(token, `/repos/${repo}/compare/${baseSha}...${headSha}`);
    if (cmp.status < 300 && Array.isArray(cmp.body?.files)) {
      candidates = cmp.body.files
        .filter((f: any) => f.status !== "removed")
        .map((f: any) => ({ path: f.filename }));
    }
  }
  if (!candidates.length) {
    // Full repo tree, filtered.
    const tree = await gh(token, `/repos/${repo}/git/trees/${headSha}?recursive=1`);
    if (tree.status < 300 && Array.isArray(tree.body?.tree)) {
      candidates = tree.body.tree
        .filter((t: any) => t.type === "blob")
        .map((t: any) => ({ path: t.path }));
    }
  }

  const filtered = candidates.filter(
    (f) => !BINARY_EXT.test(f.path) && !LOCK_FILES.test(f.path) && !IGNORE_DIR.test(f.path),
  );

  const files: FilePayload[] = [];
  let total = 0;
  let skipped = 0;
  for (const f of filtered) {
    if (files.length >= MAX_FILES) { skipped++; continue; }
    const c = await gh(token, `/repos/${repo}/contents/${encodeURI(f.path)}?ref=${headSha}`);
    if (c.status >= 300 || Array.isArray(c.body)) { skipped++; continue; }
    const size: number = c.body?.size ?? 0;
    if (size > MAX_FILE_BYTES) { skipped++; continue; }
    const content = c.body?.encoding === "base64"
      ? atob(String(c.body?.content ?? "").replace(/\n/g, ""))
      : String(c.body?.content ?? "");
    if (total + content.length > MAX_TOTAL_BYTES) { skipped++; continue; }
    total += content.length;
    files.push({ path: f.path, content, bytes: content.length });
  }
  return { files, headSha, branch, skipped };
}

function formatFiles(files: FilePayload[]): string {
  if (!files.length) return "(no code files were readable)";
  return files
    .map((f) => `\n=== FILE: ${f.path} (${f.bytes} bytes) ===\n${f.content}`)
    .join("\n");
}

function fitPasted(text: string): string {
  const t = String(text ?? "");
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

const SECURITY_CHECKLIST = `SECURITY CHECKLIST (verbatim, must be applied to code):
- Every personal-data table has user_id lineage and owner-scoped RLS; no public policies on personal tables.
- Instructor access ONLY via cohort-scoped security-definer views/policies.
- api_keys: encrypted at rest, NO client-readable RLS ever; used only server-side.
- Edge functions require the owner's JWT and reject the anon key. Cron uses PIPELINE_SECRET.
- No secrets in frontend code, no hardcoded keys.
- Spend caps and model allowlist enforced server-side.
- Storage buckets private, user-scoped paths, signed URLs only.
- Missing optional config never crashes — graceful designed state.`;

function seatPrompt(seat: "inspector" | "contrarian" | "strategist", isFinal: boolean): string {
  const jsonShape = `Return ONLY valid JSON:
{
  "findings": [
    { "severity": "P0"|"P1"|"P2"|"P3", "file_path": "path/or/empty", "title": "short", "description": "what and why, one paragraph" }
  ]
}
No findings = { "findings": [] }.`;
  if (seat === "inspector") {
    return `You are the Inspector. Read the code against the batch contract and PRD. Flag: contract misses (batch prompt says X, code does Y or is missing), broken imports, unreferenced code, incoherent naming, dead flows. ${isFinal ? "This is a full A-Z audit — check that the whole app coheres, not just one batch." : ""}
${jsonShape}`;
  }
  if (seat === "contrarian") {
    return `You are the Contrarian. Attack the code with the security checklist. Every violation is at minimum P1; auth/RLS/secret leaks are P0.

${SECURITY_CHECKLIST}

${jsonShape}`;
  }
  return `You are the Strategist. Review UX, copy, and flows against the design brief and plan. Flag: generic AI-SaaS drift, missing empty/error/loading states, broken user journeys, ugly or off-brand copy, off-token colors/fonts.
${jsonShape}`;
}

async function insertAuditSteps(
  admin: any,
  run: any,
  payload: string,
  batchPrompt: string | null,
  plan: any,
  designBrief: string | null,
  isFinal: boolean,
) {
  const contract = isFinal
    ? `FINAL A-Z AUDIT — verify the whole app against the plan + PRD.`
    : `BATCH CONTRACT (what this batch was supposed to do):\n\n${batchPrompt}`;
  const user = `${contract}

PRD
${plan?.prd_md ?? "(none)"}

PLAN
${plan?.content_md ?? "(none)"}

DESIGN BRIEF
${designBrief ?? "(none)"}

CODE
${payload}

Produce your JSON now.`;

  const rows = (["inspector", "contrarian", "strategist"] as const).map((seat) => ({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `audit_${seat}`,
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
  }));
  await admin.from("run_steps").insert(rows);
}

function fireOrchestrator() {
  try {
    fetch(ORCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pipeline-secret": PIPELINE_SECRET },
      body: JSON.stringify({}),
    }).catch(() => {});
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

  const plan = await loadLockedPlan(admin, project.id);
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
  if (batchId) {
    const { data: b } = await admin.from("batches").select("prompt_md").eq("id", batchId).maybeSingle();
    batchPrompt = b?.prompt_md ?? null;
  }

  let payload = "";
  let filesAnalyzed = 0;
  let headSha: string | null = null;
  let baseSha: string | null = null;

  if (source === "github") {
    if (!project.github_repo) return { error: "No GitHub repo linked" as const };
    const token = await ghToken(admin, userId);
    if (!token) return { error: "GitHub not connected" as const };
    baseSha = isFinal ? null : await priorHeadSha(admin, project.id);
    try {
      const res = await assembleFromGithub(token, project.github_repo, baseSha);
      payload = formatFiles(res.files);
      filesAnalyzed = res.files.length;
      headSha = res.headSha;
    } catch (e) {
      return { error: (e as Error).message };
    }
  } else {
    if (!pastedCode || !pastedCode.trim()) return { error: "Empty pasted code" as const };
    payload = fitPasted(pastedCode);
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

  await insertAuditSteps(admin, run, payload, batchPrompt, plan, designBrief, isFinal);
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
      .select("id, user_id, github_repo")
      .eq("id", project_id)
      .maybeSingle();
    if (!data || data.user_id !== userId) return null;
    return { id: data.id, github_repo: data.github_repo };
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
      // Require all non-final batches passed.
      const { data: batches } = await admin
        .from("batches")
        .select("id, status")
        .eq("project_id", projectId);
      if (!batches?.length) return j(400, { error: "No batches to audit" });
      const unresolved = batches.filter((b: any) => !["passed", "skipped"].includes(b.status));
      if (unresolved.length) return j(400, { error: "All batches must be passed or skipped before the A-Z audit" });

      const res = await beginAudit({
        admin, userId, project, batchId: null,
        kind: "final_az", loopNo: 1, source, pastedCode, budget: 8.0,
      });
      if ("error" in res) return j(400, { error: res.error });
      return j(200, res);
    }

    return j(400, { error: "Unknown action" });
  } catch (e) {
    return j(500, { error: (e as Error).message });
  }
});
