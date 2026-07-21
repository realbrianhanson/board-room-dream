ALTER TABLE public.model_registry DROP CONSTRAINT model_registry_seat_check;
ALTER TABLE public.model_registry ADD CONSTRAINT model_registry_seat_check
  CHECK (seat = ANY (ARRAY['chair'::text,'strategist'::text,'contrarian'::text,'inspector'::text,'reserve'::text]));
INSERT INTO public.model_registry (seat, model_id, display_name, enabled, fallback_model_id, max_cost_per_run)
  VALUES ('reserve', 'google/gemini-3.1-pro-preview', 'The Reserve · Gemini 3 Pro', true, NULL, 5.00)
  ON CONFLICT (seat) DO UPDATE SET model_id = EXCLUDED.model_id, display_name = EXCLUDED.display_name, enabled = true;
UPDATE public.model_registry SET fallback_model_id = 'google/gemini-3.1-pro-preview' WHERE seat IN ('chair','strategist','contrarian','inspector');