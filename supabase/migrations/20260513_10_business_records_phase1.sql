create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_type text not null default 'Business',
  salutation text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  company_name text not null default '',
  display_name text not null default '',
  email text not null default '',
  customer_number text not null,
  work_phone text not null default '',
  mobile_phone text not null default '',
  language text not null default 'English',
  tax_rate text not null default '',
  company_id text not null default '',
  currency text not null default 'EUR',
  payment_terms text not null default 'Cash in Advance',
  contract_nr text not null default '',
  price_list_type text not null default 'A',
  billing_address text not null default '',
  shipping_address text not null default '',
  contact_persons text not null default '',
  custom_fields text not null default '',
  reporting_tags text not null default '',
  remarks text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, customer_number)
);

create index if not exists idx_customers_org_display_name on customers (organization_id, display_name);
create index if not exists idx_customers_org_company_name on customers (organization_id, company_name);

grant select, insert, update, delete
on public.customers
to authenticated;

grant select, insert, update, delete
on public.customers
to service_role;

alter table customers enable row level security;

drop policy if exists customers_select_org on customers;
create policy customers_select_org on customers
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists customers_write_org on customers;
create policy customers_write_org on customers
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

create table if not exists company_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  company_name text not null,
  email text not null default '',
  phone text not null default '',
  website text not null default '',
  address text not null default '',
  bank_details text not null default '',
  tax_office text not null default '',
  tax_number text not null default '',
  footer_note text not null default '',
  logo_data_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, company_name)
);

create index if not exists idx_company_profiles_org_company_name on company_profiles (organization_id, company_name);

grant select, insert, update, delete
on public.company_profiles
to authenticated;

grant select, insert, update, delete
on public.company_profiles
to service_role;

alter table company_profiles enable row level security;

drop policy if exists company_profiles_select_org on company_profiles;
create policy company_profiles_select_org on company_profiles
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists company_profiles_write_admin on company_profiles;
create policy company_profiles_write_admin on company_profiles
for all
using (
  is_admin()
  and organization_id = current_profile_org_id()
)
with check (
  is_admin()
  and organization_id = current_profile_org_id()
);

create table if not exists portal_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  party_type text not null check (party_type in ('customer', 'vendor')),
  party_name text not null,
  email text not null,
  contact_name text not null default '',
  status text not null default 'draft' check (status in ('draft', 'invited', 'active', 'disabled')),
  invite_token text not null unique,
  last_sent_at timestamptz null,
  access_can_view_account boolean not null default true,
  access_can_view_invoices boolean not null default true,
  access_can_view_payments boolean not null default true,
  access_can_view_orders boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_portal_invites_org_party on portal_invites (organization_id, party_type, party_name);
create index if not exists idx_portal_invites_org_email on portal_invites (organization_id, email);

grant select, insert, update, delete
on public.portal_invites
to authenticated;

grant select, insert, update, delete
on public.portal_invites
to service_role;

alter table portal_invites enable row level security;

drop policy if exists portal_invites_select_admin on portal_invites;
create policy portal_invites_select_admin on portal_invites
for select
using (
  is_admin()
  and organization_id = current_profile_org_id()
);

drop policy if exists portal_invites_write_admin on portal_invites;
create policy portal_invites_write_admin on portal_invites
for all
using (
  is_admin()
  and organization_id = current_profile_org_id()
)
with check (
  is_admin()
  and organization_id = current_profile_org_id()
);
