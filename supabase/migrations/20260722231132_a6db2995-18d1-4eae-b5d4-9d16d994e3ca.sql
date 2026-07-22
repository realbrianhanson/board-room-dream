-- State integrity guards: prevent client-side tampering of trust/verdict/status fields.
-- Owners keep editing legitimate fields; privileged transitions must go through
-- server-side (service_role) code paths.

CREATE OR REPLACE FUNCTION public.intakes_guard_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.verdict IS DISTINCT FROM OLD.verdict THEN
      RAISE EXCEPTION 'intakes.verdict is set by the validation pipeline, not the client';
    END IF;
    IF NEW.validation_scores IS DISTINCT FROM OLD.validation_scores THEN
      RAISE EXCEPTION 'intakes.validation_scores is set by the validation pipeline, not the client';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intakes_guard_privileged ON public.intakes;
CREATE TRIGGER trg_intakes_guard_privileged
BEFORE UPDATE ON public.intakes
FOR EACH ROW EXECUTE FUNCTION public.intakes_guard_privileged_fields();

CREATE OR REPLACE FUNCTION public.projects_guard_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'projects.status is managed by server pipelines';
    END IF;
    IF NEW.current_batch_no IS DISTINCT FROM OLD.current_batch_no THEN
      RAISE EXCEPTION 'projects.current_batch_no is managed by server pipelines';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_guard_privileged ON public.projects;
CREATE TRIGGER trg_projects_guard_privileged
BEFORE UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.projects_guard_privileged_fields();
