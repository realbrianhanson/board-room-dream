// deno-lint-ignore-file no-explicit-any
// The JIT Prompt Compiler.
//
// A batch's prompt_md was written at plan-lock time against a codebase that
// did not exist yet. By the time the student reaches Batch 5, Lovable has
// renamed components, chosen its own table names, and half-built features —
// the original prompt describes an app that is gone. This function recompiles
// the active batch against reality: the live repo, the student's own outcome
// reports, and any open audit findings. The Chair emits a fresh, single-
// concern Lovable prompt that references the code that ACTUALLY exists.
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const MAX_PASTE_BYTES = 200 * 1024;

function j(status: number, body: any) {
  return new Response(JSON.stringify(body), {
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

// What the student reported about earlier batches (and this one, if a first
// attempt was already filed) — the ground truth about what Lovable did.
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

const SHAPE = `Return ONLY valid JSON:
{
  "status": "ready" | "already_done" | "blocked",
  "compiled_prompt_md": "the fresh Lovable prompt (REQUIRED and non-empty when status is 'ready'; empty string otherwise)",
  "rationale": "one paragraph: what you changed vs the original and why",
  "drift_notes": [ "specific ways the live code diverged from what the plan assumed — names, missing pieces, extra files" ]
}`;

function validate(parsed: any): string | null {
  if (!parsed || typeof parsed !== "object") return "Not a JSON object.";
  if (!["ready", "already_done", "blocked"].includes(parsed.status)) return "Missing/invalid status.";
  if (parsed.status === "ready" && (typeof parsed.compiled_prompt_md !== "string" || !parsed.compiled_prompt_md.trim())) {
    return "status 'ready' requires a non-empty compiled_prompt_md.";
  }
  if (typeof parsed.rationale !== "string") return "Missing rationale.";
  if (!Array.isArray(parsed.drift_notes)) return "Missing drift_notes array.";
  return null;
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
        maxFiles: 30,
        maxFileBytes: 100 * 1024,
        maxTotalBytes: 400 * 1024,
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
    if (!pastedCode.trim()) return j(400, { error: "Empty pasted code." });
    codePayload = fitPasted(pastedCode);
    filesAnalyzed = 1;
  }

  const [plan, designBrief, outcomes, findings, manual, { count: totalBatches }] = await Promise.all([
    loadPlan(admin, batch.project_id),
    loadDesignBrief(admin, batch.project_id),
    loadOutcomes(admin, batch.project_id, Number(batch.batch_no)),
    loadOpenFindings(admin, batch.project_id),
    loadFieldManual(admin),
    admin.from("batches").select("id", { count: "exact", head: true }).eq("project_id", batch.project_id),
  ]);

  const outcomesBlock = outcomes.length
    ? outcomes.map((o: any) => `--- Batch ${o.batch_no} "${o.title}" [${o.status}] ---\n${String(o.outcome_md).trim()}`).join("\n\n")
    : "(the student has not reported any build outcomes yet)";
  const findingsBlock = findings.length
    ? findings.map((f: any) => `- [${f.severity}] ${f.title}${f.file_path ? ` (${f.file_path})` : ""}: ${String(f.description ?? "").slice(0, 300)}`).join("\n")
    : "(no open findings)";
  const treeBlock = fileTree.length ? `\n\nREPO FILE TREE (orientation)\n${fileTree.slice(0, 200).join("\n")}` : "";
  const featuresBlock = Array.isArray(plan?.features) && plan!.features.length
    ? plan!.features.map((f: any) => `- [${f.priority}] ${f.name}: ${f.description}`).join("\n")
    : "(none listed)";

  const system = `You are the Chair, compiling the NEXT build prompt for a non-technical founder's Lovable project. You do not write a plan from scratch — you take one roadmap batch and re-express it against the code that now actually exists.

${manual}

Your inputs: the batch's ORIGINAL intent (written before any code existed), the LIVE code, the student's own reports of what Lovable did, and any open audit findings. Reconcile them:
- Reference the REAL names in the live code (routes, components, tables, columns). Never invent a name the plan guessed if the code chose a different one — use the code's name and note the drift.
- DROP anything the batch intended that the live code already implements correctly. Do not ask Lovable to rebuild what exists.
- ADD anything the outcomes or findings reveal this batch must now also handle (a rename to absorb, a half-built piece to finish, a fix to fold in) — but stay within this batch's single concern; do not pull in later batches' scope.
- Keep the batch skeleton: numbered items, click-only acceptance checks, "Keep everything else identical.", "Typecheck when done." (code batches only).

Decide a status:
- "ready": emit compiled_prompt_md, a fresh full prompt grounded in the live code.
- "already_done": the live code already satisfies this batch's intent — compiled_prompt_md empty, explain in rationale so the student can mark it passed.
- "blocked": a prerequisite the batch depends on is missing from the code — compiled_prompt_md empty, rationale names exactly what must exist first.

${SHAPE}

Write compiled_prompt_md at FULL length — never compress it because it is inside a JSON string.`;

  const user = `BATCH ${batch.batch_no} OF ${totalBatches ?? "?"} · channel ${batch.channel}

ORIGINAL BATCH INTENT (roadmap prompt, written before code existed)
${batch.prompt_md}

LOCKED PLAN
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

LIVE CODE (current repo state)${treeBlock}
${codePayload}

Compile this batch now. Produce your JSON.`;

  // One structured re-prompt on invalid output, mirroring the orchestrator.
  let messages: any[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let parsed: any = null;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    try {
      const res = await callSeat(userId, "chair", messages, {
        json: true,
        temperature: 0.3,
        reasoningEffort: "high",
        projectId: batch.project_id,
      });
      let candidate: any = null;
      try { candidate = JSON.parse(res.content); } catch { candidate = null; }
      const err = candidate ? validate(candidate) : "Response was not parseable JSON.";
      if (!err) { parsed = candidate; break; }
      messages = [
        ...messages,
        { role: "assistant", content: res.content },
        { role: "user", content: `Your previous response failed validation: ${err}\nReturn ONLY the required JSON object, no prose, no code fences.` },
      ];
    } catch (e) {
      if (e instanceof NoUserKey) return j(200, { status: "no_key" });
      if (e instanceof DailyCapExceeded) return j(402, { error: "Daily spend cap reached — try again after 00:00 UTC or raise the cap." });
      if (e instanceof SeatUnavailable) return j(500, { error: (e as Error).message });
      // Retry once on a transient OpenRouter error (rate limit / upstream 5xx)
      // before surfacing a 500 — matches validate-intake and the orchestrator.
      const status = (e as any)?.status ?? 0;
      if (attempt < 2 && (status === 429 || status >= 500)) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      return j(502, { error: "The compiler hit an upstream error. Try again in a moment." });
    }
  }

  if (!parsed) return j(502, { error: "The Chair couldn't return a clean compile. Try again in a moment." });

  const compileMeta = {
    status: parsed.status,
    head_sha: headSha,
    files_analyzed: filesAnalyzed,
    source,
    based_on: { outcomes: outcomes.length, findings: findings.length },
    drift_notes: Array.isArray(parsed.drift_notes) ? parsed.drift_notes : [],
    rationale: String(parsed.rationale ?? ""),
  };

  // Only persist a compiled prompt when one was produced. already_done /
  // blocked results still record the meta so the UI can explain them.
  await admin
    .from("batches")
    .update({
      compiled_prompt_md: parsed.status === "ready" ? String(parsed.compiled_prompt_md) : null,
      compiled_at: new Date().toISOString(),
      compile_meta: compileMeta,
    })
    .eq("id", batch.id);

  return j(200, {
    status: parsed.status,
    compiled_prompt_md: parsed.status === "ready" ? String(parsed.compiled_prompt_md) : "",
    rationale: String(parsed.rationale ?? ""),
    drift_notes: compileMeta.drift_notes,
    meta: { head_sha: headSha, files_analyzed: filesAnalyzed, source },
  });
});
