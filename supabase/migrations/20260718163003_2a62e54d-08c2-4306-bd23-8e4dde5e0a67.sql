
ALTER TABLE public.boardroom_runs DROP CONSTRAINT IF EXISTS boardroom_runs_kind_check;
ALTER TABLE public.boardroom_runs ADD CONSTRAINT boardroom_runs_kind_check
  CHECK (kind IN ('test','plan','features','design','change_request','audit','batches'));

ALTER TABLE public.boardroom_runs DROP CONSTRAINT IF EXISTS boardroom_runs_status_check;
ALTER TABLE public.boardroom_runs ADD CONSTRAINT boardroom_runs_status_check
  CHECK (status IN ('queued','running','paused','paused_budget','consensus','chair_ruled','failed','completed'));

CREATE TABLE public.batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_version_id uuid REFERENCES public.plan_versions(id) ON DELETE SET NULL,
  batch_no numeric(6,2) NOT NULL,
  title text NOT NULL,
  channel text NOT NULL DEFAULT 'lovable' CHECK (channel IN ('lovable','supabase','human')),
  prompt_md text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','built','auditing','fix_needed','passed','skipped')),
  is_fix boolean NOT NULL DEFAULT false,
  parent_batch_id uuid REFERENCES public.batches(id) ON DELETE SET NULL,
  sent_at timestamptz,
  built_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, batch_no)
);

GRANT SELECT, UPDATE ON public.batches TO authenticated;
GRANT ALL ON public.batches TO service_role;

ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own batches" ON public.batches
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Instructors read cohort batches" ON public.batches
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id)));

CREATE POLICY "Owner updates own batches" ON public.batches
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.batches_guard_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role bypass (server-authored inserts/edits).
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id       IS DISTINCT FROM OLD.project_id
    OR NEW.user_id          IS DISTINCT FROM OLD.user_id
    OR NEW.plan_version_id  IS DISTINCT FROM OLD.plan_version_id
    OR NEW.batch_no         IS DISTINCT FROM OLD.batch_no
    OR NEW.title            IS DISTINCT FROM OLD.title
    OR NEW.channel          IS DISTINCT FROM OLD.channel
    OR NEW.prompt_md        IS DISTINCT FROM OLD.prompt_md
    OR NEW.is_fix           IS DISTINCT FROM OLD.is_fix
    OR NEW.parent_batch_id  IS DISTINCT FROM OLD.parent_batch_id
    OR NEW.created_at       IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Only status, sent_at, and built_at may be updated by clients';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_batches_guard_content
  BEFORE UPDATE ON public.batches
  FOR EACH ROW EXECUTE FUNCTION public.batches_guard_content();

CREATE INDEX idx_batches_project_batch_no ON public.batches (project_id, batch_no);

ALTER PUBLICATION supabase_realtime ADD TABLE public.batches;
