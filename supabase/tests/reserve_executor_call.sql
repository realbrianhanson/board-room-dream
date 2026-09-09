-- Integration verification for reserve_executor_call (Batch 17).
-- Run with: psql -v ON_ERROR_STOP=1 -f supabase/tests/reserve_executor_call.sql
-- Rolls back at the end; no persistent state.
BEGIN;

INSERT INTO boardroom_runs (id, project_id, user_id, kind, status)
VALUES ('66666666-6666-6666-6666-666666666666',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'running');
INSERT INTO run_steps (id, run_id, user_id, step_key, round, seat, status, started_at, request)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        '66666666-6666-6666-6666-666666666666',
        (SELECT user_id FROM projects LIMIT 1),
        'k1', 1, 'chair', 'running', now(), '{}'::jsonb);

-- First reserve on a claimed, undispatched row returns <id>-1.
SELECT 'first_reserve_is_id_dash_1' AS label,
       reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee-1' AS ok;
SELECT 'first_reserve_state' AS label, executor_call_id, executor_dispatch_no,
       executor_dispatched_at IS NOT NULL AS dispatched_at_set, executor_meta IS NULL AS meta_null
  FROM run_steps WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

-- Second reserve on the same in-flight row is refused (CAS on executor_call_id IS NULL).
SELECT 'second_reserve_is_null' AS label,
       reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') IS NULL AS ok;
SELECT 'second_reserve_left_state_alone' AS label, executor_call_id, executor_dispatch_no
  FROM run_steps WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

-- The requeue RPC clears the executor columns (requeued row is re-claimable and re-dispatchable).
SELECT 'requeue_with_matching_token' AS label,
       requeue_step_if_parent_active(
         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{}'::jsonb, 'timeout_failover',
         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee-1') AS result;
SELECT 'requeue_cleared_executor_columns' AS label, status,
       executor_call_id IS NULL AS call_id_null,
       executor_dispatched_at IS NULL AS dispatched_at_null,
       executor_meta IS NULL AS meta_null,
       executor_dispatch_no
  FROM run_steps WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

-- A queued row is not reservable (only status='running').
SELECT 'queued_row_not_reservable' AS label,
       reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') IS NULL AS ok;

-- Re-claim via the claim RPC (also clears executor columns), then the next reserve is -2.
SELECT 'reclaim_via_claim_rpc' AS label, count(*)
  FROM claim_run_step_with_capacity('66666666-6666-6666-6666-666666666666', 3);
SELECT 'reclaim_cleared_executor_columns' AS label, status,
       executor_call_id IS NULL AS call_id_null,
       executor_dispatched_at IS NULL AS dispatched_at_null,
       executor_meta IS NULL AS meta_null
  FROM run_steps WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
SELECT 'next_reserve_is_id_dash_2' AS label,
       reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee-2' AS ok;
SELECT 'dispatch_no_is_2' AS label, executor_dispatch_no
  FROM run_steps WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

-- The claim RPC wipes a stale call id even if one was left on a queued row.
UPDATE run_steps
   SET status = 'queued', started_at = NULL,
       executor_meta = '{"stale": true}'::jsonb
 WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
SELECT 'claim_wipes_stale_call_id' AS label, executor_call_id IS NULL AS call_id_null, executor_meta IS NULL AS meta_null
  FROM claim_run_step_with_capacity('66666666-6666-6666-6666-666666666666', 3);

-- Non-running rows: completed / failed / missing all return NULL.
UPDATE run_steps SET status = 'completed', executor_call_id = NULL
 WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
SELECT 'completed_row_not_reservable' AS label,
       reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') IS NULL AS ok;
SELECT 'missing_row_not_reservable' AS label,
       reserve_executor_call('99999999-9999-9999-9999-999999999999') IS NULL AS ok;

-- Permission checks: only service_role may execute.
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    RAISE EXCEPTION 'FAIL: authenticated permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: authenticated denied'; END;
END $$;
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM reserve_executor_call('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    RAISE EXCEPTION 'FAIL: anon permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon denied'; END;
END $$;

ROLLBACK;
