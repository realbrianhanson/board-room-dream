import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, ScrollText } from "lucide-react";

export const Route = createFileRoute("/_authenticated/audits")({
  component: AuditsIndex,
});

type Project = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  is_import: boolean | null;
};

// Pure helper — exported for targeted Vitest coverage.
// Chooses the right per-card guidance based on whether the project has any
// audits yet, whether it is an imported app, and its current lifecycle
// status. An imported app is guided to run an existing-code A–Z audit; a
// new-build project is guided to ship/audit a batch first.
export function auditRowGuidance(input: {
  hasAudit: boolean;
  isImport: boolean;
  status: string;
}): { label: string; tone: "muted" | "primary" } {
  if (input.hasAudit) return { label: "Audit ledger open", tone: "muted" };
  if (input.isImport) return { label: "Run the A–Z audit on the imported code", tone: "primary" };
  if (input.status === "building" || input.status === "auditing") {
    return { label: "Ship a batch — the board reads it after each one", tone: "primary" };
  }
  if (input.status === "locked") {
    return { label: "Generate and ship a batch to open the audit ledger", tone: "muted" };
  }
  return { label: "No audits yet — ship a batch to open the ledger", tone: "muted" };
}

function AuditsIndex() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [auditedIds, setAuditedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const { data: rows } = await supabase
        .from("projects")
        .select("id, name, status, created_at, is_import")
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
            <p className="mt-2 text-sm text-muted-foreground">
              Import an existing app to run the A–Z audit on its real code, or start a new idea and the board reads each batch you ship.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => {
              const guidance = auditRowGuidance({
                hasAudit: auditedIds.has(p.id),
                isImport: !!p.is_import,
                status: p.status,
              });
              return (
                <Link
                  key={p.id}
                  to="/audits/$projectId"
                  params={{ projectId: p.id }}
                  className="group flex items-center justify-between rounded-xl border border-border bg-surface-1 p-5 transition-colors hover:border-primary/40 hover:bg-surface-2"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-display text-lg text-foreground">{p.name}</p>
                      {p.is_import && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.22em] text-primary">
                          Imported
                        </span>
                      )}
                    </div>
                    <p
                      className={`mt-0.5 font-mono text-[10px] uppercase tracking-widest ${
                        guidance.tone === "primary" ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {guidance.label}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
