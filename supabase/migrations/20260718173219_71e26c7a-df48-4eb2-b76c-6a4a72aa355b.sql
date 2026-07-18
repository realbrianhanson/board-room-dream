
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_import boolean NOT NULL DEFAULT false;

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_status_check
  CHECK (status IN ('intake','validated','boardroom','locked','building','auditing','polishing','done','killed','imported'));
