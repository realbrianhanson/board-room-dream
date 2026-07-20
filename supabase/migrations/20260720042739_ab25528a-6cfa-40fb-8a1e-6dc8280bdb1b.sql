CREATE INDEX IF NOT EXISTS run_steps_run_id_created_at_idx ON public.run_steps (run_id, created_at);
CREATE INDEX IF NOT EXISTS run_steps_run_id_status_created_at_idx ON public.run_steps (run_id, status, created_at);
ANALYZE public.run_steps;