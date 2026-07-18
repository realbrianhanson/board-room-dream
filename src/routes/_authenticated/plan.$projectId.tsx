import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Gavel, MessageSquarePlus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/plan/$projectId")({
  component: LockedPlanPage,
});

type Project = { id: string; name: string; user_id: string; status: string };
type PlanVersion = {
  id: string;
  project_id: string;
  version: number;
  content_md: string;
  is_chair_ruled: boolean;
  dissent_ledger: Array<{ seat: string; objection: string; chair_response?: string }> | null;
  locked_at: string;
};

function LockedPlanPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [plan, setPlan] = useState<PlanVersion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: proj } = await supabase
        .from("projects")
        .select("id, name, user_id, status")
        .eq("id", projectId)
        .maybeSingle();
      if (cancelled) return;
      if (!proj) {
        toast.error("Project not found");
        navigate({ to: "/dashboard" });
        return;
      }
      setProject(proj as Project);
      const { data: pv } = await supabase
        .from("plan_versions")
        .select("id, project_id, version, content_md, is_chair_ruled, dissent_ledger, locked_at")
        .eq("project_id", projectId)
        .eq("kind", "plan")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setPlan((pv as PlanVersion) ?? null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, navigate]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <div className="h-64 animate-pulse rounded-xl bg-surface-1" />
      </div>
    );
  }

  if (!project) return null;

  if (!plan) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-16">
        <Link
          to="/boardroom/$projectId"
          params={{ projectId }}
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground"
        >
          ← Boardroom
        </Link>
        <h1 className="mt-3 font-display text-3xl text-foreground">No plan locked yet.</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The board hasn't reached consensus on this project.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:py-14">
      <div className="flex items-center justify-between">
        <Link
          to="/boardroom/$projectId"
          params={{ projectId }}
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground"
        >
          ← Boardroom
        </Link>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            v{plan.version}
          </span>
          {plan.is_chair_ruled && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.08)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-[hsl(38_65%_70%)]">
              <Gavel className="h-3 w-3" />
              Chair ruled
            </span>
          )}
        </div>
      </div>

      <h1 className="mt-4 font-display text-4xl leading-tight text-foreground">{project.name}</h1>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        The plan is locked · {new Date(plan.locked_at).toLocaleDateString()}
      </p>

      <article className="prose prose-invert mt-10 max-w-[70ch] text-[15px] leading-[1.7] text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.content_md}</ReactMarkdown>
      </article>

      {plan.is_chair_ruled && plan.dissent_ledger && plan.dissent_ledger.length > 0 && (
        <div className="mt-12 rounded-xl border border-border bg-surface-1 p-6">
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

      <div className="mt-12 flex items-center justify-between rounded-xl border border-dashed border-border bg-surface-1/50 p-5">
        <div>
          <p className="font-display text-sm text-foreground">Not quite right?</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Change requests convene in a later batch.
          </p>
        </div>
        <button
          disabled
          className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-muted-foreground opacity-60"
        >
          <MessageSquarePlus className="h-4 w-4" />
          Request a change
        </button>
      </div>
    </div>
  );
}
