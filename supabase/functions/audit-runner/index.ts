// deno-lint-ignore-file no-explicit-any
// Assembles the code payload, creates the audit + boardroom_run + parallel steps,
// then kicks the orchestrator. Chair merge + finalization happen in the orchestrator.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assembleFromGithub, formatFiles, ghToken, redactSecrets } from "../_shared/github-payload.ts";
import { loadFieldManual } from "../_shared/lovable-field-manual.ts";
import { checkFinalAuditEligibility } from "../_shared/audit-eligibility.ts";
import {
  type ContractBatch,
  renderContractSection,
  type ResolvedContract,
  resolveFinalAuditContract,
} from "../_shared/audit-contract.ts";

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
// 64 KiB × 20 preserves the same ~1.2 MiB total ceiling as before, but every
// individual map request now stays well under the model's context/latency
// budget — the prior 200 KiB × 6 was tipping Gemini and its reserve into hard
// timeouts on final GitHub audits (see run 4462a4ef, ~221k user-message
// characters on the last chunk). chunkFilesFor bin-packs greedily and
// fragments files at UTF-8-safe boundaries when file sizes don't line up with
// the CHUNK_BYTES grid — every rendered chunk stays <= 64 KiB and count <= 20
// whenever total encoded source content <= 1.28 MiB. Fragments retain the
// original file path so audit evidence still cites real paths.
export const CHUNK_BYTES = 64 * 1024;
export const MAX_CHUNKS = 20;
export const MAX_TOTAL_BYTES = CHUNK_BYTES * MAX_CHUNKS;

// Bounded controls for AUDIT MAP/extraction steps (per-chunk seat reviews).
// Map seats are evidence gatherers, not deep synthesis, so a low reasoning
// budget + tight temperature + capped output keeps each of the up-to-60 map
// calls fast and cheap. The Chair MERGE step uses the seat's normal request
// profile and is intentionally NOT constrained here.
export const AUDIT_MAP_TEMPERATURE = 0.2;
export const AUDIT_MAP_REASONING_EFFORT: "low" | "medium" | "high" = "low";
export const AUDIT_MAP_MAX_TOKENS = 2400;

// Returns the largest byte prefix length <= maxBytes that ends on a UTF-8
// codepoint boundary (i.e., the byte at position `cut` is not a continuation
// byte). Returns 0 if no such boundary exists within maxBytes.
export function safeUtf8Cut(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes >= bytes.length) return bytes.length;
  if (maxBytes <= 0) return 0;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xC0) === 0x80) cut--;
  return cut;
}

export function chunkFilesFor(
  files: { path: string; content: string; bytes?: number }[],
): { path: string; content: string; bytes: number }[][] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // Normalize to true encoded bytes; the caller's .bytes hint may be stale.
  const items = files.map((f) => ({ path: f.path, enc: encoder.encode(f.content) }));
  const total = items.reduce((n, i) => n + i.enc.length, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      `audit content total ${total} bytes exceeds ceiling ${MAX_TOTAL_BYTES}`,
    );
  }

  const chunks: { path: string; content: string; bytes: number }[][] = [];
  let current: { path: string; content: string; bytes: number }[] = [];
  let size = 0;

  const seal = () => {
    if (current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
  };

  for (const it of items) {
    let offset = 0;
    while (offset < it.enc.length) {
      let space = CHUNK_BYTES - size;
      if (space <= 0) {
        seal();
        continue;
      }
      const remaining = it.enc.length - offset;
      let take = Math.min(remaining, space);
      if (take < remaining) {
        // Must fragment: cut on a UTF-8-safe boundary within the available space.
        const cut = safeUtf8Cut(it.enc.subarray(offset), take);
        if (cut === 0) {
          if (current.length === 0) {
            throw new Error(
              `cannot fragment ${it.path}: single codepoint exceeds CHUNK_BYTES ${CHUNK_BYTES}`,
            );
          }
          seal();
          continue;
        }
        take = cut;
      }
      const slice = it.enc.subarray(offset, offset + take);
      current.push({ path: it.path, content: decoder.decode(slice), bytes: take });
      size += take;
      offset += take;
      if (size >= CHUNK_BYTES) seal();
    }
  }
  seal();

  if (chunks.length > MAX_CHUNKS) {
    throw new Error(
      `audit chunks (${chunks.length}) exceed MAX_CHUNKS ${MAX_CHUNKS}`,
    );
  }
  return chunks;
}

export function assertChunkInvariants(
  chunkGroups: { path: string; content: string; bytes: number }[][],
): void {
  if (chunkGroups.length > MAX_CHUNKS) {
    throw new Error(
      `audit chunks (${chunkGroups.length}) exceed MAX_CHUNKS ${MAX_CHUNKS}`,
    );
  }
  let total = 0;
  for (const group of chunkGroups) {
    let groupBytes = 0;
    for (const f of group) {
      if (f.bytes > CHUNK_BYTES) {
        throw new Error(
          `audit fragment ${f.path} bytes ${f.bytes} exceeds CHUNK_BYTES ${CHUNK_BYTES}`,
        );
      }
      groupBytes += f.bytes;
    }
    total += groupBytes;
    if (groupBytes > CHUNK_BYTES) {
      throw new Error(
        `audit chunk exceeds ${CHUNK_BYTES} bytes (${groupBytes}) with ${group.length} files`,
      );
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`audit chunks total ${total} bytes exceed ceiling ${MAX_TOTAL_BYTES}`);
  }
}

function chunkFiles(files: { path: string; content: string; bytes: number }[]): string[] {
  const groups = chunkFilesFor(files);
  assertChunkInvariants(groups);
  const rendered = groups.map((g) => formatFiles(g));
  return rendered.length ? rendered : [formatFiles([])];
}


async function insertAuditSteps(
  admin: any,
  run: any,
  chunks: string[],
  batchPrompt: string | null,
  finalContract: ResolvedContract | null,
  batchPlan: { content_md?: string | null; prd_md?: string | null } | null,
  batchDesignBrief: string | null,
  isFinal: boolean,
  batchOutcome: string | null,
  fileTree: string[],
) {
  const contract = isFinal
    ? finalContract?.mode === "import_current_milestone"
      ? `FINAL A-Z AUDIT (CURRENT MILESTONE) — this is an imported app. Audit today's shipped code against the intake contract and any implemented improvement batches ONLY. Do NOT grade unbuilt future work; there is no locked improvement plan or design brief in scope for this run.`
      : `FINAL A-Z AUDIT — verify the whole app against the plan + PRD.`
    : `BATCH CONTRACT (what this batch was supposed to do):\n\n${batchPrompt}`;
  const outcomeBlock = batchOutcome?.trim()
    ? `\n\nOWNER-REPORTED OUTCOME (what Lovable actually said or did — errors, drift, surprises; investigate every claim):\n${batchOutcome.trim()}`
    : "";
  const manual = await loadFieldManual(admin);
  const multi = chunks.length > 1;

  // Contract section is fixed per-run; batch audits use the current locked
  // plan/design (unchanged); final audits use the resolved contract mode.
  const contractSection = isFinal && finalContract
    ? renderContractSection(finalContract)
    : renderContractSection({
      planContentMd: batchPlan?.content_md ?? null,
      prdMd: batchPlan?.prd_md ?? null,
      designBrief: batchDesignBrief ?? null,
      extraContext: "",
      mode: "full_blueprint",
    });

  const rows: any[] = [];
  chunks.forEach((code, idx) => {
    const chunkNote = multi
      ? `\n\nCHUNK ${idx + 1} OF ${chunks.length} — the app is split across parallel review steps. The full file tree (for orientation only):\n${fileTree.join("\n")}\n\nFlag only issues you can verify in THIS chunk's code; do not report files you cannot see as missing.`
      : "";
    const user = `${contract}${outcomeBlock}${chunkNote}

${manual}

${contractSection}

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
          // Map/extraction controls — see AUDIT_MAP_* constants. Applied to
          // every per-chunk seat review; the Chair merge step queues its own
          // request without these caps.
          temperature: AUDIT_MAP_TEMPERATURE,
          reasoning_effort: AUDIT_MAP_REASONING_EFFORT,
          max_tokens: AUDIT_MAP_MAX_TOKENS,
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
  project: { id: string; github_repo: string | null; is_import: boolean };
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

  // Contract resolution. Batch audits use the current locked plan + design
  // (unchanged). Final audits resolve mode via resolveFinalAuditContract:
  // imports with any non-passed batch (or no batches) run against the current
  // milestone contract (intake + only implemented batches), not the future
  // blueprint — this fixes false missing-feature findings on imports.
  let finalContract: ResolvedContract | null = null;
  let batchPlan: { content_md?: string | null; prd_md?: string | null } | null = null;
  let batchDesignBrief: string | null = null;
  let auditContractMode: "import_current_milestone" | "full_blueprint" | null = null;
  let includedBatchIds: string[] = [];

  if (isFinal) {
    const [lockedPlan, importIntake, designRow, batchRows] = await Promise.all([
      loadLockedPlan(admin, project.id),
      loadImportContract(admin, project.id),
      admin
        .from("plan_versions")
        .select("content_md")
        .eq("project_id", project.id)
        .eq("kind", "design")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then((r: any) => r?.data ?? null),
      admin
        .from("batches")
        .select("id, batch_no, title, channel, status, prompt_md, compiled_prompt_md")
        .eq("project_id", project.id)
        .then((r: any) => (r?.data ?? []) as ContractBatch[]),
    ]);
    finalContract = resolveFinalAuditContract({
      isImport: project.is_import,
      batches: batchRows,
      plan: lockedPlan,
      designBrief: designRow?.content_md ?? null,
      importIntake,
    });
    auditContractMode = finalContract.mode;
    includedBatchIds = finalContract.includedBatchIds;
  } else {
    batchPlan = (await loadLockedPlan(admin, project.id)) ?? (await loadImportContract(admin, project.id));
    const { data: design } = await admin
      .from("plan_versions")
      .select("content_md")
      .eq("project_id", project.id)
      .eq("kind", "design")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    batchDesignBrief = design?.content_md ?? null;
  }

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
      const res = await assembleFromGithub(
        token,
        project.github_repo,
        isFinal
          ? { baseSha, maxFiles: 200, maxTotalBytes: MAX_CHUNKS * CHUNK_BYTES, preferKeyFiles: true }
          : { baseSha },
      );
      chunks = isFinal ? chunkFiles(res.files) : chunkFiles(res.files);
      fileTree = res.fileTree;
      filesAnalyzed = res.files.length;
      headSha = res.headSha;
    } catch (e) {
      return { error: (e as Error).message };
    }

  } else {
    if (!pastedCode || !pastedCode.trim()) return { error: "Empty pasted code" as const };
    // Batch/paste audits also fan out into map chunks so a single request
    // can never exceed CHUNK_BYTES. fitPasted() already truncates at
    // MAX_PASTE_BYTES (200 KiB), well inside the 1.28 MiB total ceiling.
    const trimmed = fitPasted(pastedCode);
    const encoded = new TextEncoder().encode(trimmed);
    chunks = chunkFiles([{ path: "pasted-code", content: trimmed, bytes: encoded.length }]);
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

  const consensus: Record<string, unknown> = {
    audit_id: audit.id,
    audit_kind: kind,
    files_analyzed: filesAnalyzed,
  };
  if (isFinal && auditContractMode) {
    consensus.audit_contract_mode = auditContractMode;
    consensus.included_batch_ids = includedBatchIds;
  }

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
      consensus,
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

  await insertAuditSteps(
    admin,
    run,
    chunks,
    batchPrompt,
    finalContract,
    batchPlan,
    batchDesignBrief,
    isFinal,
    batchOutcome,
    fileTree,
  );
  fireOrchestrator();
  return {
    audit_id: audit.id,
    run_id: run.id,
    audit_contract_mode: auditContractMode ?? undefined,
    included_batch_ids: isFinal ? includedBatchIds : undefined,
  };
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
      const eligibility = checkFinalAuditEligibility({
        isImport: project.is_import,
        batches: (batches ?? []) as Array<{ status: string }>,
        source,
        githubRepo: project.github_repo,
      });
      if (!eligibility.ok) return j(400, { error: eligibility.error });

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
