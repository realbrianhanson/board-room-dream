ALTER TABLE public.audit_findings
  ADD COLUMN IF NOT EXISTS evidence text,
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS line_start integer,
  ADD COLUMN IF NOT EXISTS line_end integer;

ALTER TABLE public.audit_findings
  DROP CONSTRAINT IF EXISTS audit_findings_confidence_check,
  DROP CONSTRAINT IF EXISTS audit_findings_line_start_positive,
  DROP CONSTRAINT IF EXISTS audit_findings_line_end_positive,
  DROP CONSTRAINT IF EXISTS audit_findings_line_range_ordered;

ALTER TABLE public.audit_findings
  ADD CONSTRAINT audit_findings_confidence_check
    CHECK (confidence IN ('high','medium','low')),
  ADD CONSTRAINT audit_findings_line_start_positive
    CHECK (line_start IS NULL OR line_start > 0),
  ADD CONSTRAINT audit_findings_line_end_positive
    CHECK (line_end IS NULL OR line_end > 0),
  ADD CONSTRAINT audit_findings_line_range_ordered
    CHECK (line_start IS NULL OR line_end IS NULL OR line_end >= line_start);