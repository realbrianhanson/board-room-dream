-- Pin the board's seats to the registry rows the live database holds
-- (Batch 12 / RC-7) so a fresh environment seeds the same board, and keep a
-- history of every later registry edit so a Settings change leaves a trail.
-- Idempotent: re-running restores the six rows (role_prompt is never touched)
-- and recreates the history objects in place.

INSERT INTO public.model_registry
  (seat, model_id, fallback_model_id, max_cost_per_run, display_name, enabled, updated_at)
VALUES
  ('chair',      'anthropic/claude-fable-5.1', 'openai/gpt-6-astra',         10.00, 'The Chair · Claude Fable 5.1',        true, now()),
  ('strategist', 'openai/gpt-6-astra',         'anthropic/claude-fable-5.1', 10.00, 'The Strategist · GPT-6 Astra',        true, now()),
  ('contrarian', 'x-ai/grok-4.6',              'qwen/qwen3.8-max-0902',       5.00, 'The Contrarian · Grok 4.6',           true, now()),
  ('inspector',  'qwen/qwen3.8-max-0902',      'x-ai/grok-4.6',               5.00, 'The Inspector · Qwen3.8 Max',         true, now()),
  ('reserve',    'anthropic/claude-haiku-4.5', NULL,                          5.00, 'The Reserve · Claude Haiku 4.5',      true, now()),
  ('smoke',      'anthropic/claude-haiku-4.5', NULL,                          1.00, 'Smoke rehearsal · Claude Haiku 4.5',  true, now())
ON CONFLICT (seat) DO UPDATE SET
  model_id          = EXCLUDED.model_id,
  fallback_model_id = EXCLUDED.fallback_model_id,
  max_cost_per_run  = EXCLUDED.max_cost_per_run,
  display_name      = EXCLUDED.display_name,
  enabled           = EXCLUDED.enabled,
  updated_at        = now();

-- ============ model_registry_history ============
-- One row per registry UPDATE: the full old and new rows, who changed them
-- (NULL for the service role / migrations) and when. Admin-read only; rows
-- are written solely by the trigger below.
CREATE TABLE IF NOT EXISTS public.model_registry_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat text NOT NULL,
  old_row jsonb NOT NULL,
  new_row jsonb NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_registry_history_seat_changed_at_idx
  ON public.model_registry_history (seat, changed_at DESC);

ALTER TABLE public.model_registry_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.model_registry_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.model_registry_history TO authenticated;
GRANT ALL ON public.model_registry_history TO service_role;

DROP POLICY IF EXISTS "Admins read model registry history" ON public.model_registry_history;
CREATE POLICY "Admins read model registry history" ON public.model_registry_history
  FOR SELECT TO authenticated USING (private.is_admin(auth.uid()));
-- No INSERT/UPDATE/DELETE policies: only the SECURITY DEFINER trigger writes.

CREATE OR REPLACE FUNCTION public.log_model_registry_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    INSERT INTO public.model_registry_history (seat, old_row, new_row, changed_by)
    VALUES (NEW.seat, to_jsonb(OLD), to_jsonb(NEW), auth.uid());
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.log_model_registry_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS model_registry_history_trg ON public.model_registry;
CREATE TRIGGER model_registry_history_trg
  AFTER UPDATE ON public.model_registry
  FOR EACH ROW EXECUTE FUNCTION public.log_model_registry_change();
