import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardroomSession, PLAN_RUBRIC } from "@/components/boardroom-session";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/boardroom/$projectId")({
  component: BoardroomProjectPage,
});

const CONVENE_BLOCKED: Record<string, string> = {
  intake: "Finish the intake first — the board needs a validated idea.",
  killed: "This idea was killed. Revise it before reconvening.",
};

function BoardroomProjectPage() {
  const { projectId } = Route.useParams();
  const [projectName, setProjectName] = useState<string>("Project");
  const [isImport, setIsImport] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("projects")
        .select("name, is_import")
        .eq("id", projectId)
        .maybeSingle();
      if (data?.name) setProjectName(data.name);
      setIsImport(!!data?.is_import);
    })();
  }, [projectId]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <div className="mb-8">
        <Link to="/dashboard" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{projectName}</h1>
      </div>
      <BoardroomSession
        projectId={projectId}
        kind="plan"
        rubric={PLAN_RUBRIC}
        conveneLabel={isImport ? "Convene the improvement board" : "Convene the board"}
        runningTitle="The Boardroom"
        conveneBlockedByStatus={CONVENE_BLOCKED}
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
