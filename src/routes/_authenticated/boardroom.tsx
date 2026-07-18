import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowRight, Users2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/boardroom")({
  component: BoardroomIndex,
});

type Project = { id: string; name: string; status: string; created_at: string };

function BoardroomIndex() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    supabase
      .from("projects")
      .select("id, name, status, created_at")
      .order("created_at", { ascending: false })
      .then(({ data }) => setProjects((data ?? []) as Project[]));
  }, []);

  const eligible = (projects ?? []).filter(
    (p) => !["intake", "killed"].includes(p.status),
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12 md:py-16">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Boardroom
      </span>
      <h1 className="mt-3 font-display text-4xl leading-tight text-foreground md:text-5xl">
        The board is in session.
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Pick a project to convene the seats and watch the deliberation unfold in real time.
      </p>

      <div className="mt-10">
        {projects === null ? (
          <div className="h-32 animate-pulse rounded-xl bg-surface-1" />
        ) : eligible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-16 text-center">
            <Users2 className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-4 font-display text-2xl text-foreground">
              No projects ready for the board.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Bring an idea through intake first. The board convenes only after validation.
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
            {eligible.map((p) => (
              <Link
                key={p.id}
                to="/boardroom/$projectId"
                params={{ projectId: p.id }}
                className="group flex items-center justify-between rounded-xl border border-border bg-surface-1 p-5 transition-colors hover:border-primary/40 hover:bg-surface-2"
              >
                <div>
                  <p className="font-display text-lg text-foreground">{p.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {p.status}
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
