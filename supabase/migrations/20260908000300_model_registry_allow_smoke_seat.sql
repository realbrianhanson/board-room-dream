-- Smoke mode (RC-9, Batch 1) serves every seat of a smoke run from an ENABLED
-- "smoke" registry row and only falls back to the inspector's model when no
-- such row exists. The seat CHECK still stopped at 'reserve', so the smoke
-- row could not be inserted at all and every smoke run would have ridden the
-- inspector's (premium) model. Widen the CHECK; no row is seeded here — the
-- model id is the founder's decision (Batch 0.5). Idempotent.
ALTER TABLE public.model_registry DROP CONSTRAINT IF EXISTS model_registry_seat_check;
ALTER TABLE public.model_registry ADD CONSTRAINT model_registry_seat_check
  CHECK (seat = ANY (ARRAY['chair'::text, 'strategist'::text, 'contrarian'::text, 'inspector'::text, 'reserve'::text, 'smoke'::text]));
