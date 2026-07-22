// deno-lint-ignore-file no-explicit-any
// The JIT Prompt Compiler.
//
// A batch's prompt_md was written at plan-lock time against a codebase that
// did not exist yet. By the time the student reaches Batch 5, Lovable has
// renamed components, chosen its own table names, and half-built features —
// the original prompt describes an app that is gone. This function recompiles
// the active batch against reality: the live repo, the student's own outcome
// reports, and any open audit findings. The Chair emits a fresh, single-
// concern Lovable prompt that references the code that ACTUALLY exists AND
// backs every claim with an evidence path from the current fileTree.
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

const BUILD_VERSION = "2026-07-22.compile-gate.1";

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

const SHAPE = `Return ONLY valid JSON:
{
  "status": "ready" | "already_done" | "blocked",
  "compiled_prompt_md": "the fresh Lovable prompt (REQUIRED and non-empty when status is 'ready'; empty string otherwise)",
  "rationale": "one paragraph: what you changed vs the original and why (REQUIRED, always concrete)",
  "drift_notes": [ "specific ways the live code diverged from the plan's guessed names" ],
  "touched_paths": [
    { "path": "src/routes/example.tsx", "action": "update" | "create", "reason": "why this file must change" }
  ],
  "evidence": [
    { "claim": "one thing the prompt asserts about the live app", "path": "src/routes/example.tsx", "detail": "what in that file grounds the claim" }
  ]
}

RULES for touched_paths and evidence (ENFORCED — invalid output is rejected):
- status "ready" MUST include at least one touched_path and at least one evidence item.
- Every "update" path MUST appear verbatim in the LIVE REPO CONTRACT file tree.
- Every "create" path MUST NOT already appear in the file tree; new paths must be justified in reason.
- Every evidence.path MUST appear verbatim in the file tree.
- Do NOT use absolute paths, "..", or duplicate the same (path, action) pair.
- status "already_done" and "blocked" MAY use empty touched_paths and evidence arrays, but rationale MUST cite a concrete file/table/route that grounds the decision.`;

type Parsed = {
  status: "ready" | "already_done" | "blocked";
  compiled_prompt_md: string;
  rationale: string;
  drift_notes: string[];
  touched_paths: { path: string; action: "update" | "create"; reason: string }[];
  evidence: { claim: string; path: string; detail: string }[];
};

// Shape validation — does the model even return the right JSON keys?
function shapeError(p: any): string | null {
  if (!p || typeof p !== "object") return "Not a JSON object.";
  if (!["ready", "already_done", "blocked"].includes(p.status)) return "Missing/invalid status.";
  if (typeof p.rationale !== "string" || !p.rationale.trim()) return "Missing rationale.";
  if (!Array.isArray(p.drift_notes)) return "Missing drift_notes array.";
  if (!Array.isArray(p.touched_paths)) return "Missing touched_paths array.";
  if (!Array.isArray(p.evidence)) return "Missing evidence array.";
  for (const t of p.touched_paths) {
    if (!t || typeof t.path !== "string" || !t.path.trim()) return "touched_paths entries need a non-empty path.";
    if (!["update", "create"].includes(t.action)) return "touched_paths.action must be 'update' or 'create'.";
    if (typeof t.reason !== "string" || !t.reason.trim()) return "touched_paths entries need a non-empty reason.";
  }
  for (const e of p.evidence) {
    if (!e || typeof e.claim !== "string" || !e.claim.trim()) return "evidence entries need a non-empty claim.";
    if (typeof e.path !== "string" || !e.path.trim()) return "evidence entries need a non-empty path.";
    if (typeof e.detail !== "string" || !e.detail.trim()) return "evidence entries need a non-empty detail.";
  }
  if (p.status === "ready") {
    if (typeof p.compiled_prompt_md !== "string" || !p.compiled_prompt_md.trim()) {
      return "status 'ready' requires a non-empty compiled_prompt_md.";
    }
    if (p.touched_paths.length < 1) return "status 'ready' requires at least one touched_path.";
    if (p.evidence.length < 1) return "status 'ready' requires at least one evidence item.";
  }
  return null;
}

// Deterministic validation against the actual repo. Called only for GitHub-
// sourced compiles where fileTree is authoritative; skipped for pasted code
// where we cannot prove the negative.
function repoError(p: Parsed, fileTreeSet: Set<string>): string | null {
  const badPath = (path: string) => path.startsWith("/") || path.includes("..") || path.includes("\\");
  const seen = new Set<string>();
  for (const t of p.touched_paths) {
    if (badPath(t.path)) return `touched_paths path "${t.path}" is not a repo-relative POSIX path.`;
    const key = `${t.action}:${t.path}`;
    if (seen.has(key)) return `touched_paths has a duplicate entry for ${key}.`;
    seen.add(key);
    // Reject the same path being both created and updated.
    const other = t.action === "update" ? `create:${t.path}` : `update:${t.path}`;
    if (seen.has(other)) return `touched_paths conflicts on "${t.path}" (both create and update).`;
    if (t.action === "update" && !fileTreeSet.has(t.path)) {
      return `touched_paths update target "${t.path}" does not exist in the live repo.`;
    }
    if (t.action === "create" && fileTreeSet.has(t.path)) {
      return `touched_paths create target "${t.path}" already exists in the live repo — use action "update" or drop it.`;
    }
  }
  for (const e of p.evidence) {
    if (badPath(e.path)) return `evidence path "${e.path}" is not a repo-relative POSIX path.`;
    if (!fileTreeSet.has(e.path)) return `evidence path "${e.path}" does not exist in the live repo.`;
  }
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
  const treeBlock = fileTree.length
    ? `\n\nLIVE REPO CONTRACT — the complete file tree below is authoritative for what CURRENTLY exists in this repo. Plan/PRD intent NEVER proves a current path, table, column, secret exposure, or deployed behavior. Only the file tree and file contents do.\n${fileTree.slice(0, 400).join("\n")}`
    : "";
  const featuresBlock = Array.isArray(plan?.features) && plan!.features.length
    ? plan!.features.map((f: any) => `- [${f.priority}] ${f.name}: ${f.description}`).join("\n")
    : "(none listed)";

  const system = `You are the Chair, compiling the NEXT build prompt for a non-technical founder's Lovable project. You do not write a plan from scratch — you take one roadmap batch and re-express it against the code that now actually exists.

${manual}

Your inputs: the batch's ORIGINAL intent (written before any code existed), the LIVE REPO CONTRACT (complete file tree + a sample of key files), the student's own reports of what Lovable did, and any open audit findings. Reconcile them:
- Reference the REAL names in the live code (routes, components, tables, columns). Never invent a name the plan guessed if the code chose a different one — use the code's name and note the drift.
- DROP anything the batch intended that the live code already implements correctly.
- ADD anything the outcomes or findings reveal this batch must now also handle (a rename to absorb, a half-built piece to finish, a fix to fold in) — but stay within this batch's single concern; do not pull in later batches' scope.
- Keep the batch skeleton: numbered items, click-only acceptance checks, "Keep everything else identical.", "Typecheck when done." (code batches only).

Ground every claim:
- Every file you tell Lovable to UPDATE must be listed in touched_paths with action "update" and must exist verbatim in the LIVE REPO CONTRACT file tree.
- Every file you tell Lovable to CREATE must be listed with action "create" and must NOT already exist in the file tree; explain in reason why the new path is needed.
- Every asserted fact about how the app currently behaves must have an evidence item citing a real file path from the tree and what in that file grounds the claim.
- Database changes must name the existing migration file or generated type file used as evidence, or be treated as insufficiently evidenced and BLOCKED.
- A filename alone is NEVER proof of an exposed secret. Public Supabase anon/publishable keys are NOT secrets.

Decide a status:
- "ready": emit compiled_prompt_md plus non-empty touched_paths and evidence.
- "already_done": the live code already satisfies this batch's intent — empty prompt/paths/evidence, rationale cites the concrete files that already implement it.
- "blocked": a prerequisite the batch depends on is missing — empty prompt/paths/evidence, rationale names exactly what must exist first.

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
      if (!err && candidate && candidate.status === "ready" && source === "github") {
        err = repoError(candidate as Parsed, fileTreeSet);
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
        { role: "user", content: `Your previous response failed validation: ${err}\nReturn ONLY the corrected JSON object, no prose, no code fences. Every update path must exist in the LIVE REPO CONTRACT; every create path must NOT exist; every evidence path must exist.` },
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
    drift_notes: parsed.drift_notes,
    rationale: parsed.rationale,
    touched_paths: parsed.touched_paths,
    evidence: parsed.evidence,
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
    touched_paths: parsed.touched_paths,
    evidence: parsed.evidence,
    meta: { head_sha: headSha, files_analyzed: filesAnalyzed, source },
  });
});
