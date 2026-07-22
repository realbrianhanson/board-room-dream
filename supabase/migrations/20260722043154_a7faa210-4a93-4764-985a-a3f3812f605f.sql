
-- D2b: Remove client-settable GUC bypass from spend accounting.
-- Restore boardroom_runs_guard to allow privileged updates ONLY when auth.role()='service_role'.
-- Update record_model_call_atomic to no longer toggle boardroom.allow_spend_update.

CREATE OR REPLACE FUNCTION public.boardroom_runs_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id           IS DISTINCT FROM OLD.project_id
    OR NEW.user_id              IS DISTINCT FROM OLD.user_id
    OR NEW.kind                 IS DISTINCT FROM OLD.kind
    OR NEW.status               IS DISTINCT FROM OLD.status
    OR NEW.round_no             IS DISTINCT FROM OLD.round_no
    OR NEW.loop_no              IS DISTINCT FROM OLD.loop_no
    OR NEW.budget_usd           IS DISTINCT FROM OLD.budget_usd
    OR NEW.spent_usd            IS DISTINCT FROM OLD.spent_usd
    OR NEW.budget_warning       IS DISTINCT FROM OLD.budget_warning
    OR NEW.consensus            IS DISTINCT FROM OLD.consensus
    OR NEW.dissent_ledger       IS DISTINCT FROM OLD.dissent_ledger
    OR NEW.constitution_version IS DISTINCT FROM OLD.constitution_version
    OR NEW.error                IS DISTINCT FROM OLD.error
    OR NEW.created_at           IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Only founder_notes may be updated by clients';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_model_call_atomic(
  p_user_id uuid, p_project_id uuid, p_run_id uuid, p_seat text,
  p_model_id text, p_tokens_in integer, p_tokens_out integer, p_cost_usd numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_user   uuid;
  v_run_proj   uuid;
  v_spent      numeric;
  v_budget     numeric;
  v_warn       boolean;
  v_new_total  numeric;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'record_model_call_atomic: p_user_id is required';
  END IF;
  IF p_cost_usd IS NULL OR p_cost_usd < 0 THEN
    RAISE EXCEPTION 'record_model_call_atomic: p_cost_usd must be >= 0 (got %)', p_cost_usd;
  END IF;
  IF p_tokens_in IS NULL OR p_tokens_in < 0
     OR p_tokens_out IS NULL OR p_tokens_out < 0 THEN
    RAISE EXCEPTION 'record_model_call_atomic: token counts must be >= 0';
  END IF;

  IF p_run_id IS NOT NULL THEN
    SELECT user_id, project_id, coalesce(spent_usd,0), coalesce(budget_usd,0), coalesce(budget_warning,false)
      INTO v_run_user, v_run_proj, v_spent, v_budget, v_warn
      FROM public.boardroom_runs
      WHERE id = p_run_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_model_call_atomic: run % not found', p_run_id;
    END IF;
    IF v_run_user IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'record_model_call_atomic: run % does not belong to user %', p_run_id, p_user_id;
    END IF;
    IF p_project_id IS NOT NULL AND v_run_proj IS DISTINCT FROM p_project_id THEN
      RAISE EXCEPTION 'record_model_call_atomic: run % project mismatch', p_run_id;
    END IF;
  END IF;

  INSERT INTO public.cost_ledger(
    user_id, project_id, run_id, seat, model_id, tokens_in, tokens_out, cost_usd
  ) VALUES (
    p_user_id, p_project_id, p_run_id, p_seat, p_model_id, p_tokens_in, p_tokens_out, p_cost_usd
  );

  IF p_run_id IS NOT NULL THEN
    v_new_total := v_spent + p_cost_usd;
    UPDATE public.boardroom_runs
       SET spent_usd = v_new_total,
           budget_warning = CASE
             WHEN v_warn THEN true
             WHEN v_budget > 0 AND v_new_total >= v_budget * 0.8 THEN true
             ELSE v_warn
           END
     WHERE id = p_run_id;
    RETURN v_new_total;
  END IF;

  RETURN p_cost_usd;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_model_call_atomic(uuid, uuid, uuid, text, text, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_model_call_atomic(uuid, uuid, uuid, text, text, integer, integer, numeric) TO service_role;
