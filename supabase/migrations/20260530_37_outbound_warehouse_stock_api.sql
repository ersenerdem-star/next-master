create table if not exists public.warehouse_api_clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_name text not null default '',
  partner_name text not null default '',
  status text not null default 'active',
  api_key_hash text not null,
  api_key_prefix text not null default '',
  include_zero_stock boolean not null default false,
  expose_unit_cost boolean not null default false,
  notes text not null default '',
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_ip text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_api_clients'::regclass
      and conname = 'warehouse_api_clients_status_check'
  ) then
    alter table public.warehouse_api_clients
      add constraint warehouse_api_clients_status_check
      check (status in ('active', 'disabled'));
  end if;
end $$;

create unique index if not exists idx_warehouse_api_clients_org_hash
  on public.warehouse_api_clients (organization_id, api_key_hash);

create index if not exists idx_warehouse_api_clients_org_status
  on public.warehouse_api_clients (organization_id, status, partner_name);

create table if not exists public.warehouse_api_client_warehouses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.warehouse_api_clients(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_warehouse_api_client_warehouses_unique
  on public.warehouse_api_client_warehouses (client_id, warehouse_id);

create index if not exists idx_warehouse_api_client_warehouses_org_client
  on public.warehouse_api_client_warehouses (organization_id, client_id);

create table if not exists public.warehouse_api_request_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid references public.warehouse_api_clients(id) on delete set null,
  client_name text not null default '',
  partner_name text not null default '',
  request_ip text not null default '',
  warehouse_filter text not null default '',
  brand_filter text not null default '',
  code_filter text not null default '',
  status text not null default 'success',
  response_item_count integer not null default 0,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_api_request_logs'::regclass
      and conname = 'warehouse_api_request_logs_status_check'
  ) then
    alter table public.warehouse_api_request_logs
      add constraint warehouse_api_request_logs_status_check
      check (status in ('success', 'unauthorized', 'forbidden', 'error'));
  end if;
end $$;

create index if not exists idx_warehouse_api_request_logs_org_created
  on public.warehouse_api_request_logs (organization_id, created_at desc);

grant select, insert, update, delete
on public.warehouse_api_clients
to authenticated;

grant select, insert, update, delete
on public.warehouse_api_clients
to service_role;

grant select, insert, update, delete
on public.warehouse_api_client_warehouses
to authenticated;

grant select, insert, update, delete
on public.warehouse_api_client_warehouses
to service_role;

grant select
on public.warehouse_api_request_logs
to authenticated;

grant select, insert, update, delete
on public.warehouse_api_request_logs
to service_role;

alter table public.warehouse_api_clients enable row level security;
alter table public.warehouse_api_client_warehouses enable row level security;
alter table public.warehouse_api_request_logs enable row level security;

drop policy if exists warehouse_api_clients_select_admin on public.warehouse_api_clients;
create policy warehouse_api_clients_select_admin on public.warehouse_api_clients
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_api_clients_write_admin on public.warehouse_api_clients;
create policy warehouse_api_clients_write_admin on public.warehouse_api_clients
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_api_client_warehouses_select_admin on public.warehouse_api_client_warehouses;
create policy warehouse_api_client_warehouses_select_admin on public.warehouse_api_client_warehouses
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_api_client_warehouses_write_admin on public.warehouse_api_client_warehouses;
create policy warehouse_api_client_warehouses_write_admin on public.warehouse_api_client_warehouses
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_api_request_logs_select_admin on public.warehouse_api_request_logs;
create policy warehouse_api_request_logs_select_admin on public.warehouse_api_request_logs
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);
