-- Admin user management and quote ownership helpers.
-- Run this in Supabase SQL Editor.

create table if not exists user_presence (
  user_id uuid primary key references profiles(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_presence_org_seen
  on user_presence (organization_id, last_seen_at desc);

grant select, insert, update, delete
on public.user_presence
to authenticated;

grant select, insert, update, delete
on public.user_presence
to service_role;

alter table user_presence enable row level security;

drop policy if exists user_presence_select_admin_org on user_presence;
create policy user_presence_select_admin_org on user_presence
for select
using (
  current_profile_role() = 'admin'
  and organization_id = current_profile_org_id()
);

drop policy if exists user_presence_write_self on user_presence;
create policy user_presence_write_self on user_presence
for all
using (
  auth.uid() = user_id
  and organization_id = current_profile_org_id()
)
with check (
  auth.uid() = user_id
  and organization_id = current_profile_org_id()
);

create or replace function touch_user_presence()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  profile_id uuid;
begin
  org_id := current_profile_org_id();
  profile_id := auth.uid();
  if org_id is null or profile_id is null then
    raise exception 'Active profile required';
  end if;

  insert into user_presence (
    user_id,
    organization_id,
    last_seen_at,
    updated_at
  )
  values (
    profile_id,
    org_id,
    now(),
    now()
  )
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    last_seen_at = excluded.last_seen_at,
    updated_at = now();

  return jsonb_build_object('status', 'ok', 'user_id', profile_id, 'last_seen_at', now());
end;
$$;

create or replace function admin_list_org_users()
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  is_active boolean,
  created_at timestamptz,
  last_login_at timestamptz,
  last_seen_at timestamptz,
  quote_count bigint,
  last_quote_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can list organization users';
  end if;

  return query
  select
    p.id,
    p.email,
    p.full_name,
    p.role,
    p.is_active,
    p.created_at,
    au.last_sign_in_at as last_login_at,
    up.last_seen_at,
    count(q.id)::bigint as quote_count,
    max(q.created_at) as last_quote_at
  from profiles p
  join auth.users au
    on au.id = p.id
  left join user_presence up
    on up.user_id = p.id
  left join quotes q
    on q.organization_id = p.organization_id
   and q.created_by = p.id
  where p.organization_id = org_id
  group by p.id, p.email, p.full_name, p.role, p.is_active, p.created_at, au.last_sign_in_at, up.last_seen_at
  order by p.is_active desc, p.created_at desc;
end;
$$;

create or replace function admin_delete_org_user_profile(
  input_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  deleted_count integer := 0;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can delete organization users';
  end if;
  if input_user_id is null then
    raise exception 'User id is required';
  end if;

  delete from profiles
  where id = input_user_id
    and organization_id = org_id;

  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'status', 'ok',
    'deleted_count', deleted_count,
    'user_id', input_user_id
  );
end;
$$;

create or replace function upsert_org_user_profile(
  input_user_id uuid,
  input_email text,
  input_full_name text default '',
  input_role text default 'sales',
  input_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  saved_id uuid;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can manage organization users';
  end if;
  if input_user_id is null then
    raise exception 'User id is required';
  end if;
  if nullif(trim(coalesce(input_email, '')), '') is null then
    raise exception 'Email is required';
  end if;
  if coalesce(input_role, '') not in ('admin', 'sales', 'viewer') then
    raise exception 'Invalid role';
  end if;

  insert into profiles (
    id,
    organization_id,
    email,
    full_name,
    role,
    is_active
  )
  values (
    input_user_id,
    org_id,
    lower(trim(input_email)),
    nullif(trim(coalesce(input_full_name, '')), ''),
    input_role,
    coalesce(input_is_active, true)
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    is_active = excluded.is_active,
    organization_id = excluded.organization_id
  returning id into saved_id;

  return jsonb_build_object(
    'status', 'ok',
    'user_id', saved_id,
    'email', lower(trim(input_email)),
    'role', input_role,
    'is_active', coalesce(input_is_active, true)
  );
end;
$$;

create or replace function admin_list_quote_activity(
  input_limit integer default 100,
  input_search text default ''
)
returns table (
  quote_id uuid,
  quote_no text,
  customer_name text,
  status text,
  quote_date date,
  created_at timestamptz,
  updated_at timestamptz,
  created_by_name text,
  created_by_email text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can view quote activity';
  end if;

  return query
  select
    q.id,
    q.quote_no,
    q.customer_name,
    q.status,
    q.quote_date,
    q.created_at,
    q.updated_at,
    coalesce(p.full_name, p.email, 'Unknown user') as created_by_name,
    p.email as created_by_email
  from quotes q
  left join profiles p on p.id = q.created_by
  where q.organization_id = org_id
    and (
      coalesce(input_search, '') = ''
      or q.quote_no ilike '%' || input_search || '%'
      or coalesce(q.customer_name, '') ilike '%' || input_search || '%'
      or coalesce(p.full_name, '') ilike '%' || input_search || '%'
      or coalesce(p.email, '') ilike '%' || input_search || '%'
    )
  order by q.updated_at desc, q.created_at desc
  limit least(greatest(input_limit, 1), 200);
end;
$$;

grant execute on function admin_list_org_users() to authenticated;
grant execute on function touch_user_presence() to authenticated;
grant execute on function upsert_org_user_profile(uuid, text, text, text, boolean) to authenticated;
grant execute on function admin_delete_org_user_profile(uuid) to authenticated;
grant execute on function admin_list_quote_activity(integer, text) to authenticated;
