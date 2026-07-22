-- F1b: service-role-only inventory of public schema for the JIT batch compiler.
-- Returns { generated_at, tables: [{name, columns:[{name,type,nullable,default}]}], routines: [{name, args, result}] }.
CREATE OR REPLACE FUNCTION public.get_compiler_schema_inventory()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'tables', COALESCE((
      SELECT jsonb_agg(t ORDER BY t->>'name')
      FROM (
        SELECT jsonb_build_object(
          'name', c.table_name,
          'columns', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'name', col.column_name,
              'type', col.data_type,
              'nullable', (col.is_nullable = 'YES'),
              'default', col.column_default
            ) ORDER BY col.ordinal_position)
            FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.table_name
          ), '[]'::jsonb)
        ) AS t
        FROM information_schema.tables c
        WHERE c.table_schema = 'public' AND c.table_type = 'BASE TABLE'
      ) s
    ), '[]'::jsonb),
    'routines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', p.proname,
        'args', pg_catalog.pg_get_function_identity_arguments(p.oid),
        'result', pg_catalog.pg_get_function_result(p.oid)
      ) ORDER BY p.proname)
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_compiler_schema_inventory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_compiler_schema_inventory() FROM anon;
REVOKE ALL ON FUNCTION public.get_compiler_schema_inventory() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_compiler_schema_inventory() TO service_role;

COMMENT ON FUNCTION public.get_compiler_schema_inventory() IS
  'F1b: batch-compiler service-role-only snapshot of public tables + functions. Do not expose to anon/authenticated.';