import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, Rocket } from "lucide-react";

export const Route = createFileRoute("/_authenticated/runway")({
  component: RunwayIndex,
});

type Project = { id: string; name: string; status: string; created_at: string };
type Row = Project & { locked: boolean; batchCount: number };

function RunwayIndex() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    const { data: projects, error: pErr } = await supabase
      .from("projects")
      .select("id, name, status, created_at")
      .order("created_at", { ascending: false });
    if (pErr) { setLoadError(pErr.message); setRows(null); return; }
    const p = (projects ?? []) as Project[];
    if (!p.length) { setRows([]); return; }
    const ids = p.map((x) => x.id);
    const [pv, bs] = await Promise.all([
      supabase.from("plan_versions").select("project_id").eq("kind", "plan").eq("is_build_safe", true).in("project_id", ids),
      supabase.from("batches").select("project_id").in("project_id", ids),
    ]);
    if (pv.error) { setLoadError(pv.error.message); setRows(null); return; }
    if (bs.error) { setLoadError(bs.error.message); setRows(null); return; }
    const locked = new Set((pv.data ?? []).map((r: any) => r.project_id));
    const counts = new Map<string, number>();
    for (const b of bs.data ?? []) counts.set((b as any).project_id, (counts.get((b as any).project_id) ?? 0) + 1);
    setRows(p.map((x) => ({ ...x, locked: locked.has(x.id), batchCount: counts.get(x.id) ?? 0 })));
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12 md:py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Runway</span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">Take flight, one batch at a time.</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Once the plan is locked, the Chair sequences your build into numbered batches you paste into Lovable.
      </p>

      <div className="mt-10">
        {loadError ? (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-6 py-6 text-sm text-destructive">
            <p className="font-medium">Couldn't load your Runway projects.</p>
            <p className="mt-1 text-destructive/80">{loadError}</p>
            <button
              type="button"
              onClick={() => { setRows(null); void load(); }}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              Retry
            </button>
          </div>
        ) : rows === null ? (
          <div className="h-32 animate-pulse rounded-xl bg-surface-1" />
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
            <Rocket className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-4 font-display text-2xl text-foreground">No projects yet.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              The Runway takes off from the Dashboard — bring a new idea through intake, or import an existing app and run the required A–Z audit first.
            </p>
            <button
              onClick={() => navigate({ to: "/dashboard" })}
              className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
            >
              Go to dashboard
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            {rows.map((p) => (
              <Link
                key={p.id}
                to="/runway/$projectId"
                params={{ projectId: p.id }}
                className="group flex items-center justify-between rounded-xl border border-border bg-surface-1 p-5 transition-colors hover:border-primary/40 hover:bg-surface-2"
              >
                <div>
                  <p className="font-display text-lg text-foreground">{p.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {p.batchCount > 0
                      ? `${p.batchCount} batches sequenced`
                      : p.locked
                      ? "Plan locked · ready to sequence"
                      : "Plan not yet locked"}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
