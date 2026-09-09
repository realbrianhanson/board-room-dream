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

-- Paused parent: recoverable, step should be requeued.
INSERT INTO boardroom_runs (id, project_id, user_id, kind, status)
VALUES ('44444444-4444-4444-4444-444444444444',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'paused');
INSERT INTO run_steps (id, run_id, user_id, step_key, round, seat, status, started_at)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
        '44444444-4444-4444-4444-444444444444',
        (SELECT user_id FROM projects LIMIT 1),
        'k3', 1, 'chair', 'running', now());
SELECT 'paused_parent_returns_requeued' AS label,
       requeue_step_if_parent_active(
         'cccccccc-cccc-cccc-cccc-cccccccccccc', '{}'::jsonb, 'requeued_paused'
       ) AS result;
SELECT 'paused_parent_step_state' AS label, status FROM run_steps
  WHERE id='cccccccc-cccc-cccc-cccc-cccccccccccc';

-- No-op transition: calling requeue on a step whose parent is terminal AND
-- the step is already 'failed' should still return cancelled_parent_terminal
-- (parent status is authoritative) and MUST NOT flip the step back to queued.
UPDATE run_steps SET status='failed', error='cancelled_parent_terminal'
  WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'terminal_parent_no_op_return' AS label,
       requeue_step_if_parent_active(
         'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}'::jsonb, 'x'
       ) AS result;
SELECT 'terminal_parent_no_op_state' AS label, status
  FROM run_steps WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

-- Batch 17: ownership token (p_expect_call_id, DEFAULT NULL).
-- The 3-arg form above still works via the default. With a token, the
-- requeue only flips the row when executor_call_id matches; a stale token
-- returns 'stale_call' and writes nothing. A successful requeue NULLs the
-- executor columns.
INSERT INTO boardroom_runs (id, project_id, user_id, kind, status)
VALUES ('55555555-5555-5555-5555-555555555555',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'running');
INSERT INTO run_steps (id, run_id, user_id, step_key, round, seat, status, started_at, request,
                       executor_call_id, executor_dispatch_no, executor_dispatched_at, executor_meta)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd',
        '55555555-5555-5555-5555-555555555555',
        (SELECT user_id FROM projects LIMIT 1),
        'k4', 1, 'chair', 'running', now(), '{}'::jsonb,
        'dddddddd-dddd-dddd-dddd-dddddddddddd-1', 1, now(), '{"call_id": "dddddddd-dddd-dddd-dddd-dddddddddddd-1"}'::jsonb);

SELECT 'stale_token_returns_stale_call' AS label,
       requeue_step_if_parent_active(
         'dddddddd-dddd-dddd-dddd-dddddddddddd', '{}'::jsonb, 'executor_call_lost',
         'dddddddd-dddd-dddd-dddd-dddddddddddd-99'
       ) AS result;
SELECT 'stale_token_wrote_nothing' AS label, status, error, executor_call_id, executor_meta IS NOT NULL AS meta_kept
  FROM run_steps WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';

SELECT 'matching_token_returns_requeued' AS label,
       requeue_step_if_parent_active(
         'dddddddd-dddd-dddd-dddd-dddddddddddd', '{"_executor_errors": 1}'::jsonb, 'executor_call_lost',
         'dddddddd-dddd-dddd-dddd-dddddddddddd-1'
       ) AS result;
SELECT 'matching_token_cleared_executor_columns' AS label, status, error,
       executor_call_id IS NULL AS call_id_null,
       executor_dispatched_at IS NULL AS dispatched_at_null,
       executor_meta IS NULL AS meta_null,
       executor_dispatch_no,
       (request->>'_executor_errors')::int AS executor_errors
  FROM run_steps WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';

-- A token on a row that was never dispatched (executor_call_id NULL) is stale too.
UPDATE run_steps SET status='running', started_at=now()
  WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';
SELECT 'token_on_undispatched_row_is_stale' AS label,
       requeue_step_if_parent_active(
         'dddddddd-dddd-dddd-dddd-dddddddddddd', '{}'::jsonb, 'x',
         'dddddddd-dddd-dddd-dddd-dddddddddddd-1'
       ) AS result;
SELECT 'token_on_undispatched_row_state' AS label, status
  FROM run_steps WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';

-- The 3-arg call (no token) still requeues and also clears the columns.
UPDATE run_steps SET executor_call_id='dddddddd-dddd-dddd-dddd-dddddddddddd-2', executor_dispatched_at=now(),
                     executor_meta='{}'::jsonb
  WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';
SELECT 'three_arg_call_still_requeues' AS label,
       requeue_step_if_parent_active(
         'dddddddd-dddd-dddd-dddd-dddddddddddd', '{}'::jsonb, 'requeued_stale'
       ) AS result;
SELECT 'three_arg_call_cleared_columns' AS label, status,
       executor_call_id IS NULL AS call_id_null, executor_meta IS NULL AS meta_null
  FROM run_steps WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';

-- Terminal parent keeps the executor columns on the failed row (the collector
-- still ledgers the in-flight call, then clears them).
UPDATE boardroom_runs SET status='failed' WHERE id='55555555-5555-5555-5555-555555555555';
UPDATE run_steps SET status='running', started_at=now(),
                     executor_call_id='dddddddd-dddd-dddd-dddd-dddddddddddd-3', executor_dispatched_at=now()
  WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';
SELECT 'terminal_parent_with_token' AS label,
       requeue_step_if_parent_active(
         'dddddddd-dddd-dddd-dddd-dddddddddddd', '{}'::jsonb, 'x',
         'dddddddd-dddd-dddd-dddd-dddddddddddd-3'
       ) AS result;
SELECT 'terminal_parent_keeps_executor_columns' AS label, status, error, executor_call_id
  FROM run_steps WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';

-- Only the 4-arg signature exists (no ambiguous overload).
SELECT 'single_signature' AS label, count(*) AS overloads
  FROM pg_proc WHERE proname = 'requeue_step_if_parent_active'
   AND pronamespace = 'public'::regnamespace;

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
