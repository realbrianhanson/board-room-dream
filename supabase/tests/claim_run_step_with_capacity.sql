-- Integration verification for claim_run_step_with_capacity.
-- Run with: psql -v ON_ERROR_STOP=1 -f supabase/tests/claim_run_step_with_capacity.sql
-- Rolls back at the end; no persistent state.
BEGIN;
INSERT INTO boardroom_runs (id, project_id, user_id, kind, status)
VALUES ('11111111-1111-1111-1111-111111111111',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'completed');
INSERT INTO run_steps (run_id, user_id, step_key, round, seat, status, created_at)
SELECT '11111111-1111-1111-1111-111111111111',
       (SELECT user_id FROM projects LIMIT 1),
       'k'||g, 1, 'chair', 'queued',
       now() + (g || ' ms')::interval
FROM generate_series(1,6) g;

-- Cap = 3: first three claims succeed, fourth returns no row.
SELECT 'claim1' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 3);
SELECT 'claim2' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 3);
SELECT 'claim3' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 3);
SELECT 'claim4_over_cap_returns_zero' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 3);
SELECT 'running_capped_at_3' AS label, count(*) FROM run_steps
 WHERE run_id='11111111-1111-1111-1111-111111111111' AND status='running';

-- Freeing a slot (or raising capacity) resumes claiming.
SELECT 'claim5_freed_slot' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 4);

-- Capacity clamp: 0 -> 1, 999 -> 8 (both still gated by current running count).
SELECT 'clamp_zero_treated_as_1' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 0);
SELECT 'clamp_high_treated_as_8' AS label, count(*) FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 999);

-- Callers outside service_role must be rejected.
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM * FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 3);
    RAISE EXCEPTION 'FAIL: authenticated permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: authenticated denied'; END;
END $$;
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM claim_run_step_with_capacity('11111111-1111-1111-1111-111111111111', 3);
    RAISE EXCEPTION 'FAIL: anon permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon denied'; END;
END $$;
ROLLBACK;
