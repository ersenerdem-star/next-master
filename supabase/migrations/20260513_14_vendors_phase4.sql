create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vendor_type text not null default 'Business',
  salutation text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  company_name text not null default '',
  display_name text not null default '',
  email text not null default '',
  vendor_number text not null,
  work_phone text not null default '',
  mobile_phone text not null default '',
  language text not null default 'English',
  tax_rate text not null default '',
  company_id text not null default '',
  currency text not null default 'EUR',
  payment_terms text not null default 'Cash in Advance',
  billing_address text not null default '',
  shipping_address text not null default '',
  contact_persons text not null default '',
  custom_fields text not null default '',
  reporting_tags text not null default '',
  remarks text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, vendor_number)
);

create index if not exists idx_vendors_org_display_name on vendors (organization_id, display_name);
create index if not exists idx_vendors_org_company_name on vendors (organization_id, company_name);

grant select, insert, update, delete
on public.vendors
to authenticated;

grant select, insert, update, delete
on public.vendors
to service_role;

alter table vendors enable row level security;

drop policy if exists vendors_select_org on vendors;
create policy vendors_select_org on vendors
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists vendors_write_org on vendors;
create policy vendors_write_org on vendors
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
