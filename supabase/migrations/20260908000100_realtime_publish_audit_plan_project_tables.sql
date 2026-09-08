-- Realtime: publish the tables the UI already subscribes to (RC-12 / UI-5).
-- Only boardroom_runs, run_steps, batches and alerts were in the publication,
-- so the Audit Center, Plan and Dashboard channels on audits, audit_findings,
-- plan_versions, change_requests and projects never fired. Applied live by
-- hand on 2026-09-07 (Batch 0.6); committed here so a home deploy matches.
-- Idempotent: each table is added only when pg_publication_tables does not
-- list it yet, so re-running is a no-op.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'publication supabase_realtime does not exist; skipping realtime table registration';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['audits', 'audit_findings', 'plan_versions', 'change_requests', 'projects'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
