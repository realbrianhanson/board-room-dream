-- Audits: per-batch and final A-Z audit runs.
CREATE TABLE public.audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES public.batches(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('batch','final_az')),
  run_id uuid REFERENCES public.boardroom_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','clean','findings','failed')),
  loop_no int NOT NULL DEFAULT 1,
  source text CHECK (source IN ('github','paste')),
  base_sha text,
  head_sha text,
  files_analyzed int,
  summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
GRANT SELECT ON public.audits TO authenticated;
GRANT ALL ON public.audits TO service_role;
ALTER TABLE public.audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own audits" ON public.audits
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Instructor reads cohort audits" ON public.audits
FOR SELECT TO authenticated
USING (
  public.is_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = public.audits.user_id
      AND p.cohort_id IS NOT NULL
      AND public.instructs_cohort(auth.uid(), p.cohort_id)
  )
);

CREATE INDEX audits_project_idx ON public.audits(project_id, created_at DESC);
CREATE INDEX audits_batch_idx ON public.audits(batch_id);

-- Findings from audits.
CREATE TABLE public.audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seat text,
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  file_path text,
  title text NOT NULL,
  description text,
  fix_batch_id uuid REFERENCES public.batches(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fix_drafted','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.audit_findings TO authenticated;
GRANT ALL ON public.audit_findings TO service_role;
ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner reads own findings" ON public.audit_findings
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Instructor reads cohort findings" ON public.audit_findings
FOR SELECT TO authenticated
USING (
  public.is_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = public.audit_findings.user_id
      AND p.cohort_id IS NOT NULL
      AND public.instructs_cohort(auth.uid(), p.cohort_id)
  )
);

CREATE POLICY "Owner may dismiss low-severity findings"
ON public.audit_findings
FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE INDEX audit_findings_audit_idx ON public.audit_findings(audit_id);
CREATE INDEX audit_findings_status_idx ON public.audit_findings(status);

-- Guard: clients may only move P2/P3 findings from open → dismissed.
CREATE OR REPLACE FUNCTION public.audit_findings_guard()
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
    -- Only status may change.
    IF NEW.audit_id     IS DISTINCT FROM OLD.audit_id
    OR NEW.user_id      IS DISTINCT FROM OLD.user_id
    OR NEW.seat         IS DISTINCT FROM OLD.seat
    OR NEW.severity     IS DISTINCT FROM OLD.severity
    OR NEW.file_path    IS DISTINCT FROM OLD.file_path
    OR NEW.title        IS DISTINCT FROM OLD.title
    OR NEW.description  IS DISTINCT FROM OLD.description
    OR NEW.fix_batch_id IS DISTINCT FROM OLD.fix_batch_id
    OR NEW.created_at   IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Clients may only update finding status';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.severity NOT IN ('P2','P3') THEN
        RAISE EXCEPTION 'P0/P1 findings resolve only through re-audit';
      END IF;
      IF OLD.status <> 'open' OR NEW.status <> 'dismissed' THEN
        RAISE EXCEPTION 'Only open P2/P3 findings can be dismissed';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_findings_guard_trg
BEFORE UPDATE ON public.audit_findings
FOR EACH ROW EXECUTE FUNCTION public.audit_findings_guard();
