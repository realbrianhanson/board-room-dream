// deno-lint-ignore-file no-explicit-any
// Step queuing: everything that composes prompts and inserts run_steps rows.
// Context loaders live here too — they exist to feed the prompts.
import { assembleFromGithub, formatFiles, ghToken } from "../_shared/github-payload.ts";
import { loadFieldManual } from "../_shared/lovable-field-manual.ts";
import {
  injectOwnerAuthority,
  loadOwnerAuthority,
  OWNER_AUTHORITY_RULES,
  type OwnerAuthority,
} from "../_shared/owner-authority.ts";
import {
  assertBatchRequestSize,
  BatchContextTooLarge,
  compactMarkdown,
  COMPACT_ARTIFACT_CAP,
  isBatchGenerationStep,
  renderCompactRepoContract,
} from "../_shared/batch-context.ts";
export { BatchContextTooLarge } from "../_shared/batch-context.ts";
import { batchPromptPolicy, productStrategyContract } from "../_shared/batch-count-policy.ts";
import {
  SEATS,
  type Seat,
  SEAT_LABEL,
  rubricForKind,
  intakeBlock,
  draftsBlock,
  objectionsAndStealsBlock,
  priorRoundFailureBlock,
  candidateForLoop,
  lastCandidateLoop,
} from "./protocol.ts";

// Load owner authority once per run and cache on the run object so every
// queue function in the run's lifetime pays for a single DB round trip.
async function ensureAuthority(admin: any, run: any): Promise<OwnerAuthority> {
  if (!(run as any).__authority__) {
    // For change_request runs the CR is not yet 'approved', so the loader's
    // approved-CR pass will not pick it up. Inject the exact submitted CR
    // description scoped to THIS run under the SAME stable provenance
    // identity the finalizer and the post-approval compiler will use:
    // `approved_change_request:<crId>`. Never pull arbitrary/pending CRs
    // from other runs.
    const extraFounderNotes: Array<{ source: string; text: string | null | undefined }> = [];
    if (run?.kind === "change_request") {
      const crId = run?.consensus?.change_request_id;
      if (crId) {
        try {
          const { data: crRow } = await admin
            .from("change_requests")
            .select("description")
            .eq("id", crId)
            .eq("project_id", run.project_id)
            .eq("user_id", run.user_id)
            .maybeSingle();
          const desc = String(crRow?.description ?? "").trim();
          if (desc) {
            extraFounderNotes.push({
              source: `approved_change_request:${crId}`,
              text: desc,
            });
          }
        } catch { /* empty CR description simply blocks any high-impact expansion */ }
      }
    }
    (run as any).__authority__ = await loadOwnerAuthority(admin, {
      projectId: run.project_id,
      founderNotes: run.founder_notes ?? null,
      extraFounderNotes,
    });
  }
  return (run as any).__authority__;
}

// Wrapper around admin.from("run_steps").insert(...) that prepends the OWNER
// AUTHORITY rules to every system prompt and the compact owner-source block
// to every user prompt in the payload. Use this in place of `.insert(rows)`
// for any board step where the reviewer must not be able to be overruled by
// a locked plan, board draft, dissent, Chair ruling, or consensus score.
async function queueSteps(admin: any, run: any, rowsIn: any | any[]): Promise<any> {
  const authority = await ensureAuthority(admin, run);
  const rows = Array.isArray(rowsIn) ? rowsIn : [rowsIn];
  for (const row of rows) {
    const msgs = row?.request?.messages;
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        if (m?.role === "system" && typeof m.content === "string") {
          m.content = `${OWNER_AUTHORITY_RULES}\n\n${m.content}`;
        } else if (m?.role === "user") {
          const injected = injectOwnerAuthority("", m.content, authority);
          m.content = injected.user;
        }
      }
    }
    // Hard request-size invariant for batch-generation steps. Measured AFTER
    // owner-authority injection so what we count is exactly what ships. Fails
    // closed via BatchContextTooLarge — never silently drops authority /
    // FEATURES / draft.
    if (isBatchGenerationStep(row?.step_key)) {
      assertBatchRequestSize(String(row.step_key), row.request);
    }
  }
  return admin.from("run_steps").insert(rowsIn);
}



export async function loadLockedPlan(admin: any, projectId: string) {
  const { data } = await admin
    .from("plan_versions")
    .select("content_md, prd_md, features, dissent_ledger, decision_log")
    .eq("project_id", projectId)
    .eq("kind", "plan")
    .eq("is_build_safe", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}






// ============================== Prompt builders ==============================

export async function loadIntake(admin: any, projectId: string) {
  const { data } = await admin
    .from("intakes")
    .select("answers, validation_scores")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? { answers: {}, validation_scores: null };
}


export async function loadProjectMeta(admin: any, projectId: string) {
  const { data } = await admin
    .from("projects")
    .select("id, user_id, is_import, github_repo")
    .eq("id", projectId)
    .maybeSingle();
  return data ?? null;
}


export async function loadRepoSample(admin: any, project: any, maxFiles: number) {
  if (!project?.github_repo) return { files: [], fileTree: [] as string[] };
  const token = await ghToken(admin, project.user_id);
  if (!token) return { files: [], fileTree: [] as string[] };
  try {
    const res = await assembleFromGithub(token, project.github_repo, {
      maxFiles,
      maxFileBytes: 100 * 1024,
      maxTotalBytes: 300 * 1024,
      preferKeyFiles: true,
    });
    return { files: res.files, fileTree: res.fileTree };
  } catch {
    return { files: [], fileTree: [] as string[] };
  }
}


// The batch-generation trio (draft / review / revise) all need the same
// LIVE REPO CONTRACT so reviewers judge the draft against real code — not
// against names invented from the PRD. For imports this must succeed or the
// run fails loudly; guessed prompts silently rewriting the wrong file paths
// have been the top source of bad batches.
export class RepoContractUnavailable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RepoContractUnavailable";
  }
}


// For fresh (non-import) projects the contract is empty — there IS no live
// repo yet, so batches necessarily label everything CREATE/ADD. For imports
// we require both file tree AND at least one readable key file; a bare tree
// with no readable contents is not enough to ground UPDATE targets.
export async function loadLiveRepoContract(admin: any, project: any): Promise<string> {
  const isImport = !!project?.is_import;
  if (!isImport) {
    return `LIVE REPO CONTRACT\n(none — this is a fresh project; every path, table, and function must be labelled CREATE/ADD and sequenced so its dependencies come first.)`;
  }
  if (!project?.github_repo) {
    throw new RepoContractUnavailable(
      "This import project has no linked GitHub repo, so the board cannot ground batches in the real code. Link the repo in Settings and try again.",
    );
  }
  const token = await ghToken(admin, project.user_id);
  if (!token) {
    throw new RepoContractUnavailable(
      "GitHub is not connected for this owner, so the board cannot read the real repo. Reconnect GitHub in Settings and try again.",
    );
  }
  let res: Awaited<ReturnType<typeof assembleFromGithub>>;
  try {
    res = await assembleFromGithub(token, project.github_repo, {
      maxFiles: 25,
      maxFileBytes: 100 * 1024,
      maxTotalBytes: 400 * 1024,
      preferKeyFiles: true,
    });
  } catch (e) {
    throw new RepoContractUnavailable(
      `The board could not read the linked repo ${project.github_repo}: ${(e as Error).message}. Fix repo access and retry.`,
    );
  }
  if (!res.files.length || !res.fileTree.length) {
    throw new RepoContractUnavailable(
      `The board could not read any files from ${project.github_repo}. The repo may be empty, private without access, or renamed. Fix and retry.`,
    );
  }
  const treeSlice = res.fileTree.slice(0, 200);
  return `LIVE REPO CONTRACT — authoritative source for current paths, routes, functions, tables, and columns. The locked plan/PRD express intent; this repo is what actually ships. Any path or schema object NOT listed here must be labelled CREATE/ADD and its dependency ordered first. Any UPDATE target MUST appear here verbatim.

REPO: ${project.github_repo}
FILE TREE (top ${treeSlice.length})
${treeSlice.join("\n")}

KEY FILES (${res.files.length}, frontend + backend biased)
${formatFiles(res.files)}`;
}



// Compact variant of the live repo contract used ONLY by batch draft/review/
// revise. Same failure semantics as loadLiveRepoContract for imports (repo
// token, non-empty tree, at least one readable key file) — but the render is
// deterministically capped to <=24 KiB of key evidence and up to 250 tree
// paths. The JIT batch-compiler regrounds each individual batch against the
// full live code/schema before Copy is enabled, so we do not need to ship
// 25 whole files to reviewers.
export async function loadCompactBatchRepoContract(admin: any, project: any): Promise<string> {
  const isImport = !!project?.is_import;
  if (!isImport) {
    return `LIVE REPO CONTRACT\n(none — this is a fresh project; every path, table, and function must be labelled CREATE/ADD and sequenced so its dependencies come first.)`;
  }
  if (!project?.github_repo) {
    throw new RepoContractUnavailable(
      "This import project has no linked GitHub repo, so the board cannot ground batches in the real code. Link the repo in Settings and try again.",
    );
  }
  const token = await ghToken(admin, project.user_id);
  if (!token) {
    throw new RepoContractUnavailable(
      "GitHub is not connected for this owner, so the board cannot read the real repo. Reconnect GitHub in Settings and try again.",
    );
  }
  let res: Awaited<ReturnType<typeof assembleFromGithub>>;
  try {
    res = await assembleFromGithub(token, project.github_repo, {
      // We only need architectural evidence — the renderer's 24 KiB cap
      // trims further. Keep per-file bytes small so no single file drowns
      // out manifests / router roots / migrations.
      maxFiles: 40,
      maxFileBytes: 32 * 1024,
      maxTotalBytes: 200 * 1024,
      preferKeyFiles: true,
    });
  } catch (e) {
    throw new RepoContractUnavailable(
      `The board could not read the linked repo ${project.github_repo}: ${(e as Error).message}. Fix repo access and retry.`,
    );
  }
  if (!res.files.length || !res.fileTree.length) {
    throw new RepoContractUnavailable(
      `The board could not read any files from ${project.github_repo}. The repo may be empty, private without access, or renamed. Fix and retry.`,
    );
  }
  return renderCompactRepoContract({
    repo: project.github_repo,
    fileTree: res.fileTree,
    files: res.files,
  });
}


// Signed URLs for the founder's uploaded screenshots (newest first, max 4).
// 24h expiry comfortably covers queue → execution, including budget pauses.
export async function loadScreenshotParts(admin: any, userId: string, projectId: string): Promise<any[]> {
  try {
    const prefix = `${userId}/${projectId}`;
    const { data: files } = await admin.storage
      .from("design-screenshots")
      .list(prefix, { limit: 8, sortBy: { column: "created_at", order: "desc" } });
    const parts: any[] = [];
    for (const f of (files ?? []).filter((x: any) => x?.name && !x.name.endsWith("/")).slice(0, 4)) {
      const { data: signed } = await admin.storage
        .from("design-screenshots")
        .createSignedUrl(`${prefix}/${f.name}`, 60 * 60 * 24);
      if (signed?.signedUrl) parts.push({ type: "image_url", image_url: { url: signed.signedUrl } });
    }
    return parts;
  } catch {
    return [];
  }
}


export function withImages(text: string, imageParts: any[]): any {
  if (!imageParts.length) return text;
  return [
    { type: "text", text: `${text}\n\nThe founder's uploaded screenshots are attached below — ground every visual critique in what you actually see in them.` },
    ...imageParts,
  ];
}


export async function latestAuditSummary(admin: any, projectId: string) {
  const { data } = await admin
    .from("audits")
    .select("id, kind, status, summary, completed_at")
    .eq("project_id", projectId)
    .eq("kind", "final_az")
    .in("status", ["clean", "findings"])
    .not("summary", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}



// ============================== Step queuing ==============================

export async function queueRound1(admin: any, run: any) {
  const intake = await loadIntake(admin, run.project_id);
  const project = await loadProjectMeta(admin, run.project_id);
  const isImport = !!project?.is_import;
  let system: string;
  let userContent: string;

  if (run.kind === "design") {
    const plan = await loadLockedPlan(admin, run.project_id);
    system =
      "Round 1 of the Design Council. You are drafting INDEPENDENTLY — you cannot see the other seats' drafts. Produce your best design direction for this app. You MUST include: concept/mood; palette as specific HSL values; type pairing with specific font names; spacing and shape language; ONE distinctive signature element (a structural design move — non-negotiable, this is the point); and motion rules. Be specific, opinionated, and premium. Avoid generic AI-slop aesthetics.";
    if (isImport) {
      const sample = await loadRepoSample(admin, project, 12);
      const treeBlock = sample.fileTree.length ? sample.fileTree.join("\n") : "(no repo files available)";
      const codeBlock = sample.files.length ? formatFiles(sample.files) : "(no repo files available)";
      const planBlock = plan?.content_md?.trim()
        ? `LOCKED PLAN\n\n${plan.content_md}\n\nPRD\n\n${plan.prd_md ?? "(no PRD)"}`
        : "LOCKED PLAN\n(none yet — base your direction on the real code above)";
      userContent = `${intakeBlock(intake)}\n\nREPO FILE TREE (top ${sample.fileTree.length})\n${treeBlock}\n\nKEY FILES (frontend-biased sample)\n${codeBlock}\n\n${planBlock}\n\nThis is an existing app — critique the real UI in the code above and propose a design direction that elevates it without a full rebuild. Write your Round 1 design direction now.`;
    } else {
      userContent = `${intakeBlock(intake)}\n\nLOCKED PLAN\n\n${plan?.content_md ?? "(no plan)"}\n\nPRD\n\n${plan?.prd_md ?? "(no PRD)"}\n\nWrite your Round 1 design direction now.`;
    }
  } else if (run.kind === "plan" && isImport) {
    system =
      "Round 1 of the board's improvement deliberation. This app already exists — the owner has brought it to the board. You are drafting INDEPENDENTLY. Produce a PRIORITIZED IMPROVEMENT PLAN: what's broken, what's missing, what to build next, ranked by impact. Be specific, opinionated, and concrete about the code you can see. Do not restart the app from scratch.";
    const sample = await loadRepoSample(admin, project, 15);
    const audit = await latestAuditSummary(admin, run.project_id);
    const treeBlock = sample.fileTree.length ? sample.fileTree.join("\n") : "(no repo linked)";
    const auditBlock = audit?.summary
      ? `LATEST A-Z AUDIT SUMMARY\n${JSON.stringify(audit.summary, null, 2)}`
      : "LATEST A-Z AUDIT SUMMARY\n(no A-Z audit yet)";
    userContent = `${intakeBlock(intake)}\n\nREPO FILE TREE (top ${sample.fileTree.length})\n${treeBlock}\n\nKEY FILES\n${formatFiles(sample.files)}\n\n${auditBlock}\n\nWrite your Round 1 prioritized improvement plan now.`;
  } else {
    system =
      "Round 1 of the board's deliberation. You are drafting INDEPENDENTLY — you cannot see the other seats' drafts. Produce your best version of the app plan: concept, target user, core features (MVP-first, ruthlessly cut), the data the app stores, and what you'd cut. Be specific, concise, and opinionated.";
    userContent = `${intakeBlock(intake)}\n\nWrite your Round 1 draft now.`;
  }
  const imageParts = run.kind === "design"
    ? await loadScreenshotParts(admin, run.user_id, run.project_id)
    : [];
  const rows = SEATS.map((seat) => ({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `r1_draft_${seat}`,
    round: 1,
    seat,
    status: "queued",
    request: {
      // Round 1 is the divergence round — hotter sampling so four seats
      // actually produce four different drafts worth debating.
      temperature: 0.85,
      messages: [
        { role: "system", content: system },
        { role: "user", content: withImages(userContent, imageParts) },
      ],
    },
  }));
  await queueSteps(admin, run, rows);
}



export async function queueRound2(admin: any, run: any, steps: any[]) {
  const intake = await loadIntake(admin, run.project_id);
  const rows = SEATS.map((seat) => {
    const system = `Round 2 — Cross-examination. You are reviewing the OTHER three seats' drafts. "No objections" is not an option. If you cannot find real flaws you are not looking hard enough.

Return ONLY valid JSON matching this shape:
{
  "objections": [ { "target_seat": "chair"|"strategist"|"contrarian"|"inspector", "severity": "blocking"|"major"|"minor", "text": "..." } ],
  "steals": [ { "from_seat": "chair"|"strategist"|"contrarian"|"inspector", "idea": "concrete: I am adopting <specific idea> because <why it improves the plan>" } ]
}

Requirements: at least ONE objection targeting EACH of the three other seats, at least THREE objections total, and at least ONE steal. A steal must name the specific idea you are adopting and why — "good points from everyone" is not a steal.`;
    const user = `${intakeBlock(intake)}\n\n${draftsBlock(steps, seat)}\n\nProduce your JSON now.`;
    return {
      run_id: run.id,
      user_id: run.user_id,
      step_key: `r2_exam_${seat}`,
      round: 2,
      seat,
      status: "queued",
      request: {
        json_output: true,
        max_tokens: 3500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },

    };
  });
  await queueSteps(admin, run, rows);
}


// Round 3 is two-phase: the Chair writes the candidate as FREE MARKDOWN (its
// best register — long documents forced into JSON strings come out flat), then
// a cheap extraction step lifts the decision log into structured JSON. The
// draft's response_text IS the candidate document downstream.
export async function queueRound3(admin: any, run: any, steps: any[], loop: number) {
  const intake = await loadIntake(admin, run.project_id);
  const isDesign = run.kind === "design";
  const plan = isDesign ? await loadLockedPlan(admin, run.project_id) : null;
  const docSpec = isDesign
    ? `a paste-ready design system brief with these EXACT H2 sections in this exact order:
## Direction
## Tokens (CSS variables, HSL)
## Type
## Spacing & shape
## Signature element
## Motion
## Component rules

Every H2 header must appear exactly as written. Be specific: exact HSL values, real font names, concrete component rules.`
    : `the full app plan: concept, target user, MVP features (ruthlessly cut), data stored, and explicit cuts.`;
  const system = `Round 3 — Chair synthesis${loop > 0 ? ` (loop ${loop}, revising after a failed vote)` : ""}. You are the Chair. Weld the four ${isDesign ? "design directions" : "drafts"} and the objections into ONE candidate ${isDesign ? "design brief" : "plan"}.

Write ${docSpec}

${loop > 0 ? `Revise ONLY the contested parts from the previous vote. Preserve agreed parts verbatim. Your Decision log MUST address EVERY blocking objection listed in the failure report: quote it, then either "Resolved by: <the specific change you made>" or "Rejected because: <reason>". An unaddressed blocking objection means the next vote fails again.\n\n` : ""}${!isDesign ? `${productStrategyContract()}\n\n` : ""}End the document with two final H2 sections:
## Decision log
One bullet per objection you weighed: [seat] "objection" — accepted/rejected — reason.
## Steals adopted
One bullet per idea you took from another seat's draft.

Respond with the markdown document ONLY — no JSON, no preamble, no closing remarks.`;
  const parts: string[] = [intakeBlock(intake)];
  if (String(run.founder_notes ?? "").trim()) {
    parts.push(`FOUNDER'S NOTES TO THE BOARD (the founder is the client — weigh these heavily):\n${String(run.founder_notes).trim()}`);
  }
  if (isDesign && plan) parts.push(`LOCKED PLAN\n\n${plan.content_md ?? ""}\n\nPRD\n\n${plan.prd_md ?? "(none)"}`);
  parts.push(draftsBlock(steps), objectionsAndStealsBlock(steps));
  if (loop > 0) parts.push(priorRoundFailureBlock(steps, loop - 1));
  const user = `${parts.join("\n\n")}\n\nWrite the candidate document now.`;
  const imageParts = isDesign ? await loadScreenshotParts(admin, run.user_id, run.project_id) : [];
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: `r3_draft_chair_loop${loop}`,
    round: 3,
    seat: "chair",
    status: "queued",
    request: {
      reasoning_effort: "high",
      max_tokens: 10000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: withImages(user, imageParts) },
      ],
    },

  });
}


export async function queueRound3Extract(admin: any, run: any, steps: any[], loop: number) {
  const draft = steps.find((x: any) => x.step_key === `r3_draft_chair_loop${loop}` && x.status === "completed");
  const system = `Extraction. Read the Chair's candidate document and lift its Decision log and Steals adopted sections into structured JSON. Copy faithfully — do not editorialize, add, or drop entries.

Return ONLY valid JSON:
{
  "decision_log": [ { "from_seat": "...", "objection": "...", "decision": "accepted"|"rejected", "reason": "..." } ],
  "steals_adopted": [ "..." ]
}`;
  // DIRECT INSERT (allow-listed): pure extraction — copies structured fields
  // (decision_log, steals_adopted) out of the Chair's already-produced candidate
  // markdown. No new decisions, no generative scope. Owner-authority injection
  // is unnecessary because this step cannot introduce executable scope.
  await admin.from("run_steps").insert({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `r3_extract_chair_loop${loop}`,
    round: 3,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      temperature: 0,
      max_tokens: 8000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `CANDIDATE DOCUMENT\n\n${String(draft?.response_text ?? "")}\n\nProduce your JSON now.` },
      ],
    },
  });

}


export async function queueRound4(admin: any, run: any, steps: any[], loop: number) {
  const intake = await loadIntake(admin, run.project_id);
  const candidateMd = candidateForLoop(steps, loop);
  const rubric = rubricForKind(run.kind);
  const scoresShape = rubric.map((k) => `    "${k}": 1-10`).join(",\n");
  // The Chair authored the candidate and does not vote on its own work —
  // consensus is judged by the three independent seats.
  const voters = SEATS.filter((s) => s !== "chair");
  const rows = voters.map((seat) => {
    const myR2 = steps.find((x) => x.step_key === `r2_exam_${seat}` && x.status === "completed");
    const myObjections = myR2?.response_json?.objections ?? [];
    const system = `Round 4 — Scored vote${loop > 0 ? ` (loop ${loop})` : ""}. The Chair synthesized this candidate; as an independent seat you now judge it. Vote on the candidate ${run.kind === "design" ? "design brief" : "plan"} against the founder's intake and your Round-2 objections.

Return ONLY valid JSON matching this shape:
{
  "scores": {
${scoresShape}
  },
  "objection_resolutions": [
    { "objection": "your Round-2 objection, restated", "status": "resolved"|"standing", "evidence_quote": "VERBATIM quote from the candidate that resolves it — required when status is resolved" }
  ],
  "blocking_objections": [ "..." ],
  "comment": "One paragraph."
}

Every score must be an integer 1-10. Score against the founder's actual intake — not the candidate in a vacuum.

Resolution discipline: an objection is "resolved" ONLY if you can quote the exact candidate text that resolves it. No quote = it still stands. Add still-standing dealbreakers to blocking_objections. Do not inflate scores to reach consensus.`;
    const user = `${intakeBlock(intake)}\n\nCANDIDATE\n\n${candidateMd}\n\nYOUR ROUND-2 OBJECTIONS\n${JSON.stringify(myObjections, null, 2)}\n\nProduce your JSON now.`;
    return {
      run_id: run.id,
      user_id: run.user_id,
      step_key: `r4_vote_${seat}_loop${loop}`,
      round: 4,
      seat,
      status: "queued",
      request: {
        json_output: true,
        // Voting is a judgment call, not a creative act — keep it cold.
        temperature: 0.2,
        max_tokens: 3500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },

    };
  });
  await queueSteps(admin, run, rows);
}


export async function queueFinalRuling(admin: any, run: any, steps: any[]) {
  const intake = await loadIntake(admin, run.project_id);
  const lastCandidate = candidateForLoop(steps, lastCandidateLoop(steps));
  const lastLoop = run.loop_no; // by now already incremented to 3
  const previousLoop = Math.max(0, lastLoop - 1);
  const failure = priorRoundFailureBlock(steps, previousLoop);
  const system = `The board has failed to reach consensus after three synthesis loops. You are the Chair — RULE. Accept some outstanding objections, reject others, and produce the final plan. This is a chair-ruled plan, not a consensus plan.

Return ONLY valid JSON matching this shape:
{
  "final_md": "Full markdown plan.",
  "ruling_note": "One paragraph explaining the ruling.",
  "dissent_ledger": [ { "seat": "...", "objection": "...", "chair_response": "..." } ]
}`;
  const user = `${intakeBlock(intake)}\n\nLAST CANDIDATE\n${lastCandidate}\n\n${failure}\n\nProduce your JSON now.`;
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: `r_final_ruling_chair`,
    round: 5,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      reasoning_effort: "high",
      max_tokens: 10000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },

  });
}


// Blueprint is two-phase like Round 3: the PRD is written as free markdown,
// then a cheap extraction lifts the features list into JSON.
export async function queueBlueprint(admin: any, run: any, contentMd: string, intake: any) {
  const manual = await loadFieldManual(admin);
  const system = `Blueprint — you are the Chair drafting the implementation documents for the locked plan. Turn the plan into a precise PRD.

${manual}

Write a full markdown PRD with these exact H2 sections in this exact order:
## User types
## Jobs to be done
## Data model (tables and columns)
## Pages
## Edge functions
## Integrations
## Features
## Out of scope for v1

Every section header must appear exactly as written. Be specific: name concrete tables, columns, page routes, and edge functions. Under ## Features, one bullet per feature: **name** (mvp|later) — one-sentence description.

Respond with the markdown document ONLY — no JSON, no preamble.`;
  const user = `${intakeBlock(intake)}\n\nLOCKED PLAN\n\n${contentMd}\n\nWrite the PRD now.`;
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: "r5_blueprint_chair",
    round: 5,
    seat: "chair",
    status: "queued",
    request: {
      reasoning_effort: "high",
      max_tokens: 10000,

      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
}


export async function queueBlueprintExtract(admin: any, run: any, steps: any[]) {
  const draft = steps.find((x: any) => x.step_key === "r5_blueprint_chair" && x.status === "completed");
  const system = `Extraction. Read the PRD and lift its ## Features section into structured JSON. Copy faithfully — do not add, drop, or rename features.

Return ONLY valid JSON:
{
  "features": [ { "name": "...", "description": "...", "priority": "mvp" | "later" } ]
}`;
  // DIRECT INSERT (allow-listed): pure extraction — lifts the ## Features
  // section from the Chair's PRD into structured JSON. Cannot introduce
  // executable scope; owner-authority injection is unnecessary.
  await admin.from("run_steps").insert({
    run_id: run.id,
    user_id: run.user_id,
    step_key: "r5_blueprint_extract_chair",
    round: 6,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      temperature: 0,
      max_tokens: 8000,

      messages: [
        { role: "system", content: system },
        { role: "user", content: `PRD\n\n${String(draft?.response_text ?? "")}\n\nProduce your JSON now.` },
      ],
    },
  });
}


export async function queueChangeRequestExam(admin: any, run: any, cr: any, plan: any) {
  const system = `Change Request review. The board has already locked a plan. A change is being proposed. Decide your stance.

Return ONLY valid JSON matching this shape:
{
  "stance": "approve" | "approve_with_amendments" | "reject",
  "reasoning": "One paragraph.",
  "amendments": [ "..." ]
}`;
  const rows = SEATS.map((seat) => ({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `cr_exam_${seat}`,
    round: 1,
    seat,
    status: "queued",
    request: {
      json_output: true,
      max_tokens: 3500,
      messages: [

        { role: "system", content: system },
        {
          role: "user",
          content: `LOCKED PLAN\n\n${plan.content_md ?? ""}\n\nPRD\n\n${plan.prd_md ?? "(none)"}\n\nREQUESTED CHANGE\n\n${cr.description}\n\nProduce your JSON now.`,
        },
      ],
    },
  }));
  await queueSteps(admin, run, rows);
}


export async function queueChangeRequestVerdict(admin: any, run: any, cr: any, plan: any, steps: any[]) {
  const stances = SEATS.map((s) => {
    const step = steps.find((x) => x.step_key === `cr_exam_${s}` && x.status === "completed");
    return `--- ${SEAT_LABEL[s]} ---\n${JSON.stringify(step?.response_json ?? { missing: true }, null, 2)}`;
  }).join("\n\n");
  const system = `Change Request verdict. You are the Chair. Rule on the change based on the four seats' stances.

Return ONLY valid JSON matching this shape:
{
  "verdict": "approved" | "rejected",
  "rationale": "One paragraph.",
  "amended_plan_md": "Full markdown of the AMENDED plan (required when approved).",
  "amended_prd_md": "Full markdown of the AMENDED PRD, same H2 sections as the original (required when approved).",
  "amended_features": [ { "name": "...", "description": "...", "priority": "mvp"|"later" } ]
}

If rejected, amended_* may be empty strings / empty array.`;
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: "cr_verdict_chair",
    round: 2,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      max_tokens: 10000,
      messages: [

        { role: "system", content: system },
        {
          role: "user",
          content: `LOCKED PLAN\n\n${plan.content_md ?? ""}\n\nCURRENT PRD\n\n${plan.prd_md ?? "(none)"}\n\nREQUESTED CHANGE\n\n${cr.description}\n\nSEAT STANCES\n\n${stances}\n\nProduce your JSON now.`,
        },
      ],
    },
  });
}


// Approved amendments get the same treatment as batches: the Inspector checks
// the amended plan/PRD against reality (existing batches, internal consistency)
// before it becomes a plan_version. One revision loop max.
export async function queueChangeRequestReview(admin: any, run: any, verdictJson: any) {
  const { data: batchRows } = await admin
    .from("batches")
    .select("batch_no, title, status")
    .eq("project_id", run.project_id)
    .order("batch_no", { ascending: true });
  const batchesBlock = (batchRows ?? []).length
    ? (batchRows ?? []).map((b: any) => `- Batch ${b.batch_no} [${b.status}]: ${b.title}`).join("\n")
    : "(no build sequence generated yet)";
  const system = `Change request review — Inspector. The Chair approved an amendment and rewrote the plan + PRD. Check the amended documents before they lock:
- Internal consistency: the amended plan and amended PRD agree with each other; no feature exists in one but not the other (blocking).
- Collateral damage: nothing that existing build batches already implement was silently removed or renamed (blocking — name the batch).
- PRD structure: the exact H2 sections are all present, in order (blocking).
- Scope: the amendment does only what the change request asked; anything extra is major.

Return ONLY valid JSON:
{
  "verdict": "approve" | "revise",
  "issues": [ { "batch_no": <number or null>, "severity": "blocking"|"major"|"minor", "text": "specific issue and the fix" } ]
}`;
  const user = `AMENDED PLAN\n\n${String(verdictJson?.amended_plan_md ?? "")}\n\nAMENDED PRD\n\n${String(verdictJson?.amended_prd_md ?? "")}\n\nAMENDED FEATURES\n\n${JSON.stringify(verdictJson?.amended_features ?? [], null, 2)}\n\nEXISTING BUILD BATCHES\n\n${batchesBlock}\n\nProduce your JSON now.`;
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: "cr_review_inspector",
    round: 3,
    seat: "inspector",
    status: "queued",
    request: {
      json_output: true,
      temperature: 0.2,
      max_tokens: 3500,

      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
}


export async function queueChangeRequestRevise(admin: any, run: any, verdictJson: any, reviewJson: any) {
  const system = `Change request revision — you are the Chair. The Inspector found issues in your amended documents. Fix every blocking issue and every major issue you agree with; keep everything else verbatim.

Return ONLY the same JSON shape as your verdict:
{
  "verdict": "approved",
  "rationale": "One paragraph (updated if the fixes changed it).",
  "amended_plan_md": "Full corrected markdown plan.",
  "amended_prd_md": "Full corrected markdown PRD, same H2 sections as the original.",
  "amended_features": [ { "name": "...", "description": "...", "priority": "mvp"|"later" } ]
}

Write the documents at FULL length — never compress them because they are inside JSON strings.`;
  const user = `YOUR VERDICT\n\n${JSON.stringify(verdictJson, null, 2)}\n\nINSPECTOR ISSUES\n\n${JSON.stringify(reviewJson, null, 2)}\n\nProduce the corrected JSON now.`;
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: "cr_revise_chair",
    round: 4,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      reasoning_effort: "high",
      max_tokens: 10000,

      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
}


export async function queueBatchesStep(admin: any, run: any) {
  const manual = await loadFieldManual(admin);
  const plan = await loadLockedPlan(admin, run.project_id);
  const project = await loadProjectMeta(admin, run.project_id);
  const { data: design } = await admin
    .from("plan_versions")
    .select("content_md")
    .eq("project_id", run.project_id)
    .eq("kind", "design")
    .eq("is_build_safe", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const compactDesign = compactMarkdown(design?.content_md ?? "", COMPACT_ARTIFACT_CAP);
  const designSection = compactDesign
    ? `LOCKED DESIGN BRIEF (compact)\n\n${compactDesign}\n\nBatch 1 MUST install these design tokens (CSS variables, Tailwind config, font imports) BEFORE any feature work.`
    : `NO LOCKED DESIGN BRIEF — do not fabricate one. The student will convene the Design Council later.`;

  // Compact repo contract for batch-generation only. The JIT batch-compiler
  // regrounds each specific batch against the full live code/schema before
  // Copy is enabled — this stage only needs enough evidence to spot invented
  // paths and stack mismatches. May throw RepoContractUnavailable for imports.
  const repoContract = await loadCompactBatchRepoContract(admin, project);
  const compactPlan = compactMarkdown(plan?.content_md ?? "", COMPACT_ARTIFACT_CAP);
  const compactPrd = compactMarkdown(plan?.prd_md ?? "", COMPACT_ARTIFACT_CAP);

  // Import projects run a small improvement plan against real code, not a
  // greenfield build. Padding to six batches has produced duplicated /
  // hand-waved batches. Cap the range at 3-6 for imports (dependency-safe,
  // minimum needed to cover the locked improvement plan). Greenfield stays
  // 6-8 (prefer 6). The validator globally accepts 3-8 so this prompt-side
  // range simply constrains the model within the allowed window.
  const isImport = !!project?.is_import;
  const policy = batchPromptPolicy(isImport);
  const batchRangeText = policy.rangeText;
  const batchRangePrompt = policy.rangePrompt;
  const batchCountRule = policy.countRule;

  const system = `You are the Chair, sequencing this student's build for their Lovable project. ${batchRangePrompt}

${manual}

OUTPUT DISCIPLINE (hard limits — the run FAILS if you exceed them):
- ${batchCountRule}
- Each prompt_md: 900-2,600 characters, MAX 8 numbered implementation items.
- Code batches: 2-4 acceptance checks (not 5).
- Do NOT restate plan/PRD prose, feature lists, or design tokens verbatim in prompts. Reference them by name.
- Total serialized JSON payload: <=24,000 characters. If you approach that, cut prose — not scope.

Rules for EVERY batch:
- Numbered items with EXACT scope — no wishlists. Name exact routes, components, tables, and columns from the PRD in every item.
- Code batches (channel 'lovable' or 'supabase') include an "Acceptance checks:" list — 2-4 numbered checks the student verifies in the preview with clicks only.
- Ends with the sentence: "Keep everything else identical."
- Code batches (channel 'lovable' or 'supabase') also end with: "Typecheck when done."
- Channel 'supabase' = pure database/schema/RLS/edge-function work. State access rules for every table in plain words.
- Channel 'human' = things only the student can do in external consoles (Stripe, DNS, OAuth apps, App Store, domain purchase) — write plain-language numbered steps, no code, no acceptance checks, no typecheck line.
- Channel 'lovable' = frontend + integration work the student will paste into Lovable.
- Sequence so nothing depends on a later batch. Auth/data foundations early. Polish/SEO/analytics late.
- EVERY feature in the FEATURES list must land in some batch. Must-have/high-priority features go in the core batches; lower-priority features go in final batches titled "Enhancement — <name>" (same skeleton, same rigor). Never silently drop a listed feature.
- If a DEFERRED VALUE section is provided, harvest the still-valuable ideas that do not contradict the locked plan into the Enhancement batches too. Never resurrect anything the board explicitly rejected as harmful.
- REPO GROUNDING (critical): The LIVE REPO CONTRACT is authoritative. Any path/route/component/table/function that already exists there is an UPDATE target and MUST match the contract verbatim. Anything not in the contract MUST be labelled CREATE/ADD, and its dependencies MUST be sequenced earlier. Never invent an UPDATE against a filename that is not in the contract.
- Every prompt_md follows this skeleton:
  """
  Batch N — <one-line batch name>. Numbered items only, no scope creep.

  1. <item>
  2. <item>
  ...

  Acceptance checks:  ← omit for channel 'human'
  1. <click-only check>
  2. <click-only check>

  Keep everything else identical.
  Typecheck when done.  ← omit for channel 'human'
  """

Return ONLY valid JSON:
{
  "batches": [
    { "batch_no": 1, "title": "Foundation & shell", "channel": "lovable"|"supabase"|"human", "prompt_md": "Batch 1 — ...\\n\\n1. ...\\n\\nAcceptance checks:\\n1. ...\\n\\nKeep everything else identical.\\nTypecheck when done." }
  ]
}

Constraints: ${batchRangeText} batches, unique ascending integer batch_no starting at 1, every prompt_md within character limits, following the skeleton exactly.`;

  const featuresBlock = Array.isArray(plan?.features) && plan!.features.length
    ? plan!.features.map((f: any) => `- [${f.priority}] ${f.name}: ${f.description}`).join("\n")
    : "(none listed)";

  const deferredRaw = {
    decision_log: (plan as any)?.decision_log ?? null,
    dissent_ledger: (plan as any)?.dissent_ledger ?? null,
  };
  const deferredBlock = (deferredRaw.decision_log || deferredRaw.dissent_ledger)
    ? `\n\nDEFERRED VALUE (board decision log + dissent ledger) — ideas debated and not adopted into the core plan. Harvest anything still valuable and consistent with the locked plan into the final Enhancement batches:\n${JSON.stringify(deferredRaw).slice(0, 4000)}`
    : "";

  const user = `${repoContract}\n\nLOCKED PLAN (compact — full text is in the plan_versions table)\n\n${compactPlan || "(no plan)"}\n\nPRD (compact — full text is in plan_versions.prd_md)\n\n${compactPrd || "(no PRD)"}\n\nFEATURES\n\n${featuresBlock}\n\n${designSection}${deferredBlock}\n\nProduce the JSON now.`;

  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: "batches_chair",
    round: 1,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      reasoning_effort: "high",
      max_tokens: 8000,

      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
}


// The build batches are the product — they get the same adversarial treatment
// as the plan. Inspector checks coverage + dependency order, Contrarian attacks
// scope + security. Blocking issues send the draft back to the Chair once.
export async function queueBatchesReview(admin: any, run: any, draftJson: any) {
  const manual = await loadFieldManual(admin);
  const plan = await loadLockedPlan(admin, run.project_id);
  const project = await loadProjectMeta(admin, run.project_id);
  const repoContract = await loadCompactBatchRepoContract(admin, project);
  const { data: design } = await admin
    .from("plan_versions")
    .select("content_md")
    .eq("project_id", run.project_id)
    .eq("kind", "design")
    .eq("is_build_safe", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const featuresBlock = Array.isArray(plan?.features) && plan!.features.length
    ? plan!.features.map((f: any) => `- [${f.priority}] ${f.name}: ${f.description}`).join("\n")
    : "(none listed)";
  const draftBlock = JSON.stringify(draftJson?.batches ?? [], null, 2);
  const shape = `Return ONLY valid JSON:
{
  "verdict": "approve" | "revise",
  "issues": [ { "batch_no": <number or null>, "severity": "blocking"|"major"|"minor", "text": "specific issue and the fix" } ]
}

Hard output limits (enforced by validator):
- issues array: MAX 8 items. Merge duplicates. Drop minor items if you must trim.
- issue.text: 10-280 characters. One tight sentence naming the batch, the exact problem, and the fix. No restating the draft or the plan.
- Total serialized JSON: <=4,500 characters. If close, cut wording, not blocking findings.

Verdict "approve" only if there are zero blocking issues. Every issue must cite either a live path from the LIVE REPO CONTRACT or the missing CREATE/ADD instruction it depends on.

Review rules (apply strictly):
- BLOCKING: any UPDATE target that does not appear verbatim in the LIVE REPO CONTRACT — the batch is invented; say which real path the student should use, or that the item should be labelled CREATE/ADD with dependencies sequenced first.
- BLOCKING: any schema/route/function name that contradicts the LIVE REPO CONTRACT (e.g. renamed table, wrong column, non-existent route).
- BLOCKING: any batch that asserts "React + Vite" (or any specific stack) as a universal rule when the LIVE REPO CONTRACT shows a different stack (e.g. src/routes/__root.tsx + @tanstack/react-start indicates TanStack Start, not React+Vite). Flag stack assumptions that don't match the detected stack.
- BLOCKING: any batch that asks Lovable to run browser tests in the SAME prompt as a large build change — verification must be a separate follow-up prompt.
- BLOCKING: test-tool mismatch — a lovable/UI batch that demands Deno edge tests, or a supabase/backend batch that demands browser-flow tests. Frontend uses Lovable's browser testing + optional frontend tests; backend uses direct edge-fn/RPC calls + Deno tests.
- NOT A FINDING: treating a filename alone as proof of a leaked secret. Public Supabase anon/publishable keys are not secret exposure. Only flag secrets when the batch itself embeds or exports actual secret material.`;

  const prompts: Record<string, string> = {
    inspector: `Batches review — Inspector. Check the drafted build sequence for coverage and dependency integrity:
- Every MVP feature in the PRD lands in some batch; name any orphan (blocking).
- Every OTHER feature in the FEATURES list lands in some batch (core or Enhancement); name any silently-dropped feature (major).
- No batch references a table, route, component, or function created in a LATER batch (blocking).
- Design tokens are installed before any feature work that uses them.
- Code batches carry acceptance checks a non-coder can run by clicks alone; skeleton followed exactly.

${manual}

${shape}`,
    contrarian: `Batches review — Contrarian. Attack the drafted build sequence:
- Any single batch too big for Lovable to execute faithfully in one paste (mixes concerns, >~5 files, vague items) — blocking; say how to split.
- Any table created without explicit access rules stated in plain words — blocking.
- Human-channel work (Stripe, OAuth, DNS) hidden inside a code batch — blocking.
- Scope creep beyond the locked plan — major; name the cut. (Clearly-labeled Enhancement batches carrying FEATURES-list items or DEFERRED VALUE are NOT scope creep — but newly invented scope inside them is.)

${manual}

${shape}`,
  };
  const compactPlan = compactMarkdown(plan?.content_md ?? "", COMPACT_ARTIFACT_CAP);
  const compactPrd = compactMarkdown(plan?.prd_md ?? "", COMPACT_ARTIFACT_CAP);
  const compactDesign = compactMarkdown(design?.content_md ?? "", COMPACT_ARTIFACT_CAP);
  const designSection = compactDesign
    ? `LOCKED DESIGN BRIEF (compact)\n\n${compactDesign}`
    : `NO LOCKED DESIGN BRIEF.`;
  const user = `${repoContract}\n\nLOCKED PLAN (compact)\n\n${compactPlan || "(no plan)"}\n\nPRD (compact)\n\n${compactPrd || "(no PRD)"}\n\nFEATURES\n\n${featuresBlock}\n\n${designSection}\n\nDRAFT BATCHES\n\n${draftBlock}\n\nProduce your JSON now.`;
  const rows = (["inspector", "contrarian"] as const).map((seat) => ({
    run_id: run.id,
    user_id: run.user_id,
    step_key: `batches_review_${seat}`,
    round: 2,
    seat,
    status: "queued",
    request: {
      json_output: true,
      temperature: 0.2,
      max_tokens: 2500,

      messages: [
        { role: "system", content: prompts[seat] },
        { role: "user", content: user },
      ],
    },
  }));
  await queueSteps(admin, run, rows);
}


export async function queueBatchesRevise(admin: any, run: any, draftJson: any, reviewSteps: any[]) {
  const manual = await loadFieldManual(admin);
  const plan = await loadLockedPlan(admin, run.project_id);
  const project = await loadProjectMeta(admin, run.project_id);
  const repoContract = await loadCompactBatchRepoContract(admin, project);
  const { data: design } = await admin
    .from("plan_versions")
    .select("content_md")
    .eq("project_id", run.project_id)
    .eq("kind", "design")
    .eq("is_build_safe", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const featuresBlock = Array.isArray(plan?.features) && plan!.features.length
    ? plan!.features.map((f: any) => `- [${f.priority}] ${f.name}: ${f.description}`).join("\n")
    : "(none listed)";
  const issues = reviewSteps
    .map((s: any) => `--- ${SEAT_LABEL[s.seat as Seat]} ---\n${JSON.stringify(s.response_json ?? { missing: true }, null, 2)}`)
    .join("\n\n");
  const isImport = !!project?.is_import;
  const revisePolicy = batchPromptPolicy(isImport);
  const batchRangeText = revisePolicy.rangeText;
  const batchCountRule = revisePolicy.countRule;
  const system = `Batches revision — you are the Chair. The Inspector and Contrarian reviewed your drafted build sequence and found issues. FIX every blocking issue and every major issue you agree with — do not merely acknowledge them. Keep every uncontested batch verbatim. The LIVE REPO CONTRACT outranks any guessed name in your original draft or the PRD; correct invented paths to the real ones, or relabel them CREATE/ADD with proper dependency ordering.

${manual}

OUTPUT DISCIPLINE (hard limits — the run FAILS if you exceed them):
- ${batchCountRule}
- Each prompt_md: 900-2,600 characters, MAX 8 numbered items, 2-4 acceptance checks for code batches.
- Do NOT restate plan/PRD prose, feature lists, or design tokens verbatim. Reference them by name.
- Total serialized JSON payload: <=24,000 characters. If you approach that, cut prose — not scope.

Return ONLY the same JSON shape as the original draft:
{
  "batches": [ { "batch_no": 1, "title": "...", "channel": "lovable"|"supabase"|"human", "prompt_md": "..." } ]
}

Constraints: ${batchRangeText} batches, unique ascending integer batch_no starting at 1, every prompt_md within character limits, following the batch skeleton exactly (numbered items, acceptance checks for code batches, "Keep everything else identical.", "Typecheck when done." for code batches). Never delete Enhancement batches to satisfy a reviewer unless the reviewer explicitly flagged them. For imported apps, NEVER pad to six batches to match a greenfield default.`;
  const compactPlan = compactMarkdown(plan?.content_md ?? "", COMPACT_ARTIFACT_CAP);
  const compactPrd = compactMarkdown(plan?.prd_md ?? "", COMPACT_ARTIFACT_CAP);
  const compactDesign = compactMarkdown(design?.content_md ?? "", COMPACT_ARTIFACT_CAP);
  const designSection = compactDesign
    ? `LOCKED DESIGN BRIEF (compact)\n\n${compactDesign}`
    : `NO LOCKED DESIGN BRIEF.`;
  const user = `${repoContract}\n\nLOCKED PLAN (compact)\n\n${compactPlan || "(no plan)"}\n\nPRD (compact)\n\n${compactPrd || "(no PRD)"}\n\nFEATURES\n\n${featuresBlock}\n\n${designSection}\n\nYOUR DRAFT\n\n${JSON.stringify(draftJson?.batches ?? [], null, 2)}\n\nREVIEW ISSUES\n\n${issues}\n\nProduce the revised JSON now.`;
  await queueSteps(admin, run, {
    run_id: run.id,
    user_id: run.user_id,
    step_key: "batches_revise_chair",
    round: 3,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      reasoning_effort: "high",
      max_tokens: 8000,

      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  });
}



export async function createInitialSteps(admin: any, run: any) {
  if (run.kind === "test") {
    // DIRECT INSERT (allow-listed): pipeline-health smoke test. The single
    // user message is a canned "reply with one sentence" — no artifacts, no
    // scope, no owner-authority-relevant surface.
    await admin.from("run_steps").insert({
      run_id: run.id,
      user_id: run.user_id,
      step_key: "r1_test_chair",
      round: 1,
      seat: "chair",
      status: "queued",
      request: {
        messages: [
          { role: "user", content: "Reply with exactly one sentence confirming the pipeline is live." },
        ],
      },
    });
    return;
  }
  if (run.kind === "plan" || run.kind === "design") {
    await queueRound1(admin, run);
    return;
  }
  if (run.kind === "batches") {
    await queueBatchesStep(admin, run);
    return;
  }
  if (run.kind === "change_request") {
    const crId = run.consensus?.change_request_id;
    if (!crId) {
      await admin.from("boardroom_runs").update({ status: "failed", error: "Missing change_request_id" }).eq("id", run.id);
      return;
    }
    // Tenant scoping: id + run.project_id + run.user_id. A CR from another
    // project/owner must never seed steps for this run.
    const { data: activeCr } = await admin
      .from("change_requests")
      .select("*")
      .eq("id", crId)
      .eq("project_id", run.project_id)
      .eq("user_id", run.user_id)
      .maybeSingle();
    if (!activeCr) {
      await admin.from("boardroom_runs").update({ status: "failed", error: "Change request not found" }).eq("id", run.id);
      return;
    }
    const { data: plan } = await admin
      .from("plan_versions")
      .select("content_md, prd_md")
      .eq("project_id", run.project_id)
      .eq("kind", "plan")
      .eq("is_build_safe", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    await queueChangeRequestExam(admin, run, activeCr, plan ?? {});
    return;
  }
  await admin
    .from("boardroom_runs")
    .update({ status: "paused", consensus: { awaiting: "future_batch" } })
    .eq("id", run.id);
}


// ============================== Audit helpers ==============================

import {
  buildMergeInput,
  CAPS as AF_CAPS,
  FINDING_SCHEMA_DOC,
  normalizeFindings,
} from "../_shared/audit-findings.ts";

export async function queueAuditChairMerge(admin: any, run: any, steps: any[]) {
  // Collect every completed seat report — single-chunk (audit_<seat>) and
  // map-reduce chunked (audit_<seat>_cN) alike. Strip prose/prompt/raw
  // repo and ship only normalized finding objects to the Chair. See
  // _shared/audit-findings.ts for the payload cap.
  const seatSteps = steps.filter(
    (x: any) => /^audit_(inspector|contrarian|strategist)/.test(x.step_key) && x.status === "completed",
  );
  const seatReports = seatSteps.map((st: any) => ({
    step_key: st.step_key,
    seat: String(st.seat ?? ""),
    findings: normalizeFindings(
      Array.isArray(st.response_json?.findings) ? st.response_json.findings : [],
      String(st.seat ?? ""),
    ),
  }));
  const { block, totalFindings } = buildMergeInput(seatReports);
  const isFinal = run.consensus?.audit_kind === "final_az";
  const system = `You are the Chair. The seats independently reviewed the student's code — possibly split across chunks, so the same underlying issue may be reported more than once. Merge, dedupe across seats AND chunks, assign FINAL severities, and produce ONE audit report.

Severities:
- P0: broken build, data loss risk, auth/RLS bypass, secret exposure (an actual private credential, not a public anon key).
- P1: contract miss (batch/PRD says X, code does Y), critical UX flow broken, insecure default.
- P2: notable UX / copy / design-brief drift, minor a11y, small refactor.
- P3: nits and polish suggestions.

P0/P1 MUST have concrete repo-relative file_path, evidence containing a verbatim "QUOTE: <exact excerpt> | WHY: <reason>" pair from the cited file, and confidence high/medium. If you can only justify a filename, a category of risk, or a semantic paraphrase without a quote, downgrade to P2 — the validator will do it anyway. Cumulative-ledger rule: an older SQL migration is NOT proof of current effective state; corroborate against later migrations, current grants/policies/triggers, or current code before promoting to P0/P1. Client-side route/UI role checks are navigation UX, not the authorization boundary; do NOT call them an exploit unless the server (RLS/RPC/edge/security-definer) is concretely bypassable with a QUOTE. Do NOT invent security-contract requirements (e.g. profiles.role is not automatically unsafe when triggers/policies prevent self-mutation). Cross-file composition counts: seats do NOT share the identical full prompt — callSeat in supabase/functions/_shared/openrouter-proxy.ts prepends the constitution and each model_registry.role_prompt before the shared task system message; do not assert absence without a QUOTE from the wrapper.

${FINDING_SCHEMA_DOC}

Return ONLY valid JSON:
{
  "verdict": "clean" | "findings",
  "summary": "one paragraph",
  "findings": [ ...findings objects... ],
  "fix_prompt_md": "Full Lovable-ready fix batch prompt (REQUIRED if any supported P0/P1 exists after downgrade). Follow the batch skeleton: 'Batch N.M — <name>. Numbered items only, no scope creep.\\n\\n1. ...\\n\\nAcceptance checks:\\n1. ...\\n\\nKeep everything else identical.\\nTypecheck when done.' Cite the exact file_path (and lines when present) from the evidence in each item."${isFinal ? `,
  "final_qa_prompt_md": "Human QA batch prompt (channel 'human'). Numbered checks the student runs by hand.",
  "test_script": ["step 1", "step 2", "..."]` : ""}
}

Hard output limits (enforced by validator — over-emission FAILS the merge):
- MAX ${AF_CAPS.mergeFindingsMax} deduplicated findings. If more than ${AF_CAPS.mergeFindingsMax} unique serious findings exist, keep the ${AF_CAPS.mergeFindingsMax} strongest-evidence / highest-confidence items (prioritise concrete high-confidence P0/P1, then strongest P2/P3; merge duplicate root causes across seats and chunks). Never invent evidence to promote a finding. Reflect omitted items in the summary and counts metadata rather than exceeding the cap.
- Total serialized findings JSON <= ${AF_CAPS.mergeSerializedMax} characters — compress evidence, never drop supported P0/P1.
- summary <= ${AF_CAPS.mergeSummaryMax} characters.
- title <= ${AF_CAPS.mergeTitleMax}, description <= ${AF_CAPS.mergeDescriptionMax}, evidence <= ${AF_CAPS.mergeEvidenceMax}.

Output discipline: emit ONE valid JSON object on ONE line — no prose, no code fences, no leading/trailing whitespace, no explanations.

If verdict is "clean", findings is [] and fix_prompt_md is "".

Coverage honesty: the summary must state how much of the app was actually read (the CODE COVERAGE line below). Never imply full A-Z coverage beyond what the seats reviewed.`;

  // DIRECT INSERT (allow-listed): audit merge. Input is pre-normalized,
  // prose-stripped seat findings only (see buildMergeInput). The Chair
  // dedupes and assigns final severities against deterministic caps and
  // validators; no plan/PRD/features/design/CR scope can be introduced here.
  await admin.from("run_steps").insert({
    run_id: run.id,
    user_id: run.user_id,
    step_key: "audit_chair_merge",
    round: 2,
    seat: "chair",
    status: "queued",
    request: {
      json_output: true,
      reasoning_effort: "low",
      max_tokens: 6500,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `CODE COVERAGE: ${Number(run.consensus?.files_analyzed ?? 0) || "unknown"} files were read across the seat steps.\n\nNORMALIZED SEAT FINDINGS (${totalFindings} across ${seatReports.length} steps — prose stripped)\n\n${block}\n\nMerge, dedupe, downgrade unsupported serious claims, and produce your JSON now.`,
        },
      ],
    },
  });
}
