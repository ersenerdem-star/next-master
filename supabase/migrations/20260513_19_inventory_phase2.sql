create table if not exists purchase_receives (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id text not null,
  purchase_order_no text not null default '',
  supplier_name text not null default '',
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  status text not null default 'posted' check (status in ('draft', 'posted', 'void')),
  received_date date not null default current_date,
  notes text not null default '',
  total_qty numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete
on public.purchase_receives
to authenticated;

grant select, insert, update, delete
on public.purchase_receives
to service_role;

create index if not exists idx_purchase_receives_org_updated_at
  on purchase_receives (organization_id, updated_at desc);

create index if not exists idx_purchase_receives_org_po
  on purchase_receives (organization_id, purchase_order_id);

create index if not exists idx_purchase_receives_org_warehouse
  on purchase_receives (organization_id, warehouse_id, received_date desc);

alter table purchase_receives enable row level security;

drop policy if exists purchase_receives_select_org on purchase_receives;
create policy purchase_receives_select_org on purchase_receives
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists purchase_receives_write_org on purchase_receives;
create policy purchase_receives_write_org on purchase_receives
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

create table if not exists inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  movement_type text not null check (movement_type in ('purchase_receive', 'transfer_in', 'transfer_out', 'adjustment')),
  document_type text not null default '',
  document_id text not null default '',
  document_no text not null default '',
  related_party text not null default '',
  product_code text not null default '',
  old_code text not null default '',
  brand text not null default '',
  description text not null default '',
  qty_in numeric(14, 2) not null default 0,
  qty_out numeric(14, 2) not null default 0,
  unit_cost numeric(14, 2) not null default 0,
  total_cost numeric(14, 2) not null default 0,
  origin text not null default '',
  notes text not null default '',
  moved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete
on public.inventory_movements
to authenticated;

grant select, insert, update, delete
on public.inventory_movements
to service_role;

create index if not exists idx_inventory_movements_org_moved_at
  on inventory_movements (organization_id, moved_at desc);

create index if not exists idx_inventory_movements_org_warehouse_code
  on inventory_movements (organization_id, warehouse_id, product_code);

create index if not exists idx_inventory_movements_org_brand_code
  on inventory_movements (organization_id, brand, product_code);

alter table inventory_movements enable row level security;

drop policy if exists inventory_movements_select_org on inventory_movements;
create policy inventory_movements_select_org on inventory_movements
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists inventory_movements_write_org on inventory_movements;
create policy inventory_movements_write_org on inventory_movements
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

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
