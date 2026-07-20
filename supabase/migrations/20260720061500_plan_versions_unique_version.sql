-- Defense-in-depth against the concurrency double-lock that produced duplicate
-- (and empty) plan_versions rows. The orchestrator now claims the lock
-- transition atomically (compare-and-swap on boardroom_runs.round_no) so only
-- one tick inserts, but a DB-level guarantee is cheap and makes a duplicate
-- version *impossible* even if a future code path forgets the claim: two
-- concurrent inserts computing the same max+1 version collide here and one
-- fails loudly instead of silently duplicating the deliverable.
CREATE UNIQUE INDEX IF NOT EXISTS plan_versions_project_kind_version_uidx
  ON public.plan_versions (project_id, kind, version);
