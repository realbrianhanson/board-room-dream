
-- ============ Security fix on profiles ============
CREATE OR REPLACE FUNCTION public.profiles_guard_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Not allowed to change role';
    END IF;
    IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id AND NOT public.is_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Cohort must be set via join_cohort()';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_privileged_fields ON public.profiles;
CREATE TRIGGER profiles_guard_privileged_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_privileged_fields();

-- join_cohort RPC (bypasses the trigger via SECURITY DEFINER + local session flag not needed
-- because the trigger only checks user-driven changes; we set cohort_id here as definer so
-- auth.uid() is still the caller — so we need a bypass). Use a session-local GUC guard.
CREATE OR REPLACE FUNCTION public.join_cohort(code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cohort_id uuid;
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT id INTO _cohort_id FROM public.cohorts WHERE join_code = code;
  IF _cohort_id IS NULL THEN
    RAISE EXCEPTION 'Invalid cohort code';
  END IF;
  -- Direct UPDATE will hit the guard trigger; do it as a superuser-privileged
  -- statement by disabling the trigger scope through a settings guard.
  PERFORM set_config('boardroom.allow_cohort_change', 'on', true);
  UPDATE public.profiles SET cohort_id = _cohort_id WHERE id = _uid;
  RETURN _cohort_id;
END;
$$;

REVOKE ALL ON FUNCTION public.join_cohort(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_cohort(text) TO authenticated;

-- Update the guard to honor the RPC bypass flag
CREATE OR REPLACE FUNCTION public.profiles_guard_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bypass text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    _bypass := current_setting('boardroom.allow_cohort_change', true);
    IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Not allowed to change role';
    END IF;
    IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
       AND NOT public.is_admin(auth.uid())
       AND COALESCE(_bypass, '') <> 'on' THEN
      RAISE EXCEPTION 'Cohort must be set via join_cohort()';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ============ api_keys ============
CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openrouter','github')),
  encrypted_key text NOT NULL,
  last4 text,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','valid','invalid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- Service role only; NO grants to anon/authenticated.
GRANT ALL ON public.api_keys TO service_role;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies for authenticated/anon.

-- ============ model_registry ============
CREATE TABLE public.model_registry (
  seat text PRIMARY KEY CHECK (seat IN ('chair','strategist','contrarian','inspector')),
  model_id text NOT NULL,
  display_name text,
  role_prompt text,
  enabled boolean NOT NULL DEFAULT true,
  use_latest_alias boolean NOT NULL DEFAULT false,
  max_cost_per_run numeric NOT NULL DEFAULT 5.00,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.model_registry TO authenticated;
GRANT ALL ON public.model_registry TO service_role;
ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read model registry" ON public.model_registry
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins insert model registry" ON public.model_registry
  FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Admins update model registry" ON public.model_registry
  FOR UPDATE TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Admins delete model registry" ON public.model_registry
  FOR DELETE TO authenticated USING (public.is_admin(auth.uid()));

INSERT INTO public.model_registry (seat, model_id, display_name, role_prompt) VALUES
  ('chair', 'anthropic/claude-fable-5', 'The Chair · Architect',
    'You are the Chair. Synthesize the arguments of the other seats into a coherent decision and rule on the final plan. Keep the board moving toward a locked, unambiguous outcome.'),
  ('strategist', 'openai/gpt-5.5', 'The Strategist',
    'You are the Strategist. Argue the market opportunity, user experience, positioning, and monetization for the proposed idea. Push for choices that maximize traction and long-term value.'),
  ('contrarian', 'x-ai/grok-4.5', 'The Contrarian',
    'You are the Contrarian. Attack the plan on feasibility, scope, and security — surface the risks, unknowns, and shortcuts nobody wants to name. Assume something will break and say what.'),
  ('inspector', 'moonshotai/kimi-k3', 'The Inspector',
    'You are the Inspector. Check the plan and produced artifacts for coherence, completeness, and internal consistency. Flag anything vague, contradictory, or missing before consensus locks.');

-- ============ app_settings ============
CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read app settings" ON public.app_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins insert app settings" ON public.app_settings
  FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Admins update app settings" ON public.app_settings
  FOR UPDATE TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Admins delete app settings" ON public.app_settings
  FOR DELETE TO authenticated USING (public.is_admin(auth.uid()));

INSERT INTO public.app_settings (key, value) VALUES
  ('constitution', '{"text": "Constitution v1 placeholder — the governing rules injected into every board call."}'::jsonb);
