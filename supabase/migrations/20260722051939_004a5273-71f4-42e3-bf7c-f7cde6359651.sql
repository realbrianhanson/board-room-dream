ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS compiled_verification_prompt_md text;

-- Extend the batches_guard_content trigger allowlist so the compiler can set this field.
CREATE OR REPLACE FUNCTION public.batches_guard_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id                     IS DISTINCT FROM OLD.project_id
    OR NEW.user_id                        IS DISTINCT FROM OLD.user_id
    OR NEW.plan_version_id                IS DISTINCT FROM OLD.plan_version_id
    OR NEW.batch_no                       IS DISTINCT FROM OLD.batch_no
    OR NEW.title                          IS DISTINCT FROM OLD.title
    OR NEW.channel                        IS DISTINCT FROM OLD.channel
    OR NEW.prompt_md                      IS DISTINCT FROM OLD.prompt_md
    OR NEW.is_fix                         IS DISTINCT FROM OLD.is_fix
    OR NEW.parent_batch_id                IS DISTINCT FROM OLD.parent_batch_id
    OR NEW.created_at                     IS DISTINCT FROM OLD.created_at
    OR NEW.compiled_prompt_md             IS DISTINCT FROM OLD.compiled_prompt_md
    OR NEW.compiled_verification_prompt_md IS DISTINCT FROM OLD.compiled_verification_prompt_md
    OR NEW.compiled_at                    IS DISTINCT FROM OLD.compiled_at
    OR NEW.compile_meta                   IS DISTINCT FROM OLD.compile_meta
    THEN
      RAISE EXCEPTION 'Only status, sent_at, built_at, and outcome_md may be updated by clients';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;