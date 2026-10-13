-- Small local-only Supabase auth/profile/RLS fixture for migration 140021.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated;

create table public.profiles (
  id uuid primary key,
  organization_id uuid not null,
  is_active boolean not null,
  role text not null,
  customer_scope_mode text not null,
  customers_view boolean not null
);
create table public.customers (
  id uuid primary key,
  organization_id uuid not null,
  display_name text not null default '',
  company_name text not null default '',
  owner_profile_id uuid
);
create table public.profile_customer_access (
  profile_id uuid not null,
  organization_id uuid not null,
  customer_id uuid not null
);

create function public.current_profile_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.organization_id from public.profiles p
  where p.id = auth.uid() and p.is_active limit 1
$$;
create function public.raw_profile_role(input_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select p.role from public.profiles p
    where p.id = input_user_id and p.is_active limit 1
  ), '')
$$;
create function public.profile_has_permission(input_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active and p.customers_view
      and input_permission = 'customers.view'
  )
$$;
create function public.current_profile_customer_scope_mode() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select p.customer_scope_mode from public.profiles p
    where p.id = auth.uid() and p.is_active limit 1
  ), 'assigned')
$$;
create function public.can_access_customer(input_customer_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.customers c
    where c.id = input_customer_id
      and c.organization_id = public.current_profile_org_id()
      and (
        c.owner_profile_id = auth.uid()
        or exists (
          select 1 from public.profile_customer_access a
          where a.profile_id = auth.uid()
            and a.customer_id = c.id
            and a.organization_id = c.organization_id
        )
      )
  )
$$;

insert into public.profiles values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', true, 'admin', 'all', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', true, 'sales', 'assigned', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', true, 'sales', 'all', true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111', true, 'viewer', 'all', true),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', false, 'sales', 'all', true),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', '22222222-2222-4222-8222-222222222222', true, 'admin', 'all', true);

insert into public.customers values
  ('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Acme', '', null),
  ('11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'Other', '  ACME ', null),
  ('11111111-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', 'Unique Visible', '', null),
  ('11111111-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111', 'Unique Hidden', '', null),
  ('11111111-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'Hidden Pair', '', null),
  ('11111111-ffff-4fff-8fff-ffffffffffff', '11111111-1111-4111-8111-111111111111', '', 'Hidden Pair', null),
  ('11111111-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Three-Way', '', null),
  ('11111111-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '', 'Three-Way', null),
  ('11111111-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Three-Way', '', null),
  ('22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'Unique Visible', '', null);
insert into public.customers (id, organization_id, display_name)
select gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'Filler ' || i
from generate_series(1, 1200) i;
insert into public.profile_customer_access values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', '11111111-cccc-4ccc-8ccc-cccccccccccc'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000003');

alter table public.customers enable row level security;
create policy customers_select_scoped on public.customers for select to authenticated using (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('admin', 'superadmin')
    or (
      public.profile_has_permission('customers.view')
      and (
        public.current_profile_customer_scope_mode() = 'all'
        or public.can_access_customer(id)
      )
    )
  )
);
grant select on public.customers to authenticated;
