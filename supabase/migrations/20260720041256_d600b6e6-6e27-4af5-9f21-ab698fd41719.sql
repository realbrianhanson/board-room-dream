
-- Revoke EXECUTE on SECURITY DEFINER trigger functions from anon/authenticated/public
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.profiles_guard_privileged_fields() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.alerts_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_findings_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.batches_guard_content() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.boardroom_runs_guard() FROM PUBLIC, anon, authenticated;

-- Drop the overly permissive model_registry read policy; admin-only policy remains
DROP POLICY IF EXISTS "Authenticated read model registry rows" ON public.model_registry;
