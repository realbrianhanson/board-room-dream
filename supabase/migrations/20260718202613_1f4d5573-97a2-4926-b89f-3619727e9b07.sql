DROP POLICY "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile" ON public.profiles
FOR UPDATE TO authenticated
USING (auth.uid() = id)
WITH CHECK (
  auth.uid() = id
  AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  AND (
    cohort_id IS NOT DISTINCT FROM (SELECT cohort_id FROM public.profiles WHERE id = auth.uid())
    OR current_setting('boardroom.allow_cohort_change', true) = 'on'
    OR private.is_admin(auth.uid())
  )
);