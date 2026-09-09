-- Integration verification for record_model_call_idempotent (Batch 17).
-- Run with: psql -v ON_ERROR_STOP=1 -f supabase/tests/record_model_call_idempotent.sql
-- Rolls back at the end; no persistent state.
BEGIN;

INSERT INTO boardroom_runs (id, project_id, user_id, kind, status, budget_usd, spent_usd)
VALUES ('55555555-5555-5555-5555-555555555555',
        (SELECT id FROM projects LIMIT 1),
        (SELECT user_id FROM projects LIMIT 1),
        'test', 'running', 10.0, 0);

-- Same key twice: one ledger row, spent_usd bumped exactly once, second call
-- returns the unchanged total.
SELECT 'first_insert_returns_new_total' AS label,
       record_model_call_idempotent(
         (SELECT user_id FROM projects LIMIT 1),
         (SELECT id FROM projects LIMIT 1),
         '55555555-5555-5555-5555-555555555555',
         'chair', 'anthropic/claude-haiku-4.5', 100, 50, 0.25,
         'dddddddd-dddd-dddd-dddd-dddddddddddd-1'
       ) AS result;
SELECT 'duplicate_returns_same_total' AS label,
       record_model_call_idempotent(
         (SELECT user_id FROM projects LIMIT 1),
         (SELECT id FROM projects LIMIT 1),
         '55555555-5555-5555-5555-555555555555',
         'chair', 'anthropic/claude-haiku-4.5', 100, 50, 0.25,
         'dddddddd-dddd-dddd-dddd-dddddddddddd-1'
       ) AS result;
SELECT 'one_row_per_call_id' AS label, count(*) AS rows
  FROM cost_ledger WHERE call_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd-1';
SELECT 'spent_bumped_once' AS label, spent_usd
  FROM boardroom_runs WHERE id = '55555555-5555-5555-5555-555555555555';

-- Distinct keys: two rows, spent_usd sums both.
SELECT 'timeout_estimate_row_is_distinct' AS label,
       record_model_call_idempotent(
         (SELECT user_id FROM projects LIMIT 1),
         (SELECT id FROM projects LIMIT 1),
         '55555555-5555-5555-5555-555555555555',
         'chair:timeout', 'anthropic/claude-haiku-4.5', 100, 50, 0.10,
         'dddddddd-dddd-dddd-dddd-dddddddddddd-1:timeout'
       ) AS result;
SELECT 'two_rows_for_two_keys' AS label, count(*) AS rows
  FROM cost_ledger WHERE call_id LIKE 'dddddddd-dddd-dddd-dddd-dddddddddddd-1%';
SELECT 'spent_sums_distinct_keys' AS label, spent_usd
  FROM boardroom_runs WHERE id = '55555555-5555-5555-5555-555555555555';

-- NULL / empty key raises (the inline path uses record_model_call_atomic instead).
DO $$ BEGIN
  BEGIN
    PERFORM record_model_call_idempotent(
      (SELECT user_id FROM projects LIMIT 1), NULL,
      '55555555-5555-5555-5555-555555555555',
      'chair', 'm', 1, 1, 0.01, NULL);
    RAISE EXCEPTION 'FAIL: NULL call_id accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%p_call_id is required%' THEN RAISE NOTICE 'PASS: NULL call_id rejected';
    ELSE RAISE; END IF;
  END;
END $$;
DO $$ BEGIN
  BEGIN
    PERFORM record_model_call_idempotent(
      (SELECT user_id FROM projects LIMIT 1), NULL,
      '55555555-5555-5555-5555-555555555555',
      'chair', 'm', 1, 1, 0.01, '');
    RAISE EXCEPTION 'FAIL: empty call_id accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%p_call_id is required%' THEN RAISE NOTICE 'PASS: empty call_id rejected';
    ELSE RAISE; END IF;
  END;
END $$;

-- Inline rows (record_model_call_atomic) keep call_id NULL and are never
-- blocked by the partial unique index.
SELECT 'atomic_still_inserts' AS label,
       record_model_call_atomic(
         (SELECT user_id FROM projects LIMIT 1),
         (SELECT id FROM projects LIMIT 1),
         '55555555-5555-5555-5555-555555555555',
         'chair', 'm', 1, 1, 0.01) AS result;
SELECT 'atomic_still_inserts_again' AS label,
       record_model_call_atomic(
         (SELECT user_id FROM projects LIMIT 1),
         (SELECT id FROM projects LIMIT 1),
         '55555555-5555-5555-5555-555555555555',
         'chair', 'm', 1, 1, 0.01) AS result;
SELECT 'inline_rows_have_null_call_id' AS label, count(*) AS rows
  FROM cost_ledger WHERE run_id = '55555555-5555-5555-5555-555555555555' AND call_id IS NULL;

-- Permission checks: only service_role may execute.
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM record_model_call_idempotent(
      (SELECT user_id FROM projects LIMIT 1), NULL, NULL, 'chair', 'm', 1, 1, 0.01, 'x-1');
    RAISE EXCEPTION 'FAIL: authenticated permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: authenticated denied'; END;
END $$;
DO $$ BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM record_model_call_idempotent(
      (SELECT user_id FROM projects LIMIT 1), NULL, NULL, 'chair', 'm', 1, 1, 0.01, 'x-1');
    RAISE EXCEPTION 'FAIL: anon permitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon denied'; END;
END $$;

ROLLBACK;
