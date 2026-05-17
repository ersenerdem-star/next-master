alter table purchase_orders drop constraint if exists purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check check (status in ('draft', 'confirmed', 'open', 'closed'));

alter table invoices drop constraint if exists invoices_status_check;
alter table invoices add constraint invoices_status_check check (status in ('draft', 'confirmed', 'open', 'paid', 'void'));

create table if not exists bills (
  id text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id text not null,
  purchase_order_no text not null default '',
  supplier_name text not null default '',
  purchase_company text not null default '',
  currency text not null default 'EUR',
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'paid', 'void')),
  bill_date text not null default '',
  due_date text not null default '',
  payment_terms text not null default '',
  notes text not null default '',
  subtotal numeric(14, 2) not null default 0,
  shipping_cost numeric(14, 2) not null default 0,
  discount_amount numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bills_org_updated_at on bills (organization_id, updated_at desc);
create index if not exists idx_bills_org_purchase_order_id on bills (organization_id, purchase_order_id);
create index if not exists idx_bills_org_supplier_name on bills (organization_id, supplier_name);

alter table bills enable row level security;

drop policy if exists bills_select_org on bills;
create policy bills_select_org on bills
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists bills_write_org on bills;
create policy bills_write_org on bills
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
