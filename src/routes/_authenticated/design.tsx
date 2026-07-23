import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, Palette } from "lucide-react";

export const Route = createFileRoute("/_authenticated/design")({
  component: DesignIndex,
});

type Project = { id: string; name: string; status: string; created_at: string };

function DesignIndex() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const { data: rows } = await supabase
        .from("projects")
        .select("id, name, status, created_at")
        .order("created_at", { ascending: false });
      const projects = (rows ?? []) as Project[];
      setProjects(projects);
      if (projects.length) {
        const { data: pvs } = await supabase
          .from("plan_versions")
          .select("project_id")
          .eq("kind", "plan")
          .eq("is_build_safe", true)
          .in("project_id", projects.map((p) => p.id));
        setLockedIds(new Set((pvs ?? []).map((r: any) => r.project_id)));
      }
    })();
  }, []);


  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12 md:py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Design</span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">The house style.</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Once the plan is locked, the board debates the look — palette, type, motion, and the one distinctive move.
      </p>

      <div className="mt-10">
        {projects === null ? (
          <div className="h-32 animate-pulse rounded-xl bg-surface-1" />
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
            <Palette className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-4 font-display text-2xl text-foreground">No projects yet.</p>
            <p className="mt-2 text-sm text-muted-foreground">Bring an idea through intake and lock its plan first.</p>
            <button
              onClick={() => navigate({ to: "/dashboard" })}
              className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
            >
              Go to dashboard
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => {
              const ready = lockedIds.has(p.id);
              const cardBase =
                "group flex items-center justify-between rounded-xl border p-5 transition-colors";
              const body = (
                <>
                  <div>
                    <p className="font-display text-lg text-foreground">{p.name}</p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {ready ? "Plan locked · ready for the council" : "Plan not yet locked"}
                    </p>
                    {!ready && (
                      <p className="mt-2 text-xs text-muted-foreground/80">
                        Lock a build-safe plan in the Boardroom before opening the design council.
                      </p>
                    )}
                  </div>
                  <ArrowRight
                    className={`h-4 w-4 transition-colors ${ready ? "text-muted-foreground group-hover:text-primary" : "text-muted-foreground/40"}`}
                  />
                </>
              );
              return ready ? (
                <Link
                  key={p.id}
                  to="/design/$projectId"
                  params={{ projectId: p.id }}
                  className={`${cardBase} border-border bg-surface-1 hover:border-primary/40 hover:bg-surface-2`}
                >
                  {body}
                </Link>
              ) : (
                <div
                  key={p.id}
                  aria-disabled="true"
                  className={`${cardBase} cursor-not-allowed border-dashed border-border bg-surface-1/40 opacity-70`}
                >
                  {body}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
