create extension if not exists pgcrypto;

alter table public.portal_invites
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null,
  add column if not exists invite_token_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists last_used_at timestamptz;

alter table public.portal_invites
  alter column invite_token drop not null;

create index if not exists idx_portal_invites_org_customer_id on public.portal_invites (organization_id, customer_id);
create index if not exists idx_portal_invites_org_vendor_id on public.portal_invites (organization_id, vendor_id);
create index if not exists idx_portal_invites_email_token_hash on public.portal_invites (email, invite_token_hash);
create index if not exists idx_portal_invites_expires_at on public.portal_invites (expires_at);

update public.portal_invites pi
set customer_id = c.id
from public.customers c
where pi.customer_id is null
  and pi.party_type = 'customer'
  and c.organization_id = pi.organization_id
  and (
    lower(coalesce(c.display_name, '')) = lower(pi.party_name)
    or lower(coalesce(c.company_name, '')) = lower(pi.party_name)
  );

update public.portal_invites pi
set vendor_id = v.id
from public.vendors v
where pi.vendor_id is null
  and pi.party_type = 'vendor'
  and v.organization_id = pi.organization_id
  and (
    lower(coalesce(v.display_name, '')) = lower(pi.party_name)
    or lower(coalesce(v.company_name, '')) = lower(pi.party_name)
  );

update public.portal_invites
set invite_token_hash = encode(digest(invite_token, 'sha256'), 'hex')
where coalesce(invite_token, '') <> ''
  and coalesce(invite_token_hash, '') = '';

update public.portal_invites
set expires_at = coalesce(expires_at, now() + interval '14 days')
where coalesce(invite_token_hash, '') <> '';

update public.portal_invites
set invite_token = null
where coalesce(invite_token, '') <> '';

alter table public.sales_orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

alter table public.invoices
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

alter table public.payments_received
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

alter table public.purchase_orders
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

alter table public.bills
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

alter table public.payments_made
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

create index if not exists idx_sales_orders_org_customer_id on public.sales_orders (organization_id, customer_id);
create index if not exists idx_invoices_org_customer_id on public.invoices (organization_id, customer_id);
create index if not exists idx_payments_received_org_customer_id on public.payments_received (organization_id, customer_id);
create index if not exists idx_purchase_orders_org_vendor_id on public.purchase_orders (organization_id, vendor_id);
create index if not exists idx_bills_org_vendor_id on public.bills (organization_id, vendor_id);
create index if not exists idx_payments_made_org_vendor_id on public.payments_made (organization_id, vendor_id);

update public.sales_orders so
set customer_id = c.id
from public.customers c
where so.customer_id is null
  and c.organization_id = so.organization_id
  and (
    lower(coalesce(c.display_name, '')) = lower(so.customer_name)
    or lower(coalesce(c.company_name, '')) = lower(so.customer_name)
  );

update public.invoices i
set customer_id = c.id
from public.customers c
where i.customer_id is null
  and c.organization_id = i.organization_id
  and (
    lower(coalesce(c.display_name, '')) = lower(i.customer_name)
    or lower(coalesce(c.company_name, '')) = lower(i.customer_name)
  );

update public.payments_received pr
set customer_id = c.id
from public.customers c
where pr.customer_id is null
  and c.organization_id = pr.organization_id
  and (
    lower(coalesce(c.display_name, '')) = lower(pr.customer_name)
    or lower(coalesce(c.company_name, '')) = lower(pr.customer_name)
  );

update public.purchase_orders po
set vendor_id = v.id
from public.vendors v
where po.vendor_id is null
  and v.organization_id = po.organization_id
  and (
    lower(coalesce(v.display_name, '')) = lower(po.supplier_name)
    or lower(coalesce(v.company_name, '')) = lower(po.supplier_name)
  );

update public.bills b
set vendor_id = v.id
from public.vendors v
where b.vendor_id is null
  and v.organization_id = b.organization_id
  and (
    lower(coalesce(v.display_name, '')) = lower(b.supplier_name)
    or lower(coalesce(v.company_name, '')) = lower(b.supplier_name)
  );

update public.payments_made pm
set vendor_id = v.id
from public.vendors v
where pm.vendor_id is null
  and v.organization_id = pm.organization_id
  and (
    lower(coalesce(v.display_name, '')) = lower(pm.supplier_name)
    or lower(coalesce(v.company_name, '')) = lower(pm.supplier_name)
  );
