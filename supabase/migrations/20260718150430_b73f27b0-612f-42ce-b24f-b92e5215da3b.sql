
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'intake'
    CHECK (status IN ('intake','validated','boardroom','locked','building','auditing','polishing','done','killed')),
  lovable_project_url text,
  github_repo text,
  current_batch_no int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT ALL ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners CRUD own projects (select)" ON public.projects
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners CRUD own projects (insert)" ON public.projects
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners CRUD own projects (update)" ON public.projects
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners CRUD own projects (delete)" ON public.projects
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Instructors read cohort projects" ON public.projects
  FOR SELECT TO authenticated USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );

CREATE TABLE public.intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_scores jsonb,
  verdict text CHECK (verdict IN ('pass','kill','override')),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.intakes TO authenticated;
GRANT ALL ON public.intakes TO service_role;
ALTER TABLE public.intakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners CRUD own intakes (select)" ON public.intakes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners CRUD own intakes (insert)" ON public.intakes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners CRUD own intakes (update)" ON public.intakes
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners CRUD own intakes (delete)" ON public.intakes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Instructors read cohort intakes" ON public.intakes
  FOR SELECT TO authenticated USING (
    public.is_admin(auth.uid())
    OR public.instructs_cohort(auth.uid(), public.user_cohort(user_id))
  );
