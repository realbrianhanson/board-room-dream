
-- Tighten EXECUTE on SECURITY DEFINER functions in public schema.

-- Trigger function: never called directly by clients.
REVOKE EXECUTE ON FUNCTION public.sync_user_role_from_profile() FROM PUBLIC, anon, authenticated;

-- Self-probe: only signed-in users need it; anon must not call it.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
-- Preserve intended callers (idempotent).
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

-- Batch status RPC: strip PUBLIC/anon; only signed-in owners call it (function enforces auth.uid() ownership).
REVOKE EXECUTE ON FUNCTION public.set_batch_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_batch_status(uuid, text, text) TO authenticated, service_role;
