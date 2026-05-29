alter table customers
add column if not exists seller_company_profile_id uuid null references company_profiles(id) on delete set null;

create index if not exists idx_customers_org_seller_company_profile
on customers (organization_id, seller_company_profile_id);
