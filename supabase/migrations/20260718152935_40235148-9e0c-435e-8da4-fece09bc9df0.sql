
-- ============ plan_versions ============
CREATE TABLE public.plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan','design')),
  version int NOT NULL,
  content_md text NOT NULL,
  features jsonb,
  decision_log jsonb,
  dissent_ledger jsonb,
  is_chair_ruled boolean NOT NULL DEFAULT false,
  source_run_id uuid REFERENCES public.boardroom_runs(id) ON DELETE SET NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, kind, version)
);

GRANT SELECT ON public.plan_versions TO authenticated;
GRANT ALL ON public.plan_versions TO service_role;

ALTER TABLE public.plan_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own plan versions" ON public.plan_versions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Instructors read plan versions in their cohorts" ON public.plan_versions
  FOR SELECT TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );

CREATE INDEX plan_versions_project_kind_idx ON public.plan_versions(project_id, kind, version DESC);

-- ============ change_requests ============
CREATE TABLE public.change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_version_id uuid REFERENCES public.plan_versions(id) ON DELETE SET NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  board_verdict jsonb,
  run_id uuid REFERENCES public.boardroom_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.change_requests TO authenticated;
GRANT ALL ON public.change_requests TO service_role;

ALTER TABLE public.change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own change requests" ON public.change_requests
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Owner inserts own change requests" ON public.change_requests
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Instructors read change requests in their cohorts" ON public.change_requests
  FOR SELECT TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );
