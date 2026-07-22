
CREATE OR REPLACE FUNCTION public.claim_run_step_with_capacity(
  p_run_id uuid,
  p_capacity int
)
RETURNS SETOF public.run_steps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap int;
  v_running int;
  v_step public.run_steps%ROWTYPE;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'claim_run_step_with_capacity: p_run_id is required';
  END IF;
  -- Clamp capacity to a sane 1..8 window.
  v_cap := GREATEST(1, LEAST(8, COALESCE(p_capacity, 1)));

  -- Transaction-scoped advisory lock keyed on the run id serializes claim
  -- attempts across overlapping invocations for THIS run only. Auto-released
  -- at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('boardroom_run_claim:' || p_run_id::text, 0)
  );

  SELECT count(*) INTO v_running
  FROM public.run_steps
  WHERE run_id = p_run_id AND status = 'running';

  IF v_running >= v_cap THEN
    RETURN;
  END IF;

  SELECT * INTO v_step
  FROM public.run_steps
  WHERE run_id = p_run_id AND status = 'queued'
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.run_steps
     SET status = 'running',
         started_at = now()
   WHERE id = v_step.id
  RETURNING * INTO v_step;

  RETURN NEXT v_step;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_run_step_with_capacity(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_run_step_with_capacity(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.claim_run_step_with_capacity(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_run_step_with_capacity(uuid, int) TO service_role;
