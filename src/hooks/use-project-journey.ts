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
          .select("kind")
          .eq("project_id", projectId)
          .in("kind", ["plan", "design"]),
        supabase.from("batches").select("status").eq("project_id", projectId),
        supabase
          .from("audits")
          .select("id, status")
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
      const pvs = (pvRes.data ?? []) as Array<{ kind: string }>;
      const batches = (batchRes.data ?? []) as Array<{ status: string }>;
      const audits = (auditRes.data ?? []) as Array<{ id: string }>;
      const flags: JourneyFlags = {
        is_import: !!proj.is_import,
        status: proj.status ?? "",
        github_repo: proj.github_repo ?? null,
        has_locked_plan: pvs.some((p) => p.kind === "plan"),
        has_design: pvs.some((p) => p.kind === "design"),
        has_batches: batches.length > 0,
        all_passed:
          batches.length > 0 &&
          batches.every((b) => b.status === "passed" || b.status === "skipped"),
        has_final_audit: audits.length > 0,
      };
      setStages(buildJourney(flags));
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return stages;
}
