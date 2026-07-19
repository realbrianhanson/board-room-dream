-- BOARDROOM 100x upgrade, part 2:
-- 1. boardroom_runs.founder_notes — the founder's standing note to the board,
--    injected into the next Round-3 synthesis (human gate without the friction).
-- 2. run_steps.started_at — claim timestamp so the cron tick can requeue steps
--    orphaned by a dead edge-function invocation (stuck in 'running').
-- 3. Configurable consensus threshold: workspace default in app_settings,
--    per-cohort override on cohorts (mirrors the daily_cap_usd pattern).
-- 4. Field-manual flywheel: proposals mined from cohort audit findings +
--    batch outcomes, admin-approved into app_settings.field_manual_addenda,
--    appended to the Lovable field manual at prompt build time.

-- ============ 1. Founder notes ============
ALTER TABLE public.boardroom_runs ADD COLUMN IF NOT EXISTS founder_notes text;

-- ============ 2. Step claim timestamp ============
ALTER TABLE public.run_steps ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- ============ 3. Consensus threshold ============
INSERT INTO public.app_settings (key, value) VALUES ('consensus_threshold', '{"score": 8}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
ALTER TABLE public.cohorts ADD COLUMN IF NOT EXISTS consensus_threshold numeric
  CHECK (consensus_threshold IS NULL OR (consensus_threshold >= 1 AND consensus_threshold <= 10));

-- ============ 4. Field-manual flywheel ============
INSERT INTO public.app_settings (key, value) VALUES ('field_manual_addenda', '{"items": []}'::jsonb)
  ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.field_manual_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_rule text NOT NULL,
  rationale text,
  evidence jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

GRANT SELECT, UPDATE ON public.field_manual_proposals TO authenticated;
GRANT ALL ON public.field_manual_proposals TO service_role;
ALTER TABLE public.field_manual_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read field manual proposals" ON public.field_manual_proposals
  FOR SELECT TO authenticated USING (private.is_admin(auth.uid()));
CREATE POLICY "Admins update field manual proposals" ON public.field_manual_proposals
  FOR UPDATE TO authenticated
  USING (private.is_admin(auth.uid()))
  WITH CHECK (private.is_admin(auth.uid()));

-- ============ 5. Pipeline tables become server-write-only ============
-- Clients keep SELECT (realtime transcript) but every mutation now flows
-- through the edge functions. The one exception: owners may update
-- boardroom_runs.founder_notes (and nothing else — enforced by trigger).

REVOKE INSERT, DELETE ON public.boardroom_runs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.run_steps FROM authenticated;

CREATE OR REPLACE FUNCTION public.boardroom_runs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_boardroom_runs_guard ON public.boardroom_runs;
CREATE TRIGGER trg_boardroom_runs_guard
  BEFORE UPDATE ON public.boardroom_runs
  FOR EACH ROW EXECUTE FUNCTION public.boardroom_runs_guard();
