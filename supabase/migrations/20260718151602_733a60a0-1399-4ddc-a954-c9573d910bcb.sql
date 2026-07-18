
-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============ boardroom_runs ============
CREATE TABLE public.boardroom_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('test','plan','features','design','change_request','audit')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','paused_budget','consensus','chair_ruled','failed')),
  round_no int NOT NULL DEFAULT 1,
  loop_no int NOT NULL DEFAULT 0,
  constitution_version int,
  budget_usd numeric NOT NULL DEFAULT 10.00,
  spent_usd numeric NOT NULL DEFAULT 0,
  budget_warning boolean NOT NULL DEFAULT false,
  consensus jsonb,
  dissent_ledger jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.boardroom_runs TO authenticated;
GRANT ALL ON public.boardroom_runs TO service_role;

ALTER TABLE public.boardroom_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner full access to own runs" ON public.boardroom_runs
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Instructors read runs in their cohorts" ON public.boardroom_runs
  FOR SELECT TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );

-- ============ run_steps ============
CREATE TABLE public.run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.boardroom_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  round int NOT NULL,
  seat text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','skipped')),
  request jsonb,
  response_text text,
  response_json jsonb,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(run_id, step_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.run_steps TO authenticated;
GRANT ALL ON public.run_steps TO service_role;

ALTER TABLE public.run_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner full access to own steps" ON public.run_steps
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Instructors read steps in their cohorts" ON public.run_steps
  FOR SELECT TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );

CREATE INDEX run_steps_run_status_idx ON public.run_steps(run_id, status);

-- ============ cost_ledger ============
CREATE TABLE public.cost_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  run_id uuid REFERENCES public.boardroom_runs(id) ON DELETE SET NULL,
  seat text,
  model_id text,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.cost_ledger TO authenticated;
GRANT ALL ON public.cost_ledger TO service_role;

ALTER TABLE public.cost_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own cost ledger" ON public.cost_ledger
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Instructors read cost ledger in their cohorts" ON public.cost_ledger
  FOR SELECT TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );

-- updated_at trigger for boardroom_runs
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_boardroom_runs_touch
BEFORE UPDATE ON public.boardroom_runs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.boardroom_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.run_steps;
