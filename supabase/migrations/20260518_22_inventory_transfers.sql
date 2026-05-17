create table if not exists stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  transfer_no text not null default '',
  source_warehouse_id uuid not null references warehouses(id) on delete restrict,
  source_warehouse_code text not null default '',
  source_warehouse_name text not null default '',
  target_warehouse_id uuid not null references warehouses(id) on delete restrict,
  target_warehouse_code text not null default '',
  target_warehouse_name text not null default '',
  status text not null default 'posted' check (status in ('draft', 'posted', 'void')),
  transfer_date date not null default current_date,
  notes text not null default '',
  total_qty numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, transfer_no)
);

grant select, insert, update, delete
on public.stock_transfers
to authenticated;

grant select, insert, update, delete
on public.stock_transfers
to service_role;

create index if not exists idx_stock_transfers_org_updated_at
  on stock_transfers (organization_id, updated_at desc);

create index if not exists idx_stock_transfers_org_source
  on stock_transfers (organization_id, source_warehouse_id, transfer_date desc);

create index if not exists idx_stock_transfers_org_target
  on stock_transfers (organization_id, target_warehouse_id, transfer_date desc);

alter table stock_transfers enable row level security;

drop policy if exists stock_transfers_select_org on stock_transfers;
create policy stock_transfers_select_org on stock_transfers
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists stock_transfers_write_org on stock_transfers;
create policy stock_transfers_write_org on stock_transfers
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
