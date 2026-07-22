-- Repair audit/run drift: audits still 'running' whose linked boardroom_runs
-- row is terminally 'failed' must reflect that failure. Nothing else changes.
UPDATE public.audits a
   SET status = 'failed',
       completed_at = COALESCE(a.completed_at, now())
  FROM public.boardroom_runs br
 WHERE a.status = 'running'
   AND br.id = a.run_id
   AND br.status = 'failed';