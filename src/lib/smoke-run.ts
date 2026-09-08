// Pure helpers for the admin-only "Smoke run" panel in Settings. A smoke run
// is the $1 rehearsal of a run kind (one audit chunk with one seat, three
// batches with one reviewer, a plan/design with no revision loops), served by
// the cheap smoke model. Kept free of React/Supabase so the request shapes
// and outcome copy can be unit-tested.

export const SMOKE_KINDS = ["audit", "batches", "plan", "design"] as const;
export type SmokeKind = (typeof SMOKE_KINDS)[number];

export const SMOKE_KIND_LABEL: Record<SmokeKind, string> = {
  audit: "Audit — one chunk, inspector only, then the Chair merge",
  batches: "Batches — three batches, one reviewer",
  plan: "Plan — no revision loops, no repo sample",
  design: "Design — no revision loops, no repo sample",
};

export type SmokeRunRequest = {
  fn: "audit-runner" | "boardroom-orchestrator";
  body: Record<string, unknown>;
};

/** The edge function + body that starts a smoke run of `kind` for `projectId`. */
export function smokeRunRequest(kind: SmokeKind, projectId: string): SmokeRunRequest {
  if (kind === "audit") {
    return {
      fn: "audit-runner",
      body: { action: "start_final_audit", project_id: projectId, source: "github", smoke: true },
    };
  }
  return {
    fn: "boardroom-orchestrator",
    body: { action: "start_run", project_id: projectId, kind, smoke: true },
  };
}

/** Toast copy for a successful function response. */
export function smokeRunOutcome(data: unknown): string {
  const d = (data ?? {}) as { existing?: boolean; run_id?: string; status?: string };
  if (d.existing) return `A run of this kind is already active (${d.status ?? "running"}) — nothing new was started.`;
  if (d.run_id) return `Smoke run queued (${d.run_id.slice(0, 8)}). Budget $1.`;
  return "Smoke run queued.";
}
