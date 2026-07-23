-- Additive role-authority follow-up. The previous migration created
-- user_roles/app_role/has_role but did not (a) back-map the historic
-- 'student' profile role into the 'user' app_role, (b) auto-sync new or
-- changed profiles into exactly one user_roles row, or (c) scope has_role
-- so an authenticated caller cannot probe other users. This migration is
-- purely additive on top of that one.

-- 1) Backfill any profiles missing a user_roles row (idempotent). The
-- existing constraint keeps profiles.role in {student, instructor, admin};
-- the app_role enum uses {admin, instructor, user}, so student -> user.
insert into public.user_roles (user_id, role)
select p.id,
       case p.role
         when 'admin' then 'admin'::public.app_role
         when 'instructor' then 'instructor'::public.app_role
         else 'user'::public.app_role
       end
  from public.profiles p
  left join public.user_roles ur on ur.user_id = p.id
 where ur.user_id is null
on conflict (user_id, role) do nothing;

-- 2) Automatic sync: on profile insert/update the corresponding
-- user_roles row is REPLACED (not accumulated). profiles.role is a
-- synchronized display mirror; user_roles is the authorization source.
create or replace function public.sync_user_role_from_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _role public.app_role;
begin
  _role := case new.role
    when 'admin' then 'admin'::public.app_role
    when 'instructor' then 'instructor'::public.app_role
    else 'user'::public.app_role
  end;
  -- Remove any prior role rows that differ from the new one. This is the
  -- "replace, don't accumulate" contract — a profile that flips
  -- admin -> instructor must not retain the admin authority.
  delete from public.user_roles
    where user_id = new.id and role <> _role;
  insert into public.user_roles (user_id, role)
    values (new.id, _role)
    on conflict (user_id, role) do nothing;
  return new;
end;
$fn$;

drop trigger if exists profiles_sync_user_role on public.profiles;
create trigger profiles_sync_user_role
  after insert or update of role on public.profiles
  for each row execute function public.sync_user_role_from_profile();

-- 3) Lock user_roles down to server-only writes. RLS already blocks
-- writes (no INSERT/UPDATE/DELETE policy exists), but revoke the grants
-- explicitly so a future policy addition can't accidentally open a
-- client-writable path.
revoke insert, update, delete on public.user_roles from authenticated;
revoke insert, update, delete on public.user_roles from anon;

-- 4) Harden has_role: authenticated callers can only probe their OWN
-- user id; cross-user probes return false. service_role (edge functions,
-- triggers, admin client) may probe any verified id — that's what
-- flywheel-miner and other server code rely on.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if _user_id is null then
    return false;
  end if;
  if auth.role() <> 'service_role' and _user_id is distinct from auth.uid() then
    return false;
  end if;
  return exists (
    select 1
      from public.user_roles
     where user_id = _user_id
       and role = _role
  );
end;
$fn$;

grant execute on function public.has_role(uuid, public.app_role) to authenticated;
grant execute on function public.has_role(uuid, public.app_role) to service_role;

-- 5) Documentation: profiles.role is a synchronized display mirror only.
comment on column public.profiles.role is
  'Synchronized display mirror only. Authorization is enforced against public.user_roles via has_role(); trigger sync_user_role_from_profile keeps user_roles in sync (student -> user, instructor -> instructor, admin -> admin). Do not read this column for authorization.';
