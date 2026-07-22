-- Integration verification for requeue_step_if_parent_active.
-- Run with: psql -v ON_ERROR_STOP=1 -f supabase/tests/requeue_step_if_parent_active.sql
-- Rolls back at the end; no persistent state.
BEGIN;

-- Active parent: step should be requeued with new error + merged request.
INSERT INTO boardroom_runs (id, project_id, user_id, kind, status)
VALUES ('22222222-2222-2222-2222-222222222222',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'running');
INSERT INTO run_steps (id, run_id, user_id, step_key, round, seat, status, started_at, request)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '22222222-2222-2222-2222-222222222222',
        (SELECT user_id FROM projects LIMIT 1),
        'k1', 1, 'chair', 'running', now(),
        jsonb_build_object('force_fallback', false));

SELECT 'active_parent_returns_requeued' AS label,
       requeue_step_if_parent_active(
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         '{"force_fallback": true, "_timeout_attempts": 1}'::jsonb,
         'timeout_failover'
       ) AS result;
SELECT 'active_parent_step_state' AS label, status, error, started_at IS NULL AS started_cleared,
       (request->>'force_fallback')::text AS force_fallback
  FROM run_steps WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Terminal parent: step should be cancelled_parent_terminal, not resurrected.
INSERT INTO boardroom_runs (id, project_id, user_id, kind, status)
VALUES ('33333333-3333-3333-3333-333333333333',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'failed');
INSERT INTO run_steps (id, run_id, user_id, step_key, round, seat, status, started_at)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        '33333333-3333-3333-3333-333333333333',
        (SELECT user_id FROM projects LIMIT 1),
        'k2', 1, 'chair', 'running', now());

SELECT 'terminal_parent_returns_cancelled' AS label,
       requeue_step_if_parent_active(
         'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
         '{}'::jsonb,
         'timeout_failover'
       ) AS result;
SELECT 'terminal_parent_step_state' AS label, status, error
  FROM run_steps WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

-- Missing step: not_found.
SELECT 'missing_step_returns_not_found' AS label,
       requeue_step_if_parent_active(
         '99999999-9999-9999-9999-999999999999',
         '{}'::jsonb, 'x'
       ) AS result;

-- Permission checks: only service_role may execute.
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM requeue_step_if_parent_active(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}'::jsonb, 'x');
    RAISE EXCEPTION 'FAIL: authenticated permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: authenticated denied'; END;
END $$;
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM requeue_step_if_parent_active(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}'::jsonb, 'x');
    RAISE EXCEPTION 'FAIL: anon permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon denied'; END;
END $$;

ROLLBACK;
