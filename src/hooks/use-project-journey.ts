import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildJourney, type JourneyFlags, type JourneyStage } from "@/lib/project-journey";
import { classifyAudits, parseTimestamp } from "@/lib/audit-classification";

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
        supabase
          .from("batches")
          .select("status, built_at, sent_at, created_at")
          .eq("project_id", projectId),
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
      // Surface secondary query errors instead of silently computing false
      // stages: a failed plan_versions/batches/audits query would otherwise
      // hide behind "everything upcoming" and mislead the owner. We keep
      // stages null (loading), which lets the caller render its own
      // skeleton or error state rather than a false journey.
      if (pvRes.error || batchRes.error || auditRes.error) {
        setStages(null);
        return;
      }
      const pvs = (pvRes.data ?? []) as Array<{ kind: string; locked_at: string }>;
      const batches = (batchRes.data ?? []) as Array<{
        status: string;
        built_at: string | null;
        sent_at: string | null;
        created_at: string | null;
      }>;
      const audits = (auditRes.data ?? []) as Array<{
        id: string;
        status: string;
        created_at: string;
      }>;
      const planLocked = pvs.find((p) => p.kind === "plan");
      const planLockedAt = planLocked ? parseTimestamp(planLocked.locked_at) : null;
      const { has_import_audit, has_final_audit } = classifyAudits({
        audits,
        planLockedAt,
        batches,
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
