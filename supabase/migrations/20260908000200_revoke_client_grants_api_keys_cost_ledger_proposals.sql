-- SEC-3: make "no grants to anon/authenticated" true for the tables that hold
-- encrypted provider keys and the spend ledger. api_keys was created with RLS
-- and no policies but carried the schema's default grants; cost_ledger and
-- field_manual_proposals had broader client grants than the app ever uses
-- (clients only read the ledger; proposals are admin-read/update only).
-- Applied live by hand on 2026-09-07 (Batch 0.7); committed here so a home
-- deploy matches. REVOKE is idempotent by nature.
REVOKE ALL ON public.api_keys FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.cost_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.cost_ledger FROM authenticated;

REVOKE ALL ON public.field_manual_proposals FROM anon;

-- Expected afterwards: has_table_privilege('authenticated', 'public.api_keys', 'SELECT') = false.
