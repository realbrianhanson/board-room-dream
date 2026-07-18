
-- Drop broken views
DROP VIEW IF EXISTS public.v_seats;
DROP VIEW IF EXISTS public.v_default_daily_cap;

-- === model_registry: broad SELECT policy, but grant only safe columns to authenticated ===
DROP POLICY IF EXISTS "Admins read model registry" ON public.model_registry;
CREATE POLICY "Read model registry (safe columns)" ON public.model_registry
  FOR SELECT TO authenticated USING (true);

REVOKE SELECT ON public.model_registry FROM authenticated;
GRANT SELECT (seat, display_name, model_id, enabled, use_latest_alias, fallback_model_id, updated_at)
  ON public.model_registry TO authenticated;

-- Admin lookup for the settings editor (returns everything, including role_prompt)
CREATE OR REPLACE FUNCTION private.admin_model_registry()
RETURNS SETOF public.model_registry
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.model_registry WHERE private.is_admin(auth.uid());
$$;
REVOKE ALL ON FUNCTION private.admin_model_registry() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.admin_model_registry() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_model_registry()
RETURNS SETOF public.model_registry
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT * FROM private.admin_model_registry();
$$;
REVOKE ALL ON FUNCTION public.admin_model_registry() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_model_registry() TO authenticated;

-- === app_settings: only default_daily_cap row readable by all authenticated; admins read all ===
DROP POLICY IF EXISTS "Admins read app settings" ON public.app_settings;
CREATE POLICY "Read default daily cap" ON public.app_settings
  FOR SELECT TO authenticated USING (key = 'default_daily_cap_usd');
CREATE POLICY "Admins read all app settings" ON public.app_settings
  FOR SELECT TO authenticated USING (private.is_admin(auth.uid()));
