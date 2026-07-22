import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardroomSession, PLAN_RUBRIC } from "@/components/boardroom-session";
import { ArrowRight } from "lucide-react";
import { ProjectJourney } from "@/components/project-journey";
import { useProjectJourney } from "@/hooks/use-project-journey";
import { computeBoardroomGate, IMPORT_AUDIT_GATE_MESSAGE } from "@/lib/boardroom-gate";

export const Route = createFileRoute("/_authenticated/boardroom_/$projectId")({
  component: BoardroomProjectPage,
});

const CONVENE_BLOCKED: Record<string, string> = {
  intake: "Finish the intake first — the board needs a validated idea.",
  killed: "This idea was killed. Revise it before reconvening.",
};

function BoardroomProjectPage() {
  const { projectId } = Route.useParams();
  const journey = useProjectJourney(projectId);
  const [projectName, setProjectName] = useState<string>("Project");
  const [isImport, setIsImport] = useState<boolean>(false);
  const [gateLoading, setGateLoading] = useState<boolean>(true);
  const [hasSuccessfulAudit, setHasSuccessfulAudit] = useState<boolean>(false);
  const [hasSafePlan, setHasSafePlan] = useState<boolean>(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setGateLoading(true);
      setGateError(null);
      const [projRes, auditsRes, plansRes] = await Promise.all([
        supabase.from("projects").select("name, is_import").eq("id", projectId).maybeSingle(),
        supabase
          .from("audits")
          .select("id, status")
          .eq("project_id", projectId)
          .eq("kind", "final_az")
          .in("status", ["clean", "findings"])
          .limit(1),
        supabase
          .from("plan_versions")
          .select("id")
          .eq("project_id", projectId)
          .eq("kind", "plan")
          .eq("is_build_safe", true)
          .limit(1),
      ]);
      if (cancelled) return;
      const firstErr = projRes.error?.message ?? auditsRes.error?.message ?? plansRes.error?.message ?? null;
      if (firstErr) {
        setGateError(firstErr);
        setGateLoading(false);
        return;
      }
      if (projRes.data?.name) setProjectName(projRes.data.name);
      setIsImport(!!projRes.data?.is_import);
      setHasSuccessfulAudit((auditsRes.data ?? []).length > 0);
      setHasSafePlan((plansRes.data ?? []).length > 0);
      setGateLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const extraConveneGate = () => {
    if (!isImport) return null;
    if (gateLoading || gateError) return null;
    if (!hasSuccessfulAudit) return IMPORT_AUDIT_GATE_MESSAGE;
    return null;
  };

  if (gateError) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-14">
        <Link to="/dashboard" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <div className="mt-8 rounded-xl border border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_25%/0.15)] p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(8_60%_70%)]">Couldn't load the Boardroom gate</p>
          <p className="mt-2 text-sm text-foreground">{gateError}</p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <div className="mb-8">
        <Link to="/dashboard" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{projectName}</h1>
        {journey && (
          <div className="mt-4 mb-2">
            <ProjectJourney stages={journey} />
          </div>
        )}
      </div>
      <BoardroomSession
        projectId={projectId}
        kind="plan"
        rubric={PLAN_RUBRIC}
        conveneLabel={isImport ? "Convene the improvement board" : "Convene the board"}
        reconveneImportLabel="Reconvene the improvement board"
        runningTitle="The Boardroom"
        conveneBlockedByStatus={CONVENE_BLOCKED}
        extraConveneGate={extraConveneGate}
        legacyRequiresSafeArtifact={{ hasSafeArtifact: hasSafePlan }}
        emptyTitle={isImport ? "The board reviews what you've already built." : "The room is quiet."}
        emptySubtitle={
          isImport
            ? "They'll read your code, weigh the A–Z findings, and draft what to fix next."
            : "Convene the board and let them argue this into shape."
        }
        lockCard={(run) => (
          <div className="mt-8 rounded-xl border border-[hsl(38_65%_55%/0.4)] bg-[hsl(38_65%_55%/0.06)] px-6 py-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(38_65%_70%)]">
              {run.status === "chair_ruled"
                ? "The Chair has ruled."
                : isImport
                ? "The improvement plan is locked."
                : "The plan is locked."}
            </p>
            <Link
              to="/plan/$projectId"
              params={{ projectId }}
              className="mt-2 inline-flex items-center gap-2 font-display text-lg text-foreground hover:text-[hsl(38_65%_70%)]"
            >
              View the Locked Plan <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        )}
      />

    </div>
  );
}
