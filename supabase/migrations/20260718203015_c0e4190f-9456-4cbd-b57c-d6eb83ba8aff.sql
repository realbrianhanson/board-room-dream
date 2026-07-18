CREATE POLICY "Users can update own design screenshots"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'design-screenshots' AND auth.uid()::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'design-screenshots' AND auth.uid()::text = (storage.foldername(name))[1]);