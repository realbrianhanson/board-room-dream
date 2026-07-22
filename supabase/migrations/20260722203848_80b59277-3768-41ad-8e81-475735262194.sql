
-- 1) Trust columns (additive, safe defaults).
ALTER TABLE public.plan_versions
  ADD COLUMN IF NOT EXISTS is_build_safe boolean NOT NULL DEFAULT true;
ALTER TABLE public.plan_versions
  ADD COLUMN IF NOT EXISTS invalidated_reason text NULL;

-- 2) Backfill: any locked artifact whose provenance predates Owner Authority
--    v3 (constitution_version < 3), or whose source run is missing/null, is
--    NOT build-safe. Content is preserved for the historical ledger.
WITH bad AS (
  SELECT pv.id
  FROM public.plan_versions pv
  LEFT JOIN public.boardroom_runs br ON br.id = pv.source_run_id
  WHERE pv.source_run_id IS NULL
     OR br.id IS NULL
     OR COALESCE(br.constitution_version, 0) < 3
)
UPDATE public.plan_versions pv
   SET is_build_safe = false,
       invalidated_reason = 'pre_owner_authority_v3'
  FROM bad
 WHERE pv.id = bad.id
   AND pv.is_build_safe IS DISTINCT FROM false;

CREATE INDEX IF NOT EXISTS plan_versions_project_kind_safe_idx
  ON public.plan_versions (project_id, kind, is_build_safe, locked_at DESC);

-- 3) Reconcile stuck imports that have no batches and no active runs. Never
--    touch projects with batch rows or an in-flight run.
WITH candidates AS (
  SELECT p.id
    FROM public.projects p
   WHERE COALESCE(p.is_import, false) = true
     AND NOT EXISTS (SELECT 1 FROM public.batches b WHERE b.project_id = p.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.boardroom_runs r
        WHERE r.project_id = p.id
          AND r.status IN ('queued','running','paused','paused_budget')
     )
),
safe_plans AS (
  SELECT DISTINCT project_id
    FROM public.plan_versions
   WHERE kind = 'plan' AND is_build_safe = true
)
UPDATE public.projects p
   SET status = CASE
                  WHEN sp.project_id IS NULL THEN 'imported'
                  ELSE 'locked'
                END,
       current_batch_no = 1
  FROM candidates c
  LEFT JOIN safe_plans sp ON sp.project_id = c.id
 WHERE p.id = c.id
   AND p.status IN ('auditing','building','polishing','locked','imported');
