-- Restore authenticated read on model_registry.
-- Lovable's security scanner (migration 20260720041256) dropped the
-- authenticated read policy, leaving model_registry admin-read-only. That
-- broke the Boardroom seat display for non-admin students (the UI reads
-- seat/display_name/model_id to render each seat). This table is app config,
-- not user data, and the client must be able to read it — restore the policy.
DROP POLICY IF EXISTS "Read model registry" ON public.model_registry;
CREATE POLICY "Read model registry" ON public.model_registry
  FOR SELECT TO authenticated USING (true);
