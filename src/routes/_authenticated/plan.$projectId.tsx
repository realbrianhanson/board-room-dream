import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Download, Gavel, MessageSquarePlus, History as HistoryIcon } from "lucide-react";

export const Route = createFileRoute("/_authenticated/plan/$projectId")({
  component: PlanWorkspacePage,
});

type Project = { id: string; name: string; user_id: string; status: string };
type Feature = { name: string; description: string; priority: "mvp" | "later" };
type DecisionEntry = {
  from_seat?: string;
  objection?: string;
  decision?: string;
  reason?: string;
  change_request_id?: string;
  rationale?: string;
};
type PlanVersion = {
  id: string;
  project_id: string;
  version: number;
  content_md: string;
  prd_md: string | null;
  features: Feature[] | null;
  decision_log: DecisionEntry[] | null;
  is_chair_ruled: boolean;
  dissent_ledger: Array<{ seat: string; objection: string; chair_response?: string }> | null;
  locked_at: string;
  source_run_id: string | null;
  is_build_safe: boolean;
  invalidated_reason: string | null;
};
type ChangeRequest = {
  id: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  board_verdict: {
    rationale?: string;
    verdict?: string;
    new_plan_version_id?: string | null;
  } | null;
  run_id: string | null;
  created_at: string;
};
type Run = { id: string; kind: string; status: string };
type TabKey = "plan" | "prd" | "features" | "decisions" | "history";

function PlanWorkspacePage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<PlanVersion[] | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("plan");
  const [crs, setCrs] = useState<ChangeRequest[]>([]);
  const [activeCrRun, setActiveCrRun] = useState<Run | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setPlanError(null);
      const { data: userData } = await supabase.auth.getUser();
      if (cancelled) return;
      setMe(userData.user?.id ?? null);

      const { data: proj, error: projErr } = await supabase
        .from("projects")
        .select("id, name, user_id, status")
        .eq("id", projectId)
        .maybeSingle();
      if (cancelled) return;
      if (projErr) {
        setPlanError(projErr.message);
        setLoading(false);
        return;
      }
      if (!proj) {
        toast.error("Project not found");
        navigate({ to: "/dashboard" });
        return;
      }
      setProject(proj as Project);

      // A failure loading plan_versions must NOT coerce to empty list — that
      // would render the "No build-safe plan yet" reconvene state for a
      // transient RLS/network failure and hide a retryable problem.
      const { data: pvs, error: pvErr } = await supabase
        .from("plan_versions")
        .select(
          "id, project_id, version, content_md, prd_md, features, decision_log, is_chair_ruled, dissent_ledger, locked_at, source_run_id, is_build_safe, invalidated_reason",
        )
        .eq("project_id", projectId)
        .eq("kind", "plan")
        .order("version", { ascending: false });
      if (cancelled) return;
      if (pvErr) {
        setPlanError(pvErr.message);
        setLoading(false);
        return;
      }
      const list = (pvs ?? []) as unknown as PlanVersion[];
      setVersions(list);
      const initialSafe = list.find((v) => v.is_build_safe);
      setSelectedVersionId(initialSafe?.id ?? list[0]?.id ?? null);

      const { data: crList, error: crErr } = await supabase
        .from("change_requests")
        .select("id, description, status, board_verdict, run_id, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (crErr) {
        setPlanError(crErr.message);
        setLoading(false);
        return;
      }
      setCrs((crList ?? []) as unknown as ChangeRequest[]);

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, navigate, loadTick]);

  // Realtime: plan_versions + change_requests + boardroom_runs for this project
  useEffect(() => {
    const channel = supabase
      .channel(`plan-workspace-${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "plan_versions", filter: `project_id=eq.${projectId}` },
        async () => {
          const { data: pvs } = await supabase
            .from("plan_versions")
            .select(
              "id, project_id, version, content_md, prd_md, features, decision_log, is_chair_ruled, dissent_ledger, locked_at, source_run_id, is_build_safe, invalidated_reason",
            )
            .eq("project_id", projectId)
            .eq("kind", "plan")
            .order("version", { ascending: false });
          setVersions((prev) => {
            const next = (pvs ?? []) as unknown as PlanVersion[];
            // Prefer the newest build-safe version; fall back only to keep the
            // list non-empty (History still needs a selection).
            const fallbackId = next.find((v) => v.is_build_safe)?.id ?? next[0]?.id ?? null;
            setSelectedVersionId((currentId) => {
              if (!currentId) return fallbackId;
              return next.some((v) => v.id === currentId) ? currentId : fallbackId;
            });
            void prev;
            return next;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "change_requests", filter: `project_id=eq.${projectId}` },
        async () => {
          const { data: crList } = await supabase
            .from("change_requests")
            .select("id, description, status, board_verdict, run_id, created_at")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false });
          setCrs((crList ?? []) as unknown as ChangeRequest[]);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "boardroom_runs", filter: `project_id=eq.${projectId}` },
        (payload) => {
          const row = payload.new as Run | undefined;
          if (row && row.kind === "change_request") {
            const active = ["queued", "running", "paused", "paused_budget"].includes(row.status);
            setActiveCrRun(active ? row : null);
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  // Also fetch any currently active CR run
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("boardroom_runs")
        .select("id, kind, status")
        .eq("project_id", projectId)
        .eq("kind", "change_request")
        .in("status", ["queued", "running", "paused", "paused_budget"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setActiveCrRun((data as Run) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // "Current" plan means the newest BUILD-SAFE version. Unsafe rows may
  // exist in history but never present as current.
  const current = versions?.find((v) => v.is_build_safe) ?? null;
  const selected = useMemo(
    () => versions?.find((v) => v.id === selectedVersionId) ?? current,
    [versions, selectedVersionId, current],
  );
  const isOwner = !!(me && project && me === project.user_id);
  const isViewingOlder = !!(current && selected && selected.id !== current.id);
  const selectedUnsafe = !!(selected && !selected.is_build_safe);

  // Blueprint drafting state: current exists but has no prd yet (r5 running)
  const blueprintDrafting = !!(current && !current.prd_md);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-16">
        <div className="h-64 animate-pulse rounded-xl bg-surface-1" />
      </div>
    );
  }
  if (!project) return null;

  // No build-safe plan yet: show the legacy warning + links. Do not surface
  // an unsafe version as current, and do not render the CR form.
  if (!current) {
    const hasLegacy = (versions ?? []).length > 0;
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <Link
          to="/boardroom/$projectId"
          params={{ projectId }}
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground"
        >
          ← Boardroom
        </Link>
        <h1 className="mt-3 font-display text-3xl text-foreground">No build-safe plan yet.</h1>
        {hasLegacy ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Earlier plan versions exist but predate the current founder-authority rules
            and are marked <span className="font-mono text-foreground/80">legacy · not build-safe</span>.
            Reconvene the board to produce a build-safe result before filing change requests
            or generating batches.
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            The board hasn't reached consensus on this project.
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/boardroom/$projectId"
            params={{ projectId }}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
          >
            To the Boardroom
          </Link>
          <Link
            to="/audits/$projectId"
            params={{ projectId }}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-1 px-4 py-2 text-sm text-foreground hover:border-primary/40"
          >
            Audits
          </Link>
        </div>
        {hasLegacy && (
          <div className="mt-10">
            <HistoryTab
              versions={versions ?? []}
              selectedId=""
              onSelect={() => { /* history-only preview elsewhere */ }}
            />
          </div>
        )}
      </div>
    );
  }
  if (!selected) return null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:py-14">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/boardroom/$projectId"
            params={{ projectId }}
            className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground"
          >
            ← Boardroom
          </Link>
          <h1 className="mt-3 truncate font-display text-4xl leading-tight text-foreground">
            {project.name}
          </h1>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            The plan is locked · {new Date(current.locked_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            v{current.version}
          </span>
          {current.is_chair_ruled && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.08)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-[hsl(38_65%_70%)]">
              <Gavel className="h-3 w-3" />
              Chair ruled
            </span>
          )}
        </div>
      </div>

      {isViewingOlder && !selectedUnsafe && (
        <div className="mt-6 rounded-md border border-[hsl(38_65%_55%/0.35)] bg-[hsl(38_65%_55%/0.06)] px-4 py-2.5 font-mono text-[11px] text-[hsl(38_65%_75%)]">
          Viewing v{selected.version} — the board's current plan is v{current.version}.
        </div>
      )}
      {selectedUnsafe && (
        <div className="mt-6 rounded-md border border-[hsl(38_65%_55%/0.35)] bg-[hsl(38_65%_55%/0.06)] px-4 py-2.5 font-mono text-[11px] text-[hsl(38_65%_75%)]">
          Legacy · not build-safe{selected.invalidated_reason ? ` — ${selected.invalidated_reason}` : ""}. Read-only. The current build-safe plan is v{current.version}.
        </div>
      )}

      {/* Tabs */}
      <div className="mt-8 flex flex-wrap gap-1 border-b border-border">
        {(
          [
            ["plan", "Plan"],
            ["prd", "PRD"],
            ["features", "Features"],
            ["decisions", "Decision log"],
            ["history", "History"],
          ] as Array<[TabKey, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`relative px-4 py-2.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              tab === key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            }`}
          >
            {label}
            {tab === key && (
              <span className="absolute inset-x-2 -bottom-px h-[2px] bg-primary" />
            )}
          </button>
        ))}
      </div>

      <div className="mt-8">
        {tab === "plan" && (
          <PlanTab plan={selected} projectName={project.name} />
        )}
        {tab === "prd" && (
          <PrdTab plan={selected} projectName={project.name} blueprintDrafting={blueprintDrafting && selected.id === current.id} />
        )}
        {tab === "features" && <FeaturesTab plan={selected} />}
        {tab === "decisions" && <DecisionsTab plan={selected} />}
        {tab === "history" && (
          <HistoryTab
            versions={versions ?? []}
            selectedId={selected.id}
            onSelect={(id) => {
              setSelectedVersionId(id);
              setTab("plan");
            }}
          />
        )}
      </div>

      {/* Change requests panel */}
      <div className="mt-14">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <MessageSquarePlus className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-display text-lg text-foreground">Change requests</h2>
        </div>
        {isOwner ? (
          selectedUnsafe ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Change requests target the current build-safe plan (v{current.version}). Switch to it to file one.
            </p>
          ) : isViewingOlder ? (
            <div className="mt-4 rounded-md border border-border bg-surface-2 p-4 text-sm text-muted-foreground">
              You're viewing v{selected.version}. Change requests always submit against the newest plan (v{current.version}).
              <button
                type="button"
                onClick={() => setSelectedVersionId(current.id)}
                className="ml-2 text-primary underline-offset-2 hover:underline"
              >
                Switch to v{current.version} to file one
              </button>
            </div>
          ) : (
            <ChangeRequestForm
              projectId={projectId}
              disabled={!!activeCrRun}
              onSubmitted={() => {
                // Realtime will refresh
              }}
            />
          )
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Instructor view — read-only.
          </p>
        )}
        <CRList crs={crs} versions={versions ?? []} onOpenVersion={(id) => { setSelectedVersionId(id); setTab("plan"); }} />
      </div>
    </div>
  );
}

// ============================== Tabs ==============================

function downloadMd(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
}

function PlanTab({ plan, projectName }: { plan: PlanVersion; projectName: string }) {
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={() =>
            downloadMd(`${slugify(projectName)}-plan-v${plan.version}.md`, plan.content_md)
          }
          className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-foreground hover:bg-surface-2"
        >
          <Download className="h-3.5 w-3.5" />
          Download .md
        </button>
      </div>
      <article className="prose prose-invert max-w-[70ch] text-[15px] leading-[1.7] text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.content_md}</ReactMarkdown>
      </article>
      {plan.is_chair_ruled && plan.dissent_ledger && plan.dissent_ledger.length > 0 && (
        <div className="mt-10 rounded-xl border border-border bg-surface-1 p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Dissent ledger
          </p>
          <div className="mt-4 space-y-3">
            {plan.dissent_ledger.map((d, i) => (
              <div key={i} className="rounded-md border border-border/60 bg-surface-2/40 p-3">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {d.seat}
                </p>
                <p className="mt-1 text-sm text-foreground/90">{d.objection}</p>
                {d.chair_response && (
                  <p className="mt-2 text-xs italic text-muted-foreground">
                    Chair: {d.chair_response}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PrdTab({
  plan,
  projectName,
  blueprintDrafting,
}: {
  plan: PlanVersion;
  projectName: string;
  blueprintDrafting: boolean;
}) {
  if (!plan.prd_md) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-14 text-center">
        <p className="font-display text-xl text-foreground">
          {blueprintDrafting ? "The Chair is drafting the blueprint…" : "No blueprint on this version."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {blueprintDrafting
            ? "PRD and features arrive when the Blueprint step completes."
            : "This version predates the Blueprint step."}
        </p>
        {blueprintDrafting && (
          <div className="mx-auto mt-6 max-w-md space-y-2">
            <div className="h-2 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-2 w-full animate-pulse rounded bg-surface-2" />
            <div className="h-2 w-5/6 animate-pulse rounded bg-surface-2" />
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={() =>
            downloadMd(`${slugify(projectName)}-prd-v${plan.version}.md`, plan.prd_md ?? "")
          }
          className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-foreground hover:bg-surface-2"
        >
          <Download className="h-3.5 w-3.5" />
          Download .md
        </button>
      </div>
      <article className="prose prose-invert max-w-[70ch] text-[15px] leading-[1.7] text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.prd_md}</ReactMarkdown>
      </article>
    </div>
  );
}

function FeaturesTab({ plan }: { plan: PlanVersion }) {
  const features = plan.features ?? [];
  if (features.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-14 text-center">
        <p className="font-display text-xl text-foreground">No features listed yet.</p>
        <p className="mt-2 text-sm text-muted-foreground">The Blueprint step produces the features list.</p>
      </div>
    );
  }
  const mvp = features.filter((f) => f.priority === "mvp");
  const later = features.filter((f) => f.priority !== "mvp");
  return (
    <div className="space-y-10">
      <FeatureGroup title="MVP" tone="brass" features={mvp} />
      {later.length > 0 && <FeatureGroup title="Later" tone="muted" features={later} />}
    </div>
  );
}

function FeatureGroup({
  title,
  tone,
  features,
}: {
  title: string;
  tone: "brass" | "muted";
  features: Feature[];
}) {
  if (features.length === 0) return null;
  const chipClass =
    tone === "brass"
      ? "border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.08)] text-[hsl(38_65%_70%)]"
      : "border-border bg-surface-2 text-muted-foreground";
  return (
    <div>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        {title} · {features.length}
      </h3>
      <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border bg-surface-1">
        {features.map((f, i) => (
          <div key={i} className="flex items-start justify-between gap-4 p-5">
            <div className="min-w-0">
              <p className="font-display text-[15px] text-foreground">{f.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{f.description}</p>
            </div>
            <span
              className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${chipClass}`}
            >
              {f.priority}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionsTab({ plan }: { plan: PlanVersion }) {
  const log = plan.decision_log ?? [];
  const hasDissent = plan.is_chair_ruled && plan.dissent_ledger && plan.dissent_ledger.length > 0;
  if (log.length === 0 && !hasDissent) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-14 text-center">
        <p className="font-display text-xl text-foreground">No decisions recorded.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {log.map((d, i) => {
        const isAccepted = d.decision === "accepted";
        const isRejected = d.decision === "rejected";
        const isCr = !!d.change_request_id;
        const borderColor = isAccepted
          ? "border-l-[hsl(160_45%_48%)]"
          : isRejected
            ? "border-l-[hsl(8_60%_55%)]"
            : "border-l-primary/60";
        return (
          <div
            key={i}
            className={`rounded-md border border-border ${borderColor} border-l-4 bg-surface-1 p-4`}
          >
            <div className="flex items-center gap-2">
              {d.from_seat && (
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {d.from_seat}
                </span>
              )}
              {d.decision && (
                <span
                  className={`font-mono text-[10px] uppercase tracking-widest ${
                    isAccepted
                      ? "text-[hsl(160_45%_65%)]"
                      : isRejected
                        ? "text-[hsl(8_60%_70%)]"
                        : "text-primary"
                  }`}
                >
                  · {d.decision}
                </span>
              )}
              {isCr && (
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  · change request
                </span>
              )}
            </div>
            {d.objection && (
              <p className="mt-2 text-sm text-foreground/90">{d.objection}</p>
            )}
            {d.reason && (
              <p className="mt-1 text-xs italic text-muted-foreground">{d.reason}</p>
            )}
            {d.rationale && (
              <p className="mt-1 text-xs italic text-muted-foreground">{d.rationale}</p>
            )}
          </div>
        );
      })}
      {hasDissent && (
        <div className="mt-8 rounded-xl border border-border bg-surface-1 p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Dissent ledger
          </p>
          <div className="mt-4 space-y-3">
            {plan.dissent_ledger!.map((d, i) => (
              <div key={i} className="rounded-md border border-border/60 bg-surface-2/40 p-3">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {d.seat}
                </p>
                <p className="mt-1 text-sm text-foreground/90">{d.objection}</p>
                {d.chair_response && (
                  <p className="mt-2 text-xs italic text-muted-foreground">
                    Chair: {d.chair_response}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryTab({
  versions,
  selectedId,
  onSelect,
}: {
  versions: PlanVersion[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (versions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-14 text-center">
        <p className="font-display text-xl text-foreground">No versions yet.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {versions.map((v) => {
        const isSelected = v.id === selectedId;
        return (
          <button
            key={v.id}
            onClick={() => onSelect(v.id)}
            className={`w-full rounded-xl border p-5 text-left transition-colors ${
              isSelected
                ? "border-primary/50 bg-surface-2"
                : "border-border bg-surface-1 hover:border-primary/30 hover:bg-surface-2"
            }`}
          >
            <div className="flex items-center gap-3">
              <HistoryIcon className="h-4 w-4 text-muted-foreground" />
              <span className="font-display text-lg text-foreground">v{v.version}</span>
              {v.is_chair_ruled && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.08)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-[hsl(38_65%_70%)]">
                  <Gavel className="h-2.5 w-2.5" />
                  Chair ruled
                </span>
              )}
              {!v.is_build_safe && (
                <span
                  title={v.invalidated_reason ?? undefined}
                  className="inline-flex items-center gap-1 rounded-full border border-[hsl(8_60%_45%/0.45)] bg-[hsl(8_60%_45%/0.08)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-[hsl(8_60%_70%)]"
                >
                  Legacy · not build-safe
                </span>
              )}
              <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {new Date(v.locked_at).toLocaleDateString()}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ============================== Change requests ==============================

function ChangeRequestForm({
  projectId,
  disabled,
  onSubmitted,
}: {
  projectId: string;
  disabled: boolean;
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || submitting) return;
    setSubmitting(true);
    let createdCrId: string | null = null;
    let userId: string | null = null;
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      userId = userData.user.id;
      const { data: plan } = await supabase
        .from("plan_versions")
        .select("id")
        .eq("project_id", projectId)
        .eq("kind", "plan")
        .eq("is_build_safe", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!plan?.id) {
        throw new Error(
          "No build-safe plan yet. Reconvene the board before filing a change request.",
        );
      }
      const { data: cr, error: crErr } = await supabase
        .from("change_requests")
        .insert({
          project_id: projectId,
          user_id: userId,
          plan_version_id: plan.id,
          description: description.trim(),
        })
        .select("id")
        .single();
      if (crErr) throw crErr;
      createdCrId = cr.id;

      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/boardroom-orchestrator`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "start_run",
          project_id: projectId,
          kind: "change_request",
          change_request_id: createdCrId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error ?? "Failed to convene the board");
      }
      // Success — do NOT compensate.
      createdCrId = null;
      toast.success("Change request sent to the board.");
      setDescription("");
      setOpen(false);
      onSubmitted();
    } catch (err) {
      // Deterministic compensation: if the CR was inserted but the run never
      // bound (invoke rejected, threw, or returned non-ok), re-read to confirm
      // it is still owner-scoped + pending + run_id null, then delete. Never
      // touch a CR that already acquired a run_id or moved past 'pending'.
      if (createdCrId && userId) {
        try {
          const { data: current } = await supabase
            .from("change_requests")
            .select("id, status, run_id, user_id, project_id")
            .eq("id", createdCrId)
            .eq("project_id", projectId)
            .eq("user_id", userId)
            .maybeSingle();
          if (
            current &&
            current.status === "pending" &&
            current.run_id == null &&
            current.user_id === userId &&
            current.project_id === projectId
          ) {
            await supabase
              .from("change_requests")
              .delete()
              .eq("id", createdCrId)
              .eq("project_id", projectId)
              .eq("user_id", userId)
              .eq("status", "pending")
              .is("run_id", null);
          }
        } catch {
          // Best-effort compensation; realtime will still reflect the row.
        }
      }
      toast.error(`${(err as Error).message}. Try again.`);
    } finally {
      setSubmitting(false);
    }
  }

  if (disabled) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-border bg-surface-1/50 p-5">
        <p className="font-display text-sm text-foreground">The board is in session on your request.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          You can file another change once the current verdict lands.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-6 flex items-center justify-between rounded-xl border border-dashed border-border bg-surface-1/50 p-5">
        <div>
          <p className="font-display text-sm text-foreground">Something needs to change?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            A locked plan is a contract. The board must approve any change.
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
        >
          <MessageSquarePlus className="h-4 w-4" />
          Request a change
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 rounded-xl border border-border bg-surface-1 p-6">
      <p className="font-display text-sm text-foreground">Request a change</p>
      <p className="mt-1 text-xs text-muted-foreground">
        A locked plan is a contract. The board must approve any change.
      </p>
      <textarea
        autoFocus
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe the change — what should be different, and why?"
        rows={5}
        className="mt-4 w-full rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
      />
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={submitting || !description.trim()}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Send to the board"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setDescription(""); }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function CRList({
  crs,
  versions,
  onOpenVersion,
}: {
  crs: ChangeRequest[];
  versions: PlanVersion[];
  onOpenVersion: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (crs.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">No change requests yet.</p>
    );
  }
  return (
    <div className="mt-6 space-y-3">
      {crs.map((cr) => {
        const isOpen = !!expanded[cr.id];
        const chip =
          cr.status === "approved"
            ? "border-[hsl(160_45%_48%/0.4)] bg-[hsl(160_45%_48%/0.08)] text-[hsl(160_45%_65%)]"
            : cr.status === "rejected"
              ? "border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.08)] text-[hsl(8_60%_70%)]"
              : "border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.08)] text-[hsl(38_65%_70%)]";
        const newVersion = cr.board_verdict?.new_plan_version_id
          ? versions.find((v) => v.id === cr.board_verdict!.new_plan_version_id) ?? null
          : null;
        return (
          <div key={cr.id} className="rounded-xl border border-border bg-surface-1 p-5">
            <button
              onClick={() => setExpanded((e) => ({ ...e, [cr.id]: !isOpen }))}
              className="flex w-full items-start justify-between gap-4 text-left"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground/90">{cr.description}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {new Date(cr.created_at).toLocaleDateString()}
                </p>
              </div>
              <span className={`shrink-0 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-widest ${chip}`}>
                {cr.status}
              </span>
            </button>
            {isOpen && (
              <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
                {cr.board_verdict?.rationale && (
                  <p className="text-sm text-foreground/90">{cr.board_verdict.rationale}</p>
                )}
                {cr.status === "approved" && newVersion && (
                  <button
                    onClick={() => onOpenVersion(newVersion.id)}
                    className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:brightness-110"
                  >
                    Created v{newVersion.version} →
                  </button>
                )}
                {cr.status === "pending" && (
                  <p className="text-xs text-muted-foreground">The board is deliberating.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
