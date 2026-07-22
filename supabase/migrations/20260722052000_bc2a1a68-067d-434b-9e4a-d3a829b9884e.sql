SET LOCAL session_replication_role = 'replica';
UPDATE public.batches
SET compiled_prompt_md = NULL,
    compiled_verification_prompt_md = NULL,
    compiled_at = NULL,
    compile_meta = NULL
WHERE id = '03f5b2b7-c5e2-42cc-b510-3310203e1446';
SET LOCAL session_replication_role = 'origin';