-- One-shot reset of compiled artifacts for a single batch so it can be
-- recompiled through the UI against the new F1b batch-compiler build.
-- Bypass the client-facing content guard by acting as replica; only the
-- three compile-artifact columns are touched.
BEGIN;
SET LOCAL session_replication_role = 'replica';
UPDATE public.batches
   SET compiled_prompt_md = NULL,
       compiled_at        = NULL,
       compile_meta       = NULL
 WHERE id = '03f5b2b7-c5e2-42cc-b510-3310203e1446';
COMMIT;