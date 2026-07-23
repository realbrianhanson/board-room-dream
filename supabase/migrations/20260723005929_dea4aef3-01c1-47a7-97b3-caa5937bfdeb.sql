ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS previous_project_status text;

ALTER TABLE public.projects DISABLE TRIGGER USER;
UPDATE public.projects p
   SET status = COALESCE(
     (SELECT CASE WHEN EXISTS (
        SELECT 1 FROM public.plan_versions pv
         WHERE pv.project_id = p.id AND pv.kind = 'plan' AND pv.is_build_safe = true
      ) THEN 'locked'
        WHEN p.is_import THEN 'imported'
        ELSE 'validated' END),
     'validated')
 WHERE p.status = 'auditing'
   AND NOT EXISTS (
     SELECT 1 FROM public.boardroom_runs r
      WHERE r.project_id = p.id
        AND r.kind = 'audit'
        AND r.status NOT IN ('failed','completed','consensus','chair_ruled')
   );
ALTER TABLE public.projects ENABLE TRIGGER USER;