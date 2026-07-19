-- Restrict base table reads to admins; expose safe columns via a view
DROP POLICY IF EXISTS "Read model registry (safe columns)" ON public.model_registry;

CREATE POLICY "Admins read model registry"
ON public.model_registry
FOR SELECT
TO authenticated
USING (private.is_admin(auth.uid()));

CREATE OR REPLACE VIEW public.model_registry_public
WITH (security_invoker = true) AS
SELECT seat, display_name, model_id, enabled
FROM public.model_registry;

GRANT SELECT ON public.model_registry_public TO authenticated;

-- Allow the invoker-view SELECT to succeed for non-admins by adding a
-- safe-columns policy scoped to view usage is not possible; instead add a
-- permissive SELECT policy that only exposes rows through the view's fixed
-- column list. Since security_invoker respects RLS, we need a policy that
-- allows authenticated reads. To prevent base-table column exposure, revoke
-- column privileges on sensitive columns.
CREATE POLICY "Authenticated read model registry rows"
ON public.model_registry
FOR SELECT
TO authenticated
USING (true);

REVOKE SELECT ON public.model_registry FROM authenticated;
GRANT SELECT (seat, display_name, model_id, enabled) ON public.model_registry TO authenticated;
