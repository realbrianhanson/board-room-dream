-- Batch 17: Cloudflare executor state. Additive; the inline path never reads these columns.

-- 1. run_steps: in-flight executor call bookkeeping (status stays 'running' while waiting)
ALTER TABLE public.run_steps
  ADD COLUMN IF NOT EXISTS executor_call_id text,
  ADD COLUMN IF NOT EXISTS executor_dispatch_no integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS executor_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS executor_meta jsonb;
CREATE INDEX IF NOT EXISTS run_steps_executor_inflight_idx
  ON public.run_steps (executor_dispatched_at) WHERE executor_call_id IS NOT NULL;

-- 2. reserve a deterministic call id: one row, one new id, only from a claimed, undispatched row
CREATE OR REPLACE FUNCTION public.reserve_executor_call(p_step_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id text;
BEGIN
  UPDATE public.run_steps
     SET executor_dispatch_no = executor_dispatch_no + 1,
         executor_call_id = id::text || '-' || (executor_dispatch_no + 1)::text,
         executor_dispatched_at = now(),
         executor_meta = NULL
   WHERE id = p_step_id AND status = 'running' AND executor_call_id IS NULL
  RETURNING executor_call_id INTO v_id;
  RETURN v_id;   -- NULL = not reservable (already dispatched / not running / missing)
END $$;
REVOKE ALL ON FUNCTION public.reserve_executor_call(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_executor_call(uuid) TO service_role;

-- 3. idempotent ledger rows (NEW function; record_model_call_atomic is untouched)
ALTER TABLE public.cost_ledger ADD COLUMN IF NOT EXISTS call_id text;
CREATE UNIQUE INDEX IF NOT EXISTS cost_ledger_call_id_uidx ON public.cost_ledger (call_id) WHERE call_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_model_call_idempotent(
  p_user_id uuid, p_project_id uuid, p_run_id uuid, p_seat text, p_model_id text,
  p_tokens_in integer, p_tokens_out integer, p_cost_usd numeric, p_call_id text
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_run_user uuid; v_run_proj uuid; v_spent numeric; v_budget numeric; v_warn boolean; v_new_total numeric; v_inserted uuid;
BEGIN
  -- validation block copied verbatim from 20260722043154 (the live record_model_call_atomic)
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'record_model_call_idempotent: p_user_id is required'; END IF;
  IF p_call_id IS NULL OR length(p_call_id) = 0 THEN RAISE EXCEPTION 'record_model_call_idempotent: p_call_id is required'; END IF;
  IF p_cost_usd IS NULL OR p_cost_usd < 0 THEN RAISE EXCEPTION 'record_model_call_idempotent: p_cost_usd must be >= 0 (got %)', p_cost_usd; END IF;
  IF p_tokens_in IS NULL OR p_tokens_in < 0 OR p_tokens_out IS NULL OR p_tokens_out < 0 THEN
    RAISE EXCEPTION 'record_model_call_idempotent: token counts must be >= 0';
  END IF;
  IF p_run_id IS NOT NULL THEN
    SELECT user_id, project_id, coalesce(spent_usd,0), coalesce(budget_usd,0), coalesce(budget_warning,false)
      INTO v_run_user, v_run_proj, v_spent, v_budget, v_warn
      FROM public.boardroom_runs WHERE id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'record_model_call_idempotent: run % not found', p_run_id; END IF;
    IF v_run_user IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'record_model_call_idempotent: run % does not belong to user %', p_run_id, p_user_id; END IF;
    IF p_project_id IS NOT NULL AND v_run_proj IS DISTINCT FROM p_project_id THEN RAISE EXCEPTION 'record_model_call_idempotent: run % project mismatch', p_run_id; END IF;
  END IF;

  INSERT INTO public.cost_ledger(user_id, project_id, run_id, seat, model_id, tokens_in, tokens_out, cost_usd, call_id)
  VALUES (p_user_id, p_project_id, p_run_id, p_seat, p_model_id, p_tokens_in, p_tokens_out, p_cost_usd, p_call_id)
  ON CONFLICT (call_id) WHERE call_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NULL THEN
    RETURN COALESCE(v_spent, 0);           -- duplicate: no spend bump, no warning change
  END IF;
  IF p_run_id IS NOT NULL THEN
    v_new_total := v_spent + p_cost_usd;
    UPDATE public.boardroom_runs
       SET spent_usd = v_new_total,
           budget_warning = CASE WHEN v_warn THEN true WHEN v_budget > 0 AND v_new_total >= v_budget * 0.8 THEN true ELSE v_warn END
     WHERE id = p_run_id;
    RETURN v_new_total;
  END IF;
  RETURN p_cost_usd;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_model_call_idempotent(uuid,uuid,uuid,text,text,integer,integer,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_model_call_idempotent(uuid,uuid,uuid,text,text,integer,integer,numeric,text) TO service_role;

-- 4. requeue with an ownership token. The 3-arg function is DROPPED and replaced by one 4-arg
--    function whose last argument DEFAULTS to NULL: existing callers (3 named args over PostgREST,
--    the SQL tests) keep working, and there is no overload for Postgres to find ambiguous.
DROP FUNCTION IF EXISTS public.requeue_step_if_parent_active(uuid, jsonb, text);
CREATE FUNCTION public.requeue_step_if_parent_active(
  p_step_id uuid, p_new_request jsonb, p_new_error text, p_expect_call_id text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run_id uuid; v_parent_status text;
BEGIN
  SELECT run_id INTO v_run_id FROM public.run_steps WHERE id = p_step_id;
  IF v_run_id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT status INTO v_parent_status FROM public.boardroom_runs WHERE id = v_run_id FOR UPDATE;
  IF v_parent_status IN ('queued','running','paused','paused_budget') THEN
    UPDATE public.run_steps
       SET status = 'queued', started_at = NULL, completed_at = NULL,
           error = p_new_error, request = COALESCE(p_new_request, request),
           executor_call_id = NULL, executor_dispatched_at = NULL, executor_meta = NULL
     WHERE id = p_step_id AND status IN ('running','queued')
       AND (p_expect_call_id IS NULL OR executor_call_id = p_expect_call_id);
    IF NOT FOUND THEN RETURN 'stale_call'; END IF;
    RETURN 'requeued';
  ELSE
    UPDATE public.run_steps
       SET status = 'failed', error = 'cancelled_parent_terminal', completed_at = now()
     WHERE id = p_step_id AND status IN ('queued','running');
    -- executor columns are deliberately KEPT on the failed row: the collector still
    -- ledgers the in-flight call's real usage, then clears them (spec §5.5).
    RETURN 'cancelled_parent_terminal';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.requeue_step_if_parent_active(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_step_if_parent_active(uuid, jsonb, text, text) TO service_role;

-- 5. claim clears executor state (belt and braces: a re-claimed row never carries a stale call id)
--    Body identical to 20260722152050 except the final UPDATE, which NULLs the executor columns.
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
         started_at = now(),
         executor_call_id = NULL,
         executor_dispatched_at = NULL,
         executor_meta = NULL
   WHERE id = v_step.id
  RETURNING * INTO v_step;

  RETURN NEXT v_step;
END;
$$;
-- (grants unchanged: service_role only)

-- 6. runtime flag, off by default
INSERT INTO public.app_settings (key, value) VALUES ('executor', '{"enabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;
