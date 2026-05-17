alter table if exists public.sales_orders
  add column if not exists source_channel text not null default 'internal',
  add column if not exists portal_invite_id uuid references public.portal_invites(id) on delete set null,
  add column if not exists portal_submitted_at timestamptz,
  add column if not exists portal_seen_at timestamptz;

create index if not exists idx_sales_orders_org_source_status
  on public.sales_orders (organization_id, source_channel, status, updated_at desc);

create index if not exists idx_sales_orders_org_portal_seen
  on public.sales_orders (organization_id, portal_seen_at)
  where source_channel = 'portal';
