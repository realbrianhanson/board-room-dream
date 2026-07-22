DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'batch_generation_archives_user_id_fkey'
      AND conrelid = 'public.batch_generation_archives'::regclass
  ) THEN
    ALTER TABLE public.batch_generation_archives
      ADD CONSTRAINT batch_generation_archives_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE public.batch_generation_archives
      VALIDATE CONSTRAINT batch_generation_archives_user_id_fkey;
  END IF;
END $$;