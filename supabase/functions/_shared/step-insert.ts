// deno-lint-ignore-file no-explicit-any
// run_steps insert result check. Every seeding path used to fire-and-forget
// `admin.from("run_steps").insert(rows)` without reading `.error`, so a
// rejected insert (RLS, size, a dropped column) left the parent run queued
// with zero steps and the cron marked it failed a second later (RC-5).
//
// A unique violation (Postgres 23505) is tolerated: it means the same step
// rows already exist — an overlapping tick or a resumed seed — and the run
// can proceed on what is there.

export const UNIQUE_VIOLATION = "23505";

export function isTolerableInsertError(error: any): boolean {
  return !!error && String(error.code ?? "") === UNIQUE_VIOLATION;
}

// Pure. Returns the result unchanged when it carries no error (or only a
// unique violation); throws otherwise so the caller's failure path runs
// instead of silently continuing with an unseeded run.
export function assertStepInsertOk<T extends { error?: any } | null | undefined>(res: T, label = "run_steps insert"): T {
  const err = res?.error;
  if (err && !isTolerableInsertError(err)) {
    throw new Error(`${label} failed: ${err.message ?? String(err)}`);
  }
  return res;
}
