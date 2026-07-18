
-- 1. Private schema for privileged helpers
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- 2. Recreate helpers in private schema (SECURITY DEFINER; not in exposed API)
CREATE OR REPLACE FUNCTION private.is_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _uid AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION private.instructs_cohort(_uid uuid, _cohort uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.cohorts WHERE id = _cohort AND instructor_id = _uid);
$$;

CREATE OR REPLACE FUNCTION private.user_cohort(_uid uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cohort_id FROM public.profiles WHERE id = _uid;
$$;

REVOKE ALL ON FUNCTION private.is_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.instructs_cohort(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.user_cohort(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.is_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.instructs_cohort(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.user_cohort(uuid) TO authenticated, service_role;

-- 3. Move join_cohort implementation into private; keep a thin invoker wrapper in public
CREATE OR REPLACE FUNCTION private.join_cohort(code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cohort_id uuid; _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT id INTO _cohort_id FROM public.cohorts WHERE join_code = code;
  IF _cohort_id IS NULL THEN RAISE EXCEPTION 'Invalid cohort code'; END IF;
  PERFORM set_config('boardroom.allow_cohort_change', 'on', true);
  UPDATE public.profiles SET cohort_id = _cohort_id WHERE id = _uid;
  RETURN _cohort_id;
END;
$$;
REVOKE ALL ON FUNCTION private.join_cohort(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.join_cohort(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.join_cohort(code text)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = public AS $$
  SELECT private.join_cohort(code);
$$;
REVOKE ALL ON FUNCTION public.join_cohort(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_cohort(text) TO authenticated;

-- 4. Recreate every RLS policy that referenced the public helpers
-- profiles
DROP POLICY IF EXISTS "Instructors read cohort profiles" ON public.profiles;
CREATE POLICY "Instructors read cohort profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (cohort_id IS NOT NULL AND (private.instructs_cohort(auth.uid(), cohort_id) OR private.is_admin(auth.uid())));

-- cohorts
DROP POLICY IF EXISTS "Members read own cohort" ON public.cohorts;
CREATE POLICY "Members read own cohort" ON public.cohorts
  FOR SELECT TO authenticated USING (id = private.user_cohort(auth.uid()));

DROP POLICY IF EXISTS "Instructors read their cohorts" ON public.cohorts;
CREATE POLICY "Instructors read their cohorts" ON public.cohorts
  FOR SELECT TO authenticated USING (instructor_id = auth.uid() OR private.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Instructors update their cohorts" ON public.cohorts;
CREATE POLICY "Instructors update their cohorts" ON public.cohorts
  FOR UPDATE TO authenticated
  USING (instructor_id = auth.uid() OR private.is_admin(auth.uid()))
  WITH CHECK (instructor_id = auth.uid() OR private.is_admin(auth.uid()));

-- projects
DROP POLICY IF EXISTS "Instructors read cohort projects" ON public.projects;
CREATE POLICY "Instructors read cohort projects" ON public.projects
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- intakes
DROP POLICY IF EXISTS "Instructors read cohort intakes" ON public.intakes;
CREATE POLICY "Instructors read cohort intakes" ON public.intakes
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- boardroom_runs
DROP POLICY IF EXISTS "Instructors read runs in their cohorts" ON public.boardroom_runs;
CREATE POLICY "Instructors read runs in their cohorts" ON public.boardroom_runs
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- run_steps
DROP POLICY IF EXISTS "Instructors read steps in their cohorts" ON public.run_steps;
CREATE POLICY "Instructors read steps in their cohorts" ON public.run_steps
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- plan_versions
DROP POLICY IF EXISTS "Instructors read plan versions in their cohorts" ON public.plan_versions;
CREATE POLICY "Instructors read plan versions in their cohorts" ON public.plan_versions
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- change_requests
DROP POLICY IF EXISTS "Instructors read change requests in their cohorts" ON public.change_requests;
CREATE POLICY "Instructors read change requests in their cohorts" ON public.change_requests
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- batches
DROP POLICY IF EXISTS "Instructors read cohort batches" ON public.batches;
CREATE POLICY "Instructors read cohort batches" ON public.batches
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- audits
DROP POLICY IF EXISTS "Instructor reads cohort audits" ON public.audits;
CREATE POLICY "Instructor reads cohort audits" ON public.audits
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = audits.user_id AND p.cohort_id IS NOT NULL AND private.instructs_cohort(auth.uid(), p.cohort_id)
  ));

-- audit_findings (instructor read + severity-checked dismiss)
DROP POLICY IF EXISTS "Instructor reads cohort findings" ON public.audit_findings;
CREATE POLICY "Instructor reads cohort findings" ON public.audit_findings
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = audit_findings.user_id AND p.cohort_id IS NOT NULL AND private.instructs_cohort(auth.uid(), p.cohort_id)
  ));

DROP POLICY IF EXISTS "Owner may dismiss low-severity findings" ON public.audit_findings;
CREATE POLICY "Owner may dismiss low-severity findings" ON public.audit_findings
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    AND severity IN ('P2','P3')
    AND status = 'open'
  )
  WITH CHECK (
    user_id = auth.uid()
    AND severity IN ('P2','P3')
    AND status = 'dismissed'
  );

-- cost_ledger
DROP POLICY IF EXISTS "Instructors read cost ledger in their cohorts" ON public.cost_ledger;
CREATE POLICY "Instructors read cost ledger in their cohorts" ON public.cost_ledger
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR private.instructs_cohort(auth.uid(), private.user_cohort(user_id)));

-- alerts
DROP POLICY IF EXISTS "Instructors read cohort alerts" ON public.alerts;
CREATE POLICY "Instructors read cohort alerts" ON public.alerts
  FOR SELECT TO authenticated
  USING (private.is_admin(auth.uid()) OR (cohort_id IS NOT NULL AND private.instructs_cohort(auth.uid(), cohort_id)));

DROP POLICY IF EXISTS "Instructors resolve/snooze cohort alerts" ON public.alerts;
CREATE POLICY "Instructors resolve/snooze cohort alerts" ON public.alerts
  FOR UPDATE TO authenticated
  USING (private.is_admin(auth.uid()) OR (cohort_id IS NOT NULL AND private.instructs_cohort(auth.uid(), cohort_id)))
  WITH CHECK (private.is_admin(auth.uid()) OR (cohort_id IS NOT NULL AND private.instructs_cohort(auth.uid(), cohort_id)));

-- model_registry admin-only writes (repoint to private.is_admin)
DROP POLICY IF EXISTS "Admins insert model registry" ON public.model_registry;
CREATE POLICY "Admins insert model registry" ON public.model_registry
  FOR INSERT TO authenticated WITH CHECK (private.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins update model registry" ON public.model_registry;
CREATE POLICY "Admins update model registry" ON public.model_registry
  FOR UPDATE TO authenticated USING (private.is_admin(auth.uid())) WITH CHECK (private.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins delete model registry" ON public.model_registry;
CREATE POLICY "Admins delete model registry" ON public.model_registry
  FOR DELETE TO authenticated USING (private.is_admin(auth.uid()));

-- app_settings admin-only writes
DROP POLICY IF EXISTS "Admins insert app settings" ON public.app_settings;
CREATE POLICY "Admins insert app settings" ON public.app_settings
  FOR INSERT TO authenticated WITH CHECK (private.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins update app settings" ON public.app_settings;
CREATE POLICY "Admins update app settings" ON public.app_settings
  FOR UPDATE TO authenticated USING (private.is_admin(auth.uid())) WITH CHECK (private.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins delete app settings" ON public.app_settings;
CREATE POLICY "Admins delete app settings" ON public.app_settings
  FOR DELETE TO authenticated USING (private.is_admin(auth.uid()));

-- 5. Restrict SELECT on model_registry & app_settings to admins; expose safe subsets via views
DROP POLICY IF EXISTS "Read model registry" ON public.model_registry;
CREATE POLICY "Admins read model registry" ON public.model_registry
  FOR SELECT TO authenticated USING (private.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Read app settings" ON public.app_settings;
CREATE POLICY "Admins read app settings" ON public.app_settings
  FOR SELECT TO authenticated USING (private.is_admin(auth.uid()));

CREATE OR REPLACE VIEW public.v_seats AS
  SELECT seat, display_name, model_id, enabled FROM public.model_registry;
GRANT SELECT ON public.v_seats TO authenticated;

CREATE OR REPLACE VIEW public.v_default_daily_cap AS
  SELECT value FROM public.app_settings WHERE key = 'default_daily_cap_usd';
GRANT SELECT ON public.v_default_daily_cap TO authenticated;

-- 6. Rewrite trigger functions that used public.is_admin to use private.is_admin
CREATE OR REPLACE FUNCTION public.profiles_guard_privileged_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _bypass text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    _bypass := current_setting('boardroom.allow_cohort_change', true);
    IF NEW.role IS DISTINCT FROM OLD.role AND NOT private.is_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Not allowed to change role';
    END IF;
    IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
       AND NOT private.is_admin(auth.uid())
       AND COALESCE(_bypass, '') <> 'on' THEN
      RAISE EXCEPTION 'Cohort must be set via join_cohort()';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 7. Drop the old public helpers now that nothing references them
DROP FUNCTION IF EXISTS public.is_admin(uuid);
DROP FUNCTION IF EXISTS public.instructs_cohort(uuid, uuid);
DROP FUNCTION IF EXISTS public.user_cohort(uuid);

-- 8. Revoke EXECUTE on internal trigger functions from client roles (triggers still fire)
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profiles_guard_privileged_fields() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.batches_guard_content() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_findings_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alerts_guard() FROM PUBLIC, anon, authenticated;
