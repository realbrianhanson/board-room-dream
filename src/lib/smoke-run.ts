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

export type SmokeRunOptions = {
  /**
   * Route the smoke's seat calls through the Cloudflare executor regardless of
   * `app_settings.executor.enabled` (stored as `consensus.executor` on the run).
   * Only honoured server-side when `smoke === true`.
   */
  executor?: boolean;
};

/** The edge function + body that starts a smoke run of `kind` for `projectId`. */
export function smokeRunRequest(kind: SmokeKind, projectId: string, opts?: SmokeRunOptions): SmokeRunRequest {
  const executor = opts?.executor === true ? { executor: true } : {};
  if (kind === "audit") {
    return {
      fn: "audit-runner",
      body: { action: "start_final_audit", project_id: projectId, source: "github", smoke: true, ...executor },
    };
  }
  return {
    fn: "boardroom-orchestrator",
    body: { action: "start_run", project_id: projectId, kind, smoke: true, ...executor },
  };
}

/** Toast copy for a successful function response. */
export function smokeRunOutcome(data: unknown): string {
  const d = (data ?? {}) as { existing?: boolean; run_id?: string; status?: string };
  if (d.existing) return `A run of this kind is already active (${d.status ?? "running"}) — nothing new was started.`;
  if (d.run_id) return `Smoke run queued (${d.run_id.slice(0, 8)}). Budget $1.`;
  return "Smoke run queued.";
}

// ---- Remembered selection -------------------------------------------------

export const SMOKE_DEFAULT_KIND: SmokeKind = "batches";
export const SMOKE_LAST_KEY = "boardroom.smoke.last";

export type SmokeLastSelection = { projectId?: string; kind?: SmokeKind };

export function isSmokeKind(v: unknown): v is SmokeKind {
  return typeof v === "string" && (SMOKE_KINDS as readonly string[]).includes(v);
}

/** Parse the stored selection; anything malformed is an empty selection. */
export function parseSmokeLast(raw: string | null | undefined): SmokeLastSelection {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as { projectId?: unknown; kind?: unknown } | null;
    if (!v || typeof v !== "object") return {};
    return {
      ...(typeof v.projectId === "string" && v.projectId ? { projectId: v.projectId } : {}),
      ...(isSmokeKind(v.kind) ? { kind: v.kind } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The project + kind to show once the projects list has loaded: the remembered
 * project when it is still in the list (else the first project), the
 * remembered kind when valid (else the default).
 */
export function restoreSmokeSelection(
  last: SmokeLastSelection,
  projects: ReadonlyArray<{ id: string }>,
): { projectId: string; kind: SmokeKind } {
  const remembered = last.projectId && projects.some((p) => p.id === last.projectId) ? last.projectId : "";
  return {
    projectId: remembered || projects[0]?.id || "",
    kind: last.kind ?? SMOKE_DEFAULT_KIND,
  };
}

/** Read the remembered selection from localStorage; never throws. */
export function readSmokeLast(): SmokeLastSelection {
  try {
    if (typeof localStorage === "undefined") return {};
    return parseSmokeLast(localStorage.getItem(SMOKE_LAST_KEY));
  } catch {
    return {};
  }
}

/** Remember the selection in localStorage; never throws. */
export function writeSmokeLast(sel: SmokeLastSelection): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SMOKE_LAST_KEY, JSON.stringify(sel));
  } catch {
    // Private mode / quota / disabled storage: the choice is simply not remembered.
  }
}
