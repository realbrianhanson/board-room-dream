
BEGIN;

-- Bypass boardroom_runs_guard for this migration-owned cleanup only.
SET LOCAL request.jwt.claim.role TO 'service_role';
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';

WITH active AS (
  SELECT
    r.id,
    r.project_id,
    r.kind,
    COALESCE(r.spent_usd, 0) AS spent_usd,
    r.created_at,
    (SELECT count(*) FROM public.run_steps s
      WHERE s.run_id = r.id AND s.status = 'completed') AS completed_count
  FROM public.boardroom_runs r
  WHERE r.status IN ('queued','running','paused','paused_budget')
),
ranked AS (
  SELECT
    id, project_id, kind,
    row_number() OVER (
      PARTITION BY project_id, kind
      ORDER BY completed_count DESC, spent_usd DESC, created_at ASC
    ) AS rn
  FROM active
),
losers AS (
  SELECT id FROM ranked WHERE rn > 1
),
demoted_runs AS (
  UPDATE public.boardroom_runs
     SET status = 'failed',
         error = 'Superseded duplicate active run'
   WHERE id IN (SELECT id FROM losers)
  RETURNING id
)
UPDATE public.run_steps
   SET status = 'skipped',
       error = 'superseded_duplicate_run',
       completed_at = now()
 WHERE status IN ('queued','running')
   AND run_id IN (SELECT id FROM demoted_runs);

CREATE UNIQUE INDEX IF NOT EXISTS boardroom_runs_one_active_per_project_kind_idx
  ON public.boardroom_runs (project_id, kind)
  WHERE status IN ('queued','running','paused','paused_budget');

COMMIT;
