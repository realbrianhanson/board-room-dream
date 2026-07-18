import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, ScrollText } from "lucide-react";

export const Route = createFileRoute("/_authenticated/audits")({
  component: AuditsIndex,
});

type Project = { id: string; name: string; status: string; created_at: string };

function AuditsIndex() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [auditedIds, setAuditedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const { data: rows } = await supabase
        .from("projects")
        .select("id, name, status, created_at")
        .order("created_at", { ascending: false });
      const projs = (rows ?? []) as Project[];
      setProjects(projs);
      if (projs.length) {
        const { data: au } = await supabase
          .from("audits")
          .select("project_id")
          .in("project_id", projs.map((p) => p.id));
        setAuditedIds(new Set((au ?? []).map((r: { project_id: string }) => r.project_id)));
      }
    })();
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12 md:py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Audits</span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">Every decision, on record.</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        The board reads your real code after every built batch, and again as a full A–Z pass before ship.
      </p>

      <div className="mt-10">
        {projects === null ? (
          <div className="h-32 animate-pulse rounded-xl bg-surface-1" />
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
            <ScrollText className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-4 font-display text-2xl text-foreground">No projects yet.</p>
            <p className="mt-2 text-sm text-muted-foreground">Ship a batch and the board will read it.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => (
              <Link
                key={p.id}
                to="/audits/$projectId"
                params={{ projectId: p.id }}
                className="group flex items-center justify-between rounded-xl border border-border bg-surface-1 p-5 transition-colors hover:border-primary/40 hover:bg-surface-2"
              >
                <div>
                  <p className="font-display text-lg text-foreground">{p.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {auditedIds.has(p.id) ? "Audit ledger open" : "No audits yet"}
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
