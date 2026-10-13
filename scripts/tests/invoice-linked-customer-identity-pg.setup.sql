-- Local-only schema large enough to execute the real save_invoice_atomic RPC.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.customers (
  id uuid primary key,
  organization_id uuid not null,
  display_name text not null default '',
  company_name text not null default '',
  price_list_type text not null default 'A',
  price_list_margin_percent numeric,
  custom_fields text not null default ''
);
create table public.sales_orders (
  id text primary key,
  organization_id uuid not null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null default '',
  customer_type text not null default 'A',
  status text not null default 'draft',
  notes text not null default '',
  confirmed_at timestamptz,
  portal_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  currency text not null default 'EUR'
);
create table public.warehouses (id uuid primary key, organization_id uuid not null);
create table public.payments_received (organization_id uuid not null, invoice_id text not null);
create table public.purchase_orders (id text primary key, organization_id uuid not null, currency text not null default 'EUR');
create table public.payments_made (organization_id uuid not null, bill_id text not null);
create table public.bills (id text primary key, organization_id uuid not null, status text not null default 'draft');

create table public.invoices (
  id text primary key,
  organization_id uuid not null,
  sales_order_id text not null,
  sales_order_ids text[] not null default '{}',
  customer_id uuid references public.customers(id) on delete set null,
  warehouse_id uuid,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  sales_order_no text not null default '',
  customer_name text not null default '',
  seller_company text not null default '',
  purchase_company text not null default '',
  currency text not null default 'EUR',
  status text not null default 'draft',
  quote_date text not null default '',
  delivery_term text not null default '',
  payment_terms text not null default '',
  due_date text not null default '',
  contract_nr text not null default '',
  packing_details text not null default '',
  notes text not null default '',
  subtotal numeric(14,2) not null default 0,
  discount_amount numeric(14,2) not null default 0,
  shipping_cost numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  purchase_total numeric(14,2) not null default 0,
  profit_total numeric(14,2) not null default 0,
  margin_percent numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lines jsonb not null default '[]'::jsonb
);

create function public.current_profile_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.test_org', true), '')::uuid
$$;
create function public.current_profile_role() returns text
language sql stable as $$
  select nullif(current_setting('app.test_role', true), '')
$$;
create function public.is_superadmin() returns boolean
language sql stable as $$ select false $$;
create function public.recalculate_invoice_paid_status_for_org(uuid, text) returns jsonb
language sql as $$ select '{}'::jsonb $$;
create function public.recalculate_bill_paid_status_for_org(uuid, text) returns jsonb
language sql as $$ select '{}'::jsonb $$;

grant usage on schema public to authenticated;
grant select, insert, update on public.invoices to authenticated;
grant select, update, delete on public.sales_orders to authenticated;
alter table public.invoices enable row level security;
create policy invoices_org on public.invoices to authenticated
  using (organization_id = public.current_profile_org_id())
  with check (organization_id = public.current_profile_org_id());
alter table public.sales_orders enable row level security;
create policy sales_orders_org on public.sales_orders to authenticated
  using (organization_id = public.current_profile_org_id())
  with check (organization_id = public.current_profile_org_id());

insert into public.customers (id, organization_id, display_name, company_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Renamed A', 'Legal A Ltd'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'Customer B', ''),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222', 'Other org customer', '');
insert into public.sales_orders (id, organization_id, customer_id, customer_name, currency) values
  ('a-1', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Customer A', 'EUR'),
  ('a-2', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Customer A', 'EUR'),
  ('b-1', '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Customer B', 'EUR'),
  ('draft-shift', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Customer A', 'EUR'),
  ('unbound', '11111111-1111-4111-8111-111111111111', null, '', 'EUR'),
  ('other-org', '22222222-2222-4222-8222-222222222222', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Other org customer', 'EUR'),
  ('wrong-org-customer', '11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Other org customer', 'EUR');

-- Must survive migration without name-matching or a whole-table backfill.
insert into public.invoices (id, organization_id, sales_order_id, sales_order_ids, customer_name, status)
values ('legacy', '11111111-1111-4111-8111-111111111111', 'deleted-order', array['deleted-order'], 'Historical customer', 'open');
