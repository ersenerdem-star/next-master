create table if not exists sales_orders (
  id text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_no text not null,
  customer_name text not null default '',
  seller_company text not null default '',
  purchase_company text not null default '',
  quote_date text not null default '',
  currency text not null default 'EUR',
  customer_type text not null default 'A',
  shipping_cost numeric(14, 2) not null default 0,
  discount_amount numeric(14, 2) not null default 0,
  supplier_mode text not null default '',
  preferred_supplier text not null default '',
  seller_info text not null default '',
  buyer_info text not null default '',
  delivery_term text not null default '',
  payment_terms text not null default '',
  packing_details text not null default '',
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  purchase_total numeric(14, 2) not null default 0,
  sales_total numeric(14, 2) not null default 0,
  profit_total numeric(14, 2) not null default 0,
  margin_percent numeric(10, 2) not null default 0,
  confirmed_at timestamptz null,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sales_orders_org_updated_at on sales_orders (organization_id, updated_at desc);
create index if not exists idx_sales_orders_org_sales_order_no on sales_orders (organization_id, sales_order_no);
create index if not exists idx_sales_orders_org_status on sales_orders (organization_id, status);

grant select, insert, update, delete
on public.sales_orders
to authenticated;

grant select, insert, update, delete
on public.sales_orders
to service_role;

alter table sales_orders enable row level security;

drop policy if exists sales_orders_select_org on sales_orders;
create policy sales_orders_select_org on sales_orders
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists sales_orders_write_org on sales_orders;
create policy sales_orders_write_org on sales_orders
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

create table if not exists purchase_orders (
  id text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_name text not null default '',
  supplier_key text not null default '',
  purchase_company text not null default '',
  sales_order_id text not null,
  sales_order_no text not null default '',
  customer_name text not null default '',
  status text not null default 'open' check (status in ('draft', 'open', 'closed')),
  currency text not null default 'EUR',
  total_amount numeric(14, 2) not null default 0,
  line_count integer not null default 0,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_purchase_orders_org_updated_at on purchase_orders (organization_id, updated_at desc);
create index if not exists idx_purchase_orders_org_sales_order_id on purchase_orders (organization_id, sales_order_id);
create index if not exists idx_purchase_orders_org_supplier_key on purchase_orders (organization_id, supplier_key);

grant select, insert, update, delete
on public.purchase_orders
to authenticated;

grant select, insert, update, delete
on public.purchase_orders
to service_role;

alter table purchase_orders enable row level security;

drop policy if exists purchase_orders_select_org on purchase_orders;
create policy purchase_orders_select_org on purchase_orders
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists purchase_orders_write_org on purchase_orders;
create policy purchase_orders_write_org on purchase_orders
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

create table if not exists invoices (
  id text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id text not null,
  sales_order_no text not null default '',
  customer_name text not null default '',
  seller_company text not null default '',
  purchase_company text not null default '',
  currency text not null default 'EUR',
  status text not null default 'open' check (status in ('draft', 'open', 'paid', 'void')),
  quote_date text not null default '',
  delivery_term text not null default '',
  payment_terms text not null default '',
  due_date text not null default '',
  contract_nr text not null default '',
  packing_details text not null default '',
  notes text not null default '',
  subtotal numeric(14, 2) not null default 0,
  discount_amount numeric(14, 2) not null default 0,
  shipping_cost numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  purchase_total numeric(14, 2) not null default 0,
  profit_total numeric(14, 2) not null default 0,
  margin_percent numeric(10, 2) not null default 0,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoices_org_updated_at on invoices (organization_id, updated_at desc);
create index if not exists idx_invoices_org_sales_order_id on invoices (organization_id, sales_order_id);
create index if not exists idx_invoices_org_customer_name on invoices (organization_id, customer_name);

grant select, insert, update, delete
on public.invoices
to authenticated;

grant select, insert, update, delete
on public.invoices
to service_role;

alter table invoices enable row level security;

drop policy if exists invoices_select_org on invoices;
create policy invoices_select_org on invoices
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists invoices_write_org on invoices;
create policy invoices_write_org on invoices
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
