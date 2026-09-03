-- Staff access model: department defaults, explicit permissions and customer ownership.
-- This is additive and keeps existing role-based access working for legacy rows.

alter table public.profiles
  add column if not exists department text not null default 'sales',
  add column if not exists permissions jsonb not null default '{}'::jsonb;

alter table public.profiles drop constraint if exists profiles_department_check;
alter table public.profiles
  add constraint profiles_department_check
  check (department in ('management', 'sales', 'purchasing', 'accounting', 'warehouse', 'viewer'));

update public.profiles
set department = case
  when role in ('superadmin', 'admin') then 'management'
  when role = 'warehouse' then 'warehouse'
  when role = 'sales' then 'sales'
  else 'viewer'
end
where department is null or department = 'sales' and role in ('superadmin', 'admin', 'warehouse', 'viewer');

alter table public.customers
  add column if not exists owner_profile_id uuid null references public.profiles(id) on delete set null;

create index if not exists idx_profiles_org_department
  on public.profiles (organization_id, department);
create index if not exists idx_customers_org_owner_profile
  on public.customers (organization_id, owner_profile_id);

create table if not exists public.profile_permissions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null,
  allowed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, permission_key)
);

alter table public.profile_permissions drop constraint if exists profile_permissions_key_check;
alter table public.profile_permissions
  add constraint profile_permissions_key_check
  check (permission_key in (
    'customers.view', 'customers.manage', 'catalog.view', 'catalog.manage',
    'sales.orders', 'sales.invoices', 'purchasing.orders', 'purchasing.receive',
    'supplier_prices.view', 'supplier_prices.manage', 'inventory.view',
    'finance.view', 'finance.manage', 'reports.view'
  ));

create index if not exists idx_profile_permissions_org_profile
  on public.profile_permissions (organization_id, profile_id);

create table if not exists public.profile_customer_access (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  access_level text not null default 'view',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, customer_id),
  constraint profile_customer_access_level_check check (access_level in ('view', 'edit', 'order', 'invoice'))
);

create index if not exists idx_profile_customer_access_org_profile
  on public.profile_customer_access (organization_id, profile_id);
create index if not exists idx_profile_customer_access_org_customer
  on public.profile_customer_access (organization_id, customer_id);

create or replace function public.current_profile_department()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((select p.department from public.profiles p where p.id = auth.uid() and p.is_active limit 1), 'viewer');
$$;

create or replace function public.profile_has_permission(input_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when public.raw_profile_role(auth.uid()) in ('superadmin', 'admin') then true
    when exists (
      select 1 from public.profile_permissions pp
      join public.profiles p on p.id = pp.profile_id and p.organization_id = pp.organization_id
      where pp.profile_id = auth.uid() and pp.permission_key = input_permission and pp.allowed and p.is_active
    ) then true
    else case public.current_profile_department()
      when 'sales' then input_permission in ('customers.view', 'catalog.view', 'sales.orders', 'sales.invoices', 'reports.view')
      when 'purchasing' then input_permission in ('catalog.view', 'purchasing.orders', 'purchasing.receive', 'supplier_prices.view', 'reports.view')
      when 'accounting' then input_permission in ('customers.view', 'sales.invoices', 'finance.view', 'reports.view')
      when 'warehouse' then input_permission in ('catalog.view', 'inventory.view', 'purchasing.receive')
      else input_permission = 'catalog.view'
    end
  end;
$$;

create or replace function public.can_access_customer(input_customer_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or exists (
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
    );
$$;

grant execute on function public.current_profile_department() to authenticated, service_role;
grant execute on function public.profile_has_permission(text) to authenticated, service_role;
grant execute on function public.can_access_customer(uuid) to authenticated, service_role;

alter table public.profile_permissions enable row level security;
alter table public.profile_customer_access enable row level security;

drop policy if exists profile_permissions_admin_manage on public.profile_permissions;
create policy profile_permissions_admin_manage on public.profile_permissions
for all using (public.is_superadmin() and organization_id = public.current_profile_org_id())
with check (public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists profile_customer_access_admin_manage on public.profile_customer_access;
create policy profile_customer_access_admin_manage on public.profile_customer_access
for all using (public.is_superadmin() and organization_id = public.current_profile_org_id())
with check (public.is_superadmin() and organization_id = public.current_profile_org_id());

-- Add the ownership field to the existing customer projection without removing
-- legacy columns. Service-role APIs may still fall back when older schemas are used.
drop policy if exists customers_select_org on public.customers;
drop policy if exists customers_write_org on public.customers;
drop policy if exists customers_select_scoped on public.customers;
create policy customers_select_scoped on public.customers
for select using (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or (
      public.profile_has_permission('customers.view')
      and (
        public.can_access_customer(id)
        or not exists (
          select 1 from public.profile_customer_access a where a.profile_id = auth.uid()
        )
      )
    )
  )
);

create policy customers_write_scoped on public.customers
for all using (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or (
      public.profile_has_permission('customers.manage')
      and (public.can_access_customer(id) or not exists (
        select 1 from public.profile_customer_access a where a.profile_id = auth.uid()
      ))
    )
  )
)
with check (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or public.profile_has_permission('customers.manage')
  )
);

create or replace function public.admin_list_org_users_with_access()
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  department text,
  permissions jsonb,
  is_active boolean,
  created_at timestamptz,
  last_login_at timestamptz,
  last_seen_at timestamptz,
  quote_count bigint,
  last_quote_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can list organization users';
  end if;
  return query
  select p.id, p.email, p.full_name, p.role, p.department, p.permissions,
    p.is_active, p.created_at, au.last_sign_in_at, up.last_seen_at,
    count(q.id)::bigint, max(q.created_at)
  from public.profiles p
  join auth.users au on au.id = p.id
  left join public.user_presence up on up.user_id = p.id
  left join public.quotes q on q.organization_id = p.organization_id and q.created_by = p.id
  where p.organization_id = public.current_profile_org_id()
  group by p.id, p.email, p.full_name, p.role, p.department, p.permissions,
    p.is_active, p.created_at, au.last_sign_in_at, up.last_seen_at
  order by p.is_active desc, p.created_at desc;
end;
$$;

grant execute on function public.admin_list_org_users_with_access() to authenticated;
