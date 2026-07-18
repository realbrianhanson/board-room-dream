
-- Batch 14 — cost controls + punch-list fixes.

-- 1. Refusal fallback registry column
ALTER TABLE public.model_registry ADD COLUMN IF NOT EXISTS fallback_model_id text;
UPDATE public.model_registry SET fallback_model_id = 'moonshotai/kimi-k3' WHERE fallback_model_id IS NULL OR fallback_model_id = '';

-- 2. Daily spend cap (per-cohort override + global default)
ALTER TABLE public.cohorts ADD COLUMN IF NOT EXISTS daily_cap_usd numeric;

-- Allow the instructor of a cohort (or an admin) to update ONLY their cohort row.
DROP POLICY IF EXISTS "Instructors update their cohorts" ON public.cohorts;
CREATE POLICY "Instructors update their cohorts" ON public.cohorts
  FOR UPDATE TO authenticated
  USING (instructor_id = auth.uid() OR public.is_admin(auth.uid()))
  WITH CHECK (instructor_id = auth.uid() OR public.is_admin(auth.uid()));

-- Global default cap setting (admin-editable via existing app_settings RLS)
INSERT INTO public.app_settings (key, value, version)
VALUES ('default_daily_cap_usd', '{"usd": 25}'::jsonb, 1)
ON CONFLICT (key) DO NOTHING;

-- 3a. Punch-list: final QA batch should be channel 'lovable' (pasted into Lovable)
UPDATE public.batches SET channel = 'lovable' WHERE title = 'Final A-Z QA' AND channel = 'human';

-- 3c. Punch-list: drop duplicate underscore-named storage policies; keep hyphen-named originals.
DROP POLICY IF EXISTS "design_screenshots_owner_select" ON storage.objects;
DROP POLICY IF EXISTS "design_screenshots_owner_insert" ON storage.objects;
DROP POLICY IF EXISTS "design_screenshots_owner_update" ON storage.objects;
DROP POLICY IF EXISTS "design_screenshots_owner_delete" ON storage.objects;
