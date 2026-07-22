-- AUDIT-FINALIZATION-R2: Restore authenticated read on public.model_registry
-- so the SECURITY INVOKER view public.model_registry_public can return the
-- safe seat rows to signed-in users. Migration 20260721034626 dropped the
-- previously-restored "Read model registry" policy, leaving the base table
-- admin-read-only; because model_registry_public runs with security_invoker
-- (RLS is evaluated as the querying user), non-admin authenticated users get
-- zero rows even though the view exposes only safe columns.
--
-- Fix (idempotent, additive):
--   - Add a permissive SELECT policy on the base table for authenticated
--     users. RLS still applies through the security-invoker view.
--   - GRANT SELECT only on the safe columns exposed by the public view.
--     Sensitive columns (role_prompt, fallback_model_id, max_cost_per_run,
--     use_latest_alias, updated_at) remain unreadable via direct base-table
--     SELECT for non-admins.
--   - Preserve admin INSERT / UPDATE / DELETE policies. Do NOT grant writes.

DROP POLICY IF EXISTS "Authenticated read model registry rows" ON public.model_registry;
CREATE POLICY "Authenticated read model registry rows"
  ON public.model_registry
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE SELECT ON public.model_registry FROM authenticated;
GRANT SELECT (seat, display_name, model_id, enabled)
  ON public.model_registry TO authenticated;

GRANT SELECT ON public.model_registry_public TO authenticated;

COMMENT ON POLICY "Authenticated read model registry rows" ON public.model_registry IS
  'AUDIT-FINALIZATION-R2: required by SECURITY INVOKER view model_registry_public. Migration 20260721034626 dropped the previous read policy; without this policy the public view returns 0 rows to non-admin authenticated users. Column-level GRANT keeps sensitive columns (role_prompt, fallback_model_id, max_cost_per_run) unreadable via direct base-table SELECT. Admin write policies remain intact.';