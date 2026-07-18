
CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid REFERENCES public.cohorts(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('stuck_48h','audit_loop','spend_cap','never_locked')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','snoozed')),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  snoozed_until timestamptz
);

CREATE INDEX alerts_open_by_project_kind ON public.alerts (project_id, kind) WHERE status = 'open';
CREATE INDEX alerts_cohort_status ON public.alerts (cohort_id, status);

GRANT SELECT, UPDATE ON public.alerts TO authenticated;
GRANT ALL ON public.alerts TO service_role;

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

-- Instructors/admins of the cohort may read. Students never.
CREATE POLICY "Instructors read cohort alerts"
ON public.alerts FOR SELECT
TO authenticated
USING (
  public.is_admin(auth.uid())
  OR (cohort_id IS NOT NULL AND public.instructs_cohort(auth.uid(), cohort_id))
);

CREATE POLICY "Instructors resolve/snooze cohort alerts"
ON public.alerts FOR UPDATE
TO authenticated
USING (
  public.is_admin(auth.uid())
  OR (cohort_id IS NOT NULL AND public.instructs_cohort(auth.uid(), cohort_id))
)
WITH CHECK (
  public.is_admin(auth.uid())
  OR (cohort_id IS NOT NULL AND public.instructs_cohort(auth.uid(), cohort_id))
);

-- Guard: clients may only change status/resolved_at/snoozed_until
CREATE OR REPLACE FUNCTION public.alerts_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id            IS DISTINCT FROM OLD.id
    OR NEW.cohort_id     IS DISTINCT FROM OLD.cohort_id
    OR NEW.user_id       IS DISTINCT FROM OLD.user_id
    OR NEW.project_id    IS DISTINCT FROM OLD.project_id
    OR NEW.kind          IS DISTINCT FROM OLD.kind
    OR NEW.detail        IS DISTINCT FROM OLD.detail
    OR NEW.created_at    IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Clients may only update status/resolved_at/snoozed_until';
    END IF;
    IF NEW.status NOT IN ('open','resolved','snoozed') THEN
      RAISE EXCEPTION 'Invalid alert status';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alerts_guard_trg
BEFORE UPDATE ON public.alerts
FOR EACH ROW EXECUTE FUNCTION public.alerts_guard();

ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
