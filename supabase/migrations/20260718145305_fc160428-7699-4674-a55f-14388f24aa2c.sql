
-- Profiles table
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','instructor','admin')),
  cohort_id uuid NULL,
  display_name text,
  onboarded_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Cohorts table
CREATE TABLE public.cohorts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  join_code text UNIQUE NOT NULL,
  starts_at date,
  instructor_id uuid
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cohorts TO authenticated;
GRANT ALL ON public.cohorts TO service_role;
ALTER TABLE public.cohorts ENABLE ROW LEVEL SECURITY;

-- Security-definer helpers (avoid RLS recursion)
CREATE OR REPLACE FUNCTION public.is_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _uid AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION public.instructs_cohort(_uid uuid, _cohort uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.cohorts
    WHERE id = _cohort AND instructor_id = _uid
  );
$$;

CREATE OR REPLACE FUNCTION public.user_cohort(_uid uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cohort_id FROM public.profiles WHERE id = _uid;
$$;

-- Profiles policies
CREATE POLICY "Users read own profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Instructors read cohort profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    cohort_id IS NOT NULL
    AND (public.instructs_cohort(auth.uid(), cohort_id) OR public.is_admin(auth.uid()))
  );

-- Cohorts policies
CREATE POLICY "Members read own cohort" ON public.cohorts
  FOR SELECT TO authenticated
  USING (id = public.user_cohort(auth.uid()));

CREATE POLICY "Instructors read their cohorts" ON public.cohorts
  FOR SELECT TO authenticated
  USING (instructor_id = auth.uid() OR public.is_admin(auth.uid()));

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Seed cohort
INSERT INTO public.cohorts (name, join_code) VALUES ('Founders Cohort 1', 'PUSHTEN1');
