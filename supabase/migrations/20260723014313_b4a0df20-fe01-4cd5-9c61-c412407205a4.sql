-- Server-enforced batch state transitions (PROMPT-CONTRACT-AND-STATE-R4, item 4).
-- The browser previously wrote batches.status directly for sent/built/passed/
-- failed/skipped. That let the client claim "passed" without any supported
-- verification, silently bypass sequential dependencies, and race with the
-- audit pipeline. This RPC is the single owner-authenticated boundary for
-- consequential Runway transitions.
--
-- Guarantees:
--   * SECURITY DEFINER + explicit search_path — no client can shadow public.
--   * auth.uid() must own the batch's project (RLS-equivalent check inside).
--   * Whitelisted transitions per current status; anything else is rejected.
--   * "passed" is NOT reachable from the client — passed is set only by the
--     audit/verification path. Manual completion uses 'built' instead.
--   * Sequential dependency: 'sent' requires every earlier batch to be
--     terminal (passed/skipped/built).
--   * Skip-suffix is applied atomically inside the RPC (the R3 rule that a
--     skipped batch also skips every later unbuilt batch).
--   * Compare-and-set: concurrent/stale transitions raise 'race_stale'.
--   * outcome_md may only be written alongside built/failed and never
--     forges status.
--   * When the batch reaches a terminal state and every batch in the
--     project is terminal (passed/skipped/built) with the last one 'built'
--     or 'passed', current_batch_no advances to the next non-terminal
--     batch's number, or the project moves to 'auditing' if none remains.
--     These project-column updates run under SECURITY DEFINER so the
--     projects_guard_privileged_fields trigger does not block them.

create or replace function public.set_batch_status(
  p_batch_id uuid,
  p_next    text,
  p_outcome text default null
) returns table (batch_id uuid, next_status text, updated_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_batch  public.batches%rowtype;
  v_proj   public.projects%rowtype;
  v_allowed_from text[];
  v_ids    uuid[];
  v_prev_unfinished int;
  v_next_no int;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_next not in ('sent','built','failed','skipped') then
    raise exception 'illegal_transition: % cannot be set by client', p_next using errcode = '22023';
  end if;

  select * into v_batch from public.batches where id = p_batch_id for update;
  if not found then raise exception 'batch_not_found' using errcode = 'P0002'; end if;

  select * into v_proj from public.projects where id = v_batch.project_id;
  if v_proj.user_id is distinct from v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_allowed_from := case p_next
    when 'sent'    then array['pending','fix_needed']
    when 'built'   then array['sent']
    when 'failed'  then array['sent','built']
    when 'skipped' then array['pending','fix_needed','sent','built','failed']
  end;
  if not (v_batch.status = any(v_allowed_from)) then
    raise exception 'illegal_transition: % -> % (current=%)', v_batch.status, p_next, v_batch.status using errcode = '22023';
  end if;

  if p_next = 'sent' then
    select count(*) into v_prev_unfinished
      from public.batches
     where project_id = v_batch.project_id
       and batch_no < v_batch.batch_no
       and status not in ('passed','skipped','built');
    if v_prev_unfinished > 0 then
      raise exception 'dependency_unmet: earlier batches are not complete' using errcode = '22023';
    end if;
  end if;

  if p_next = 'skipped' then
    with suffix as (
      select id from public.batches
       where project_id = v_batch.project_id
         and batch_no >= v_batch.batch_no
         and status in ('pending','fix_needed','sent','built','failed')
    )
    update public.batches set status = 'skipped'
     where id in (select id from suffix)
     returning id
     into v_ids;
    if v_ids is null then v_ids := array[]::uuid[]; end if;
  else
    -- Compare-and-set the exact prior status; if concurrent update moved
    -- the row, fail with race_stale and let the caller retry.
    update public.batches
       set status     = p_next,
           sent_at    = case when p_next = 'sent'  then now() else sent_at end,
           built_at   = case when p_next = 'built' then now() else built_at end,
           outcome_md = case
             when p_outcome is not null and p_next in ('built','failed') then p_outcome
             else outcome_md
           end
     where id = v_batch.id and status = v_batch.status
     returning id into v_ids;
    if v_ids is null then
      raise exception 'race_stale' using errcode = '40001';
    else
      v_ids := array[v_batch.id];
    end if;
  end if;

  -- Advance current_batch_no when this transition made the next non-terminal
  -- batch the new pointer, or move the project to 'auditing' when nothing
  -- non-terminal remains. Never demote current_batch_no.
  select min(batch_no) into v_next_no
    from public.batches
   where project_id = v_batch.project_id
     and status not in ('passed','skipped','built');

  if v_next_no is not null and v_next_no > coalesce(v_proj.current_batch_no, 0) then
    update public.projects
       set current_batch_no = v_next_no
     where id = v_batch.project_id;
  elsif v_next_no is null and v_proj.status = 'building' then
    update public.projects
       set status = 'auditing'
     where id = v_batch.project_id;
  end if;

  return query select v_batch.id, p_next, v_ids;
end;
$$;

revoke all on function public.set_batch_status(uuid, text, text) from public;
revoke all on function public.set_batch_status(uuid, text, text) from anon;
grant execute on function public.set_batch_status(uuid, text, text) to authenticated;