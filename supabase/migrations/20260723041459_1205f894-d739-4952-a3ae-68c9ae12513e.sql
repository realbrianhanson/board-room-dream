-- Additive hardening. The prior follow-up set search_path = public on
-- sync_user_role_from_profile and has_role. That is only actually
-- "locked" if public CREATE is revoked; otherwise a hostile object in
-- public could shadow an unqualified reference. Replace both functions
-- with search_path = '' and fully-qualified public/auth references so
-- production is repaired regardless of public CREATE grants. Trigger,
-- grants, student->user mapping, self-probe restriction, and
-- service_role behavior are preserved.

create or replace function public.sync_user_role_from_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _role public.app_role;
begin
  _role := case new.role
    when 'admin' then 'admin'::public.app_role
    when 'instructor' then 'instructor'::public.app_role
    else 'user'::public.app_role
  end;
  delete from public.user_roles
    where user_id = new.id and role <> _role;
  insert into public.user_roles (user_id, role)
    values (new.id, _role)
    on conflict (user_id, role) do nothing;
  return new;
end;
$fn$;

-- Trigger already points at this function name; recreate defensively so
-- a fresh restore also gets the wiring.
drop trigger if exists profiles_sync_user_role on public.profiles;
create trigger profiles_sync_user_role
  after insert or update of role on public.profiles
  for each row execute function public.sync_user_role_from_profile();

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if _user_id is null then
    return false;
  end if;
  -- auth.role() and auth.uid() are provided by the auth schema; fully
  -- qualified so an empty search_path cannot resolve to a shadow.
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
