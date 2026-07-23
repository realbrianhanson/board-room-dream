import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/debug/runs")({
  component: DebugRunsPage,
});

type RunRow = {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  round_no: number;
  spent_usd: number;
  budget_usd: number;
  budget_warning: boolean;
  error: string | null;
  created_at: string;
};
type StepRow = {
  id: string;
  step_key: string;
  seat: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string | null;
  response_text: string | null;
};
type ProjectRow = { id: string; name: string };

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: "border-border bg-surface-2 text-muted-foreground",
    running: "border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.12)] text-[hsl(38_65%_70%)]",
    completed: "border-[hsl(160_45%_42%/0.4)] bg-[hsl(160_45%_42%/0.12)] text-[hsl(160_45%_62%)]",
    consensus: "border-[hsl(160_45%_42%/0.4)] bg-[hsl(160_45%_42%/0.12)] text-[hsl(160_45%_62%)]",
    paused: "border-border bg-surface-2 text-muted-foreground",
    paused_budget: "border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.12)] text-[hsl(8_60%_65%)]",
    failed: "border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_45%/0.12)] text-[hsl(8_60%_65%)]",
    skipped: "border-border bg-surface-2 text-muted-foreground",
  };
  const cls = map[status] ?? map.queued;
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${cls}`}>
      {status}
    </span>
  );
}

function DebugRunsPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [steps, setSteps] = useState<Record<string, StepRow[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("role")
      .maybeSingle();
    if (profErr) {
      setIsAdmin(false);
      setLoadError(profErr.message);
      setLoading(false);
      return;
    }
    const admin = profile?.role === "admin";
    setIsAdmin(admin);
    if (!admin) {
      setLoading(false);
      return;
    }
    const [runsRes, projRes] = await Promise.all([
      supabase
        .from("boardroom_runs")
        .select("id, project_id, kind, status, round_no, spent_usd, budget_usd, budget_warning, error, created_at")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
    ]);
    // A failed runs/projects query must surface as an explicit admin-facing
    // load error with Retry. Collapsing errors to [] would render "No runs
    // yet" / "No projects" and hide the real cause.
    if (runsRes.error || projRes.error) {
      setLoadError(runsRes.error?.message ?? projRes.error?.message ?? "Failed to load runs");
      setLoading(false);
      return;
    }
    setRuns((runsRes.data ?? []) as RunRow[]);
    setProjects((projRes.data ?? []) as ProjectRow[]);
    if (projRes.data && projRes.data[0] && !selectedProject) setSelectedProject(projRes.data[0].id);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function toggleExpand(runId: string) {
    const next = !expanded[runId];
    setExpanded((e) => ({ ...e, [runId]: next }));
    if (next && !steps[runId]) {
      const { data } = await supabase
        .from("run_steps")
        .select("id, step_key, seat, status, tokens_in, tokens_out, cost_usd, error, response_text")
        .eq("run_id", runId)
        .order("created_at", { ascending: true });
      setSteps((s) => ({ ...s, [runId]: (data ?? []) as StepRow[] }));
    }
  }

  async function startTestRun() {
    if (!selectedProject) return toast.error("Pick a project first");
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    if (!token) return toast.error("Not signed in");
    const { data, error } = await supabase.functions.invoke("boardroom-orchestrator", {
      body: { action: "start_run", project_id: selectedProject, kind: "test" },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error || (data as any)?.error) {
      toast.error((data as any)?.error ?? error?.message ?? "Failed to start run");
      return;
    }
    toast.success("Test run queued");
    void load();
  }

  if (isAdmin === null) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }
  if (!isAdmin) {
    return (
      <div className="p-8">
        <h1 className="font-display text-2xl text-foreground">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page is restricted.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-foreground">Runs debug</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live view of boardroom runs, their steps, and cost.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-foreground"
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={startTestRun}
            className="rounded-md bg-[hsl(38_65%_55%)] px-4 py-2 text-sm font-medium text-[hsl(220_15%_8%)] hover:bg-[hsl(38_70%_62%)]"
          >
            Start test run
          </button>
          <button
            onClick={load}
            className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
        <table className="w-full font-mono text-xs">
          <thead className="bg-surface-2 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-normal">Run</th>
              <th className="px-4 py-3 font-normal">Kind</th>
              <th className="px-4 py-3 font-normal">Status</th>
              <th className="px-4 py-3 font-normal">Round</th>
              <th className="px-4 py-3 font-normal">Spent / Budget</th>
              <th className="px-4 py-3 font-normal">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No runs yet.
                </td>
              </tr>
            )}
            {runs.map((r) => {
              const proj = projects.find((p) => p.id === r.project_id);
              return (
                <>
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-3 text-foreground">
                      <div>{proj?.name ?? r.project_id.slice(0, 8)}</div>
                      <div className="text-[10px] text-muted-foreground">{r.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.kind}</td>
                    <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{r.round_no}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      ${Number(r.spent_usd).toFixed(4)} / ${Number(r.budget_usd).toFixed(2)}
                      {r.budget_warning && <span className="ml-2 text-[hsl(38_65%_70%)]">⚠</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => toggleExpand(r.id)}
                        className="text-[hsl(38_65%_70%)] hover:underline"
                      >
                        {expanded[r.id] ? "hide" : "steps"}
                      </button>
                    </td>
                  </tr>
                  {expanded[r.id] && (
                    <tr className="bg-surface-2/40">
                      <td colSpan={7} className="px-4 py-3">
                        {r.error && (
                          <div className="mb-2 text-[hsl(8_60%_65%)]">error: {r.error}</div>
                        )}
                        <div className="space-y-2">
                          {(steps[r.id] ?? []).length === 0 && (
                            <div className="text-muted-foreground">No steps.</div>
                          )}
                          {(steps[r.id] ?? []).map((s) => (
                            <div
                              key={s.id}
                              className="rounded-md border border-border bg-surface-1 p-3"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <span className="text-foreground">{s.seat}</span>
                                  <span className="ml-2 text-muted-foreground">{s.step_key}</span>
                                </div>
                                <div className="flex items-center gap-3 text-muted-foreground">
                                  <span>in {s.tokens_in} · out {s.tokens_out}</span>
                                  <span>${Number(s.cost_usd).toFixed(4)}</span>
                                  <StatusPill status={s.status} />
                                </div>
                              </div>
                              {s.error && (
                                <div className="mt-2 text-[hsl(8_60%_65%)]">{s.error}</div>
                              )}
                              {s.response_text && (
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                                    response
                                  </summary>
                                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3 text-[11px] text-foreground">
                                    {s.response_text}
                                  </pre>
                                </details>
                              )}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
