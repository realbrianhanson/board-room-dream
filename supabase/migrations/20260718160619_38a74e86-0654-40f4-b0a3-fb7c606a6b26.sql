CREATE POLICY "design-screenshots: owner insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "design-screenshots: owner select" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "design-screenshots: owner delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'design-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );