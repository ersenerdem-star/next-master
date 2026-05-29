create table if not exists payments_received (
  id text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  invoice_id text not null default '',
  invoice_no text not null default '',
  customer_name text not null default '',
  currency text not null default 'EUR',
  received_date text not null default '',
  amount numeric(14, 2) not null default 0,
  method text not null default 'Bank Transfer',
  reference_no text not null default '',
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'void')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payments_received_org_updated_at on payments_received (organization_id, updated_at desc);
create index if not exists idx_payments_received_org_invoice_id on payments_received (organization_id, invoice_id);
create index if not exists idx_payments_received_org_customer_name on payments_received (organization_id, customer_name);

grant select, insert, update, delete
on public.payments_received
to authenticated;

grant select, insert, update, delete
on public.payments_received
to service_role;

alter table payments_received enable row level security;

drop policy if exists payments_received_select_org on payments_received;
create policy payments_received_select_org on payments_received
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists payments_received_write_org on payments_received;
create policy payments_received_write_org on payments_received
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

create table if not exists payments_made (
  id text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  bill_id text not null default '',
  bill_no text not null default '',
  supplier_name text not null default '',
  purchase_company text not null default '',
  currency text not null default 'EUR',
  payment_date text not null default '',
  amount numeric(14, 2) not null default 0,
  method text not null default 'Bank Transfer',
  reference_no text not null default '',
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'void')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payments_made_org_updated_at on payments_made (organization_id, updated_at desc);
create index if not exists idx_payments_made_org_bill_id on payments_made (organization_id, bill_id);
create index if not exists idx_payments_made_org_supplier_name on payments_made (organization_id, supplier_name);

grant select, insert, update, delete
on public.payments_made
to authenticated;

grant select, insert, update, delete
on public.payments_made
to service_role;

alter table payments_made enable row level security;

drop policy if exists payments_made_select_org on payments_made;
create policy payments_made_select_org on payments_made
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists payments_made_write_org on payments_made;
create policy payments_made_write_org on payments_made
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
