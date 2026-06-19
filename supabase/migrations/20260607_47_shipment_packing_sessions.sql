create table if not exists public.shipment_packing_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sales_order_id text not null default '',
  sales_order_no text not null default '',
  invoice_id text not null default '',
  invoice_no text not null default '',
  warehouse_id uuid references public.warehouses(id) on delete set null,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  customer_name text not null default '',
  seller_company text not null default '',
  status text not null default 'reserved',
  package_count integer not null default 0,
  packed_qty_total numeric(14, 2) not null default 0,
  packages jsonb not null default '[]'::jsonb,
  assignments jsonb not null default '{}'::jsonb,
  vehicle jsonb not null default '{}'::jsonb,
  reserved_lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sales_order_id)
);

create index if not exists idx_shipment_packing_sessions_org_updated
  on public.shipment_packing_sessions (organization_id, updated_at desc);

create index if not exists idx_shipment_packing_sessions_org_warehouse
  on public.shipment_packing_sessions (organization_id, warehouse_id, updated_at desc);

create index if not exists idx_shipment_packing_sessions_org_invoice
  on public.shipment_packing_sessions (organization_id, invoice_id, updated_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.shipment_packing_sessions'::regclass
      and conname = 'shipment_packing_sessions_status_check'
  ) then
    alter table public.shipment_packing_sessions
      add constraint shipment_packing_sessions_status_check
      check (status in ('draft', 'reserved', 'released', 'void'));
  end if;
end $$;

grant select, insert, update, delete
on public.shipment_packing_sessions
to authenticated;

grant select, insert, update, delete
on public.shipment_packing_sessions
to service_role;

alter table public.shipment_packing_sessions enable row level security;

drop policy if exists shipment_packing_sessions_select_inventory_users on public.shipment_packing_sessions;
create policy shipment_packing_sessions_select_inventory_users on public.shipment_packing_sessions
for select
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse', 'sales')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists shipment_packing_sessions_write_ops_users on public.shipment_packing_sessions;
create policy shipment_packing_sessions_write_ops_users on public.shipment_packing_sessions
for all
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
);
