create table if not exists warehouses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  warehouse_code text not null,
  warehouse_name text not null,
  region text not null default '',
  address text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, warehouse_code),
  unique (organization_id, warehouse_name)
);

create index if not exists idx_warehouses_org_name on warehouses (organization_id, warehouse_name);
create index if not exists idx_warehouses_org_active on warehouses (organization_id, is_active);

alter table warehouses enable row level security;

drop policy if exists warehouses_select_org on warehouses;
create policy warehouses_select_org on warehouses
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists warehouses_write_org on warehouses;
create policy warehouses_write_org on warehouses
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
