CREATE TABLE public.batch_generation_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  source_run_id uuid REFERENCES public.boardroom_runs(id) ON DELETE SET NULL,
  batches_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.batch_generation_archives TO authenticated;
GRANT ALL ON public.batch_generation_archives TO service_role;

ALTER TABLE public.batch_generation_archives ENABLE ROW LEVEL SECURITY;

-- Owners can read their own archives. No client INSERT/UPDATE/DELETE policy —
-- only the service-role pipeline (regenerate_batches) writes here.
CREATE POLICY "Owners read their archives"
ON public.batch_generation_archives
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX batch_generation_archives_project_created_idx
  ON public.batch_generation_archives (project_id, created_at DESC);