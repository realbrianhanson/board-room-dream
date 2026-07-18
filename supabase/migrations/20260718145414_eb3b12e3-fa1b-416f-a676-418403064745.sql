
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.instructs_cohort(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_cohort(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.instructs_cohort(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_cohort(uuid) TO authenticated;
