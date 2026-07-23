import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildJourney, type JourneyFlags, type JourneyStage } from "@/lib/project-journey";
import { classifyAudits, parseTimestamp } from "@/lib/audit-classification";

/**
 * Journey is supplementary. A load failure must surface as a truthful
 * `error` state (never conflated with `loading`) so callers can render a
 * small "Journey unavailable · Retry" indicator without blocking the
 * primary page content.
 */
export type UseProjectJourneyResult = {
  stages: JourneyStage[] | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

export function useProjectJourney(projectId: string): UseProjectJourneyResult {
  const [stages, setStages] = useState<JourneyStage[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const retry = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
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
      if (projRes.error) {
        setStages(null);
        setError(projRes.error.message || "Failed to load project");
        setLoading(false);
        return;
      }
      const proj = projRes.data as
        | { is_import?: boolean; github_repo?: string | null; status?: string }
        | null;
      if (!proj) {
        setStages(null);
        setError(null);
        setLoading(false);
        return;
      }
      // A failed secondary query is a truthful error, not "loading forever"
      // and not a false "everything upcoming".
      const firstErr = pvRes.error || batchRes.error || auditRes.error;
      if (firstErr) {
        setStages(null);
        setError(firstErr.message || "Failed to load project journey");
        setLoading(false);
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
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, tick]);

  return { stages, loading, error, retry };
}
