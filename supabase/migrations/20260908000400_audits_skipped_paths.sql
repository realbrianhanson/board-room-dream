-- RC-6 audit cost: the audit-runner now records which repo files the
-- selection never read (tests, generated files, oversize, over the file cap)
-- so the Chair merge and the Audit Center can state coverage honestly
-- instead of "200 files were read". Idempotent.
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS files_skipped integer;
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS skipped_paths jsonb;
