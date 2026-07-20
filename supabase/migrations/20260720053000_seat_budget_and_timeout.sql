-- Per-seat spend cap is now enforced in the proxy (openrouter-proxy.ts).
-- Give the Chair double the others' allowance since it legitimately does the
-- most work (synthesis, ruling, blueprint), all at high reasoning. These are
-- runtime-editable in Settings -> Admin - Model registry; this migration just
-- sets the source-of-truth defaults.
UPDATE public.model_registry SET max_cost_per_run = 10.00 WHERE seat = 'chair';
UPDATE public.model_registry SET max_cost_per_run = 5.00 WHERE seat <> 'chair';
