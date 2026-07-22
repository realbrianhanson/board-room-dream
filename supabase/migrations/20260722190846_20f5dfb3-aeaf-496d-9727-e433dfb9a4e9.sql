-- Terminal-parent safe requeue + orphan cleanup.
-- The orchestrator uses this SECURITY DEFINER RPC to atomically decide
-- whether a queued/running step should be requeued (parent is still active)
-- or terminalized as cancelled_parent_terminal (parent is failed/completed/
-- consensus/chair_ruled). Locks the parent row FOR UPDATE so a concurrent
-- failRun() cannot slip a terminal transition between the check and the
-- write. Not executable by anon/authenticated/PUBLIC — service_role only.

CREATE OR REPLACE FUNCTION public.requeue_step_if_parent_active(
  p_step_id uuid,
  p_new_request jsonb,
  p_new_error text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_parent_status text;
BEGIN
  SELECT run_id INTO v_run_id FROM public.run_steps WHERE id = p_step_id;
  IF v_run_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT status INTO v_parent_status
    FROM public.boardroom_runs
   WHERE id = v_run_id
   FOR UPDATE;

  IF v_parent_status IN ('queued','running','paused','paused_budget') THEN
    UPDATE public.run_steps
       SET status = 'queued',
           started_at = NULL,
           completed_at = NULL,
           error = p_new_error,
           request = COALESCE(p_new_request, request)
     WHERE id = p_step_id
       AND status IN ('running','queued');
    RETURN 'requeued';
  ELSE
    UPDATE public.run_steps
       SET status = 'failed',
           error = 'cancelled_parent_terminal',
           completed_at = now()
     WHERE id = p_step_id
       AND status IN ('queued','running');
    RETURN 'cancelled_parent_terminal';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.requeue_step_if_parent_active(uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.requeue_step_if_parent_active(uuid, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.requeue_step_if_parent_active(uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_step_if_parent_active(uuid, jsonb, text) TO service_role;

-- One-time cleanup: terminalize queued/running steps whose parent is
-- already in a terminal state. This mirrors what failRun() will now do
-- eagerly on every future terminalization; here it drains the backlog
-- from prior runs (including 4462a4ef and the earlier canceled run's
-- timeout-requeued orphan).
UPDATE public.run_steps rs
   SET status = 'failed',
       error = 'cancelled_parent_terminal',
       completed_at = COALESCE(rs.completed_at, now())
  FROM public.boardroom_runs r
 WHERE rs.run_id = r.id
   AND rs.status IN ('queued','running')
   AND r.status IN ('failed','completed','consensus','chair_ruled');
