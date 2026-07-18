-- design-screenshots storage policies (owner-scoped {user_id}/{project_id}/...)
DROP POLICY IF EXISTS "design_screenshots_owner_select" ON storage.objects;
DROP POLICY IF EXISTS "design_screenshots_owner_insert" ON storage.objects;
DROP POLICY IF EXISTS "design_screenshots_owner_update" ON storage.objects;
DROP POLICY IF EXISTS "design_screenshots_owner_delete" ON storage.objects;

CREATE POLICY "design_screenshots_owner_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "design_screenshots_owner_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "design_screenshots_owner_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "design_screenshots_owner_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );