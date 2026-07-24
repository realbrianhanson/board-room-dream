import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BoardroomSession, PLAN_RUBRIC } from "@/components/boardroom-session";
import { ArrowRight } from "lucide-react";
import { ProjectJourneyStrip } from "@/components/project-journey";
import { useProjectJourney } from "@/hooks/use-project-journey";
import {
  computeBoardroomGate,
  IMPORT_AUDIT_GATE_MESSAGE,
} from "@/lib/boardroom-gate";
import type { ImportGoal, ImportNextRoute } from "@/lib/import-workflow";
import { IMPORT_GOALS } from "@/lib/import-workflow";

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
  const [hasRepo, setHasRepo] = useState<boolean>(false);
  const [goals, setGoals] = useState<ImportGoal[] | null>(null);
  const [gateLoading, setGateLoading] = useState<boolean>(true);
  const [hasSuccessfulAudit, setHasSuccessfulAudit] = useState<boolean>(false);
  const [hasSafePlan, setHasSafePlan] = useState<boolean>(false);
  const [hasSafeDesign, setHasSafeDesign] = useState<boolean>(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setGateLoading(true);
      setGateError(null);
      const [projRes, auditsRes, plansRes, designsRes, intakeRes] = await Promise.all([
        supabase
          .from("projects")
          .select("name, is_import, github_repo")
          .eq("id", projectId)
          .maybeSingle(),
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
        supabase
          .from("plan_versions")
          .select("id")
          .eq("project_id", projectId)
          .eq("kind", "design")
          .eq("is_build_safe", true)
          .limit(1),
        // Latest intake carries the persisted goals. Missing intake (legacy
        // import) → null → deriveImportWorkflow falls back to full workflow.
        supabase
          .from("intakes")
          .select("answers, created_at")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      const firstErr =
        projRes.error?.message ??
        auditsRes.error?.message ??
        plansRes.error?.message ??
        designsRes.error?.message ??
        intakeRes.error?.message ??
        null;
      if (firstErr) {
        setGateError(firstErr);
        setGateLoading(false);
        return;
      }
      if (projRes.data?.name) setProjectName(projRes.data.name);
      setIsImport(!!projRes.data?.is_import);
      setHasRepo(!!projRes.data?.github_repo);
      setHasSuccessfulAudit((auditsRes.data ?? []).length > 0);
      setHasSafePlan((plansRes.data ?? []).length > 0);
      setHasSafeDesign((designsRes.data ?? []).length > 0);
      const answers = (intakeRes.data?.answers ?? null) as Record<string, unknown> | null;
      const raw = answers && typeof answers === "object" ? answers.goals : null;
      if (Array.isArray(raw)) {
        setGoals(
          raw.filter(
            (v): v is ImportGoal =>
              typeof v === "string" && (IMPORT_GOALS as readonly string[]).includes(v),
          ),
        );
      } else {
        setGoals(null);
      }
      setGateLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const gateState = computeBoardroomGate({
    loading: gateLoading,
    error: gateError,
    isImport,
    goals,
    projectId,
    hasRepo,
    hasSuccessfulAudit,
    hasBuildSafePlan: hasSafePlan,
    hasBuildSafeDesign: hasSafeDesign,
  });

  const extraConveneGate = () =>
    gateState.kind === "needs-import-audit" ? IMPORT_AUDIT_GATE_MESSAGE : null;

  if (gateState.kind === "error") {
    return (
      <div className="mx-auto max-w-6xl px-6 py-14">
        <Link to="/dashboard" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <div className="mt-8 rounded-xl border border-[hsl(8_60%_45%/0.4)] bg-[hsl(8_60%_25%/0.15)] p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(8_60%_70%)]">Couldn't load the Boardroom gate</p>
          <p className="mt-2 text-sm text-foreground">{gateState.message}</p>
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

  const emptyTitle = isImport
    ? goals && goals.includes("code_audit")
      ? "The board reviews what you've already built."
      : "The board drafts what to improve."
    : "The room is quiet.";
  const emptySubtitle = isImport
    ? goals && goals.includes("code_audit")
      ? "They'll read your code, weigh the A–Z findings, and draft what to fix next."
      : "They'll read the real repo and draft improvements that keep the existing design intact."
    : "Convene the board and let them argue this into shape.";

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <div className="mb-8">
        <Link to="/dashboard" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{projectName}</h1>
        <div className="mt-4 mb-2">
          <ProjectJourneyStrip result={journey} />
        </div>
      </div>

      {gateState.kind === "out-of-scope" ? (
        <BoardroomOutOfScopeCard
          projectId={projectId}
          scopeLabel={gateState.workflow.scopeLabel}
          nextRoute={gateState.nextRoute}
        />
      ) : gateState.kind === "needs-repo" ? (
        <BoardroomNeedsRepoCard projectId={projectId} scopeLabel={gateState.workflow.scopeLabel} />
      ) : (

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
          emptyTitle={emptyTitle}
          emptySubtitle={emptySubtitle}
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
      )}
    </div>
  );
}

// -------- Out-of-scope card --------
//
// Owner did not select `improvements`, so the Boardroom is intentionally
// closed for this import. We render a polished explanation plus a typed
// TanStack Link to the correct next stage — never a raw href.

function BoardroomOutOfScopeCard({
  projectId,
  scopeLabel,
  nextRoute,
}: {
  projectId: string;
  scopeLabel: string;
  nextRoute: ImportNextRoute;
}) {
  const copy = describeOutOfScope(nextRoute.kind);
  return (
    <section className="rounded-xl border border-border bg-surface-1/60 px-8 py-10">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Boardroom not in scope · {scopeLabel}
      </p>
      <h2 className="mt-3 font-display text-2xl text-foreground">{copy.title}</h2>
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">{copy.body}</p>
      <div className="mt-6">
        <NextStageLink projectId={projectId} nextRoute={nextRoute} />
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Change scope from the dashboard by adding <span className="text-foreground">Product Improvements</span> to this project. The board only convenes when improvements are in scope.
      </p>
    </section>
  );
}

function describeOutOfScope(kind: ImportNextRoute["kind"]): { title: string; body: string } {
  switch (kind) {
    case "audit":
    case "done":
      return {
        title: "This project is an audit only.",
        body: "You chose a red-team audit at import. The Boardroom drafts improvement plans, which is out of scope here. Head to the Audit Center for the evidence-backed report.",
      };
    case "design":
      return {
        title: "This project is a design pass, not an improvement plan.",
        body: "You chose Design Upgrade at import. The Design Council will draft a new house style against the real UI without changing behavior — the improvement Boardroom is intentionally closed for this scope.",
      };
    case "runway":
      return {
        title: "Artifacts are ready — jump straight to prompts.",
        body: "Your selected artifacts are locked and design-only prompts can be generated in Runway. The improvement Boardroom stays closed on this scope.",
      };
    case "repo_setup":
      return {
        title: "Link the repo first.",
        body: "The Audit Center is where you paste the GitHub URL. Once the repo is connected, we'll route you to the right next stage for this scope.",
      };
    case "plan":
      // Should not happen for out-of-scope (plan means improvements selected)
      // but included for exhaustiveness.
      return {
        title: "The Boardroom is next.",
        body: "The Boardroom is in scope for this project.",
      };
  }
}

function NextStageLink({
  projectId,
  nextRoute,
}: {
  projectId: string;
  nextRoute: ImportNextRoute;
}) {
  const label = nextStageLabel(nextRoute.kind);
  const cls =
    "inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110";
  switch (nextRoute.kind) {
    case "audit":
    case "done":
    case "repo_setup":
      return (
        <Link to="/audits/$projectId" params={{ projectId }} className={cls}>
          {label} <ArrowRight className="h-4 w-4" />
        </Link>
      );
    case "design":
      return (
        <Link to="/design/$projectId" params={{ projectId }} className={cls}>
          {label} <ArrowRight className="h-4 w-4" />
        </Link>
      );
    case "runway":
      return (
        <Link to="/runway/$projectId" params={{ projectId }} className={cls}>
          {label} <ArrowRight className="h-4 w-4" />
        </Link>
      );
    case "plan":
      return (
        <Link to="/boardroom/$projectId" params={{ projectId }} className={cls}>
          {label} <ArrowRight className="h-4 w-4" />
        </Link>
      );
  }
}

function nextStageLabel(kind: ImportNextRoute["kind"]): string {
  switch (kind) {
    case "audit":
      return "Open the Audit Center";
    case "done":
      return "View the audit report";
    case "design":
      return "Open the Design Council";
    case "runway":
      return "Go to Runway";
    case "repo_setup":
      return "Link the repo in Audit Center";
    case "plan":
      return "Open the Boardroom";
  }
}

// -------- Needs-repo card --------
//
// Improvements IS in scope for this import, but the project has no
// GitHub repo linked yet. The board compiles against live code, so it
// cannot convene until the owner links a repo in Audit Center.
function BoardroomNeedsRepoCard({
  projectId,
  scopeLabel,
}: {
  projectId: string;
  scopeLabel: string;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-1/60 px-8 py-10">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Link your GitHub repo first · {scopeLabel}
      </p>
      <h2 className="mt-3 font-display text-2xl text-foreground">
        The board reads live code before it convenes.
      </h2>
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        Improvement plans are compiled against your real repo at HEAD.
        Link your GitHub repository in the Audit Center, then return here
        to convene the improvement board.
      </p>
      <div className="mt-6">
        <Link
          to="/audits/$projectId"
          params={{ projectId }}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
        >
          Link the repo in Audit Center <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
