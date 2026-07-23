
do $$ begin
  create type public.app_role as enum ('admin', 'instructor', 'user');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

drop policy if exists "Users read their own role rows" on public.user_roles;
create policy "Users read their own role rows"
on public.user_roles for select
to authenticated
using (user_id = auth.uid());

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from public.user_roles
     where user_id = _user_id
       and role = _role
  )
$fn$;

grant execute on function public.has_role(uuid, public.app_role) to authenticated;
grant execute on function public.has_role(uuid, public.app_role) to service_role;

insert into public.user_roles (user_id, role)
select p.id,
       case p.role
         when 'admin' then 'admin'::public.app_role
         when 'instructor' then 'instructor'::public.app_role
         else 'user'::public.app_role
       end
  from public.profiles p
 where p.role in ('admin','instructor','user')
on conflict (user_id, role) do nothing;
