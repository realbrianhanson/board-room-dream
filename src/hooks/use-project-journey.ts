import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildJourney, type JourneyFlags, type JourneyStage } from "@/lib/project-journey";

export function useProjectJourney(projectId: string): JourneyStage[] | null {
  const [stages, setStages] = useState<JourneyStage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [projRes, pvRes, batchRes, auditRes] = await Promise.all([
        supabase
          .from("projects")
          .select("is_import, github_repo, status")
          .eq("id", projectId)
          .maybeSingle(),
        supabase
          .from("plan_versions")
          .select("kind, locked_at")
          .eq("project_id", projectId)
          .eq("is_build_safe", true)
          .in("kind", ["plan", "design"]),
        supabase.from("batches").select("status").eq("project_id", projectId),
        supabase
          .from("audits")
          .select("id, status, created_at")
          .eq("project_id", projectId)
          .eq("kind", "final_az"),
      ]);
      if (cancelled) return;
      const proj = projRes.data as
        | { is_import?: boolean; github_repo?: string | null; status?: string }
        | null;
      if (!proj) {
        setStages(null);
        return;
      }
      const pvs = (pvRes.data ?? []) as Array<{ kind: string; created_at: string }>;
      const batches = (batchRes.data ?? []) as Array<{ status: string }>;
      const audits = (auditRes.data ?? []) as Array<{
        id: string;
        status: string;
        created_at: string;
      }>;
      // Distinguish the pre-plan audit from the post-build final verification
      // audit using the plan-lock timestamp. A successful final_az whose
      // created_at predates the locked plan (or exists before any plan is
      // locked) is the pre-plan Audit signal. A successful final_az AFTER
      // the plan lock is the ship/verification signal. Same audits row can
      // never satisfy both — the two flags are truly distinct.
      const planLocked = pvs.find((p) => p.kind === "plan");
      const planLockedAt = planLocked ? new Date(planLocked.created_at).getTime() : null;
      const terminalAudits = audits.filter(
        (a) => a.status === "clean" || a.status === "findings",
      );
      const has_import_audit = terminalAudits.some((a) => {
        if (!planLockedAt) return true;
        return new Date(a.created_at).getTime() < planLockedAt;
      });
      const has_final_audit = terminalAudits.some((a) => {
        if (!planLockedAt) return false;
        return new Date(a.created_at).getTime() >= planLockedAt;
      });
      const flags: JourneyFlags = {
        is_import: !!proj.is_import,
        status: proj.status ?? "",
        github_repo: proj.github_repo ?? null,
        has_locked_plan: !!planLocked,
        has_design: pvs.some((p) => p.kind === "design"),
        has_batches: batches.length > 0,
        all_passed:
          batches.length > 0 &&
          batches.every((b) => b.status === "passed" || b.status === "skipped"),
        has_import_audit,
        has_final_audit,
      };
      setStages(buildJourney(flags));
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return stages;
}
