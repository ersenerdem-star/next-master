create table if not exists public.inventory_barcode_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  barcode text not null default '',
  normalized_barcode text not null default '',
  brand text not null default '',
  product_code text not null default '',
  old_code text not null default '',
  description text not null default '',
  source text not null default 'manual_bind',
  created_by_user_id uuid,
  created_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_inventory_barcode_aliases_org_normalized
  on public.inventory_barcode_aliases (organization_id, normalized_barcode);

create index if not exists idx_inventory_barcode_aliases_org_code
  on public.inventory_barcode_aliases (organization_id, product_code, old_code);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.inventory_barcode_aliases'::regclass
      and conname = 'inventory_barcode_aliases_source_check'
  ) then
    alter table public.inventory_barcode_aliases
      add constraint inventory_barcode_aliases_source_check
      check (source in ('manual_bind'));
  end if;
end $$;

create table if not exists public.inventory_manual_entry_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id uuid references public.warehouses(id) on delete set null,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  workflow_stage text not null default 'receive',
  document_type text not null default '',
  document_id text not null default '',
  document_no text not null default '',
  line_key text not null default '',
  barcode text not null default '',
  normalized_barcode text not null default '',
  brand text not null default '',
  product_code text not null default '',
  old_code text not null default '',
  description text not null default '',
  entry_mode text not null default 'manual_barcode_bind',
  notes text not null default '',
  entered_by_user_id uuid,
  entered_by_email text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_inventory_manual_entry_alerts_org_created
  on public.inventory_manual_entry_alerts (organization_id, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.inventory_manual_entry_alerts'::regclass
      and conname = 'inventory_manual_entry_alerts_entry_mode_check'
  ) then
    alter table public.inventory_manual_entry_alerts
      add constraint inventory_manual_entry_alerts_entry_mode_check
      check (entry_mode in ('manual_barcode_bind'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.inventory_manual_entry_alerts'::regclass
      and conname = 'inventory_manual_entry_alerts_workflow_stage_check'
  ) then
    alter table public.inventory_manual_entry_alerts
      add constraint inventory_manual_entry_alerts_workflow_stage_check
      check (workflow_stage in ('receive', 'packing', 'shipment'));
  end if;
end $$;

grant select, insert, update, delete
on public.inventory_barcode_aliases
to authenticated;

grant select, insert, update, delete
on public.inventory_barcode_aliases
to service_role;

grant select, insert, update, delete
on public.inventory_manual_entry_alerts
to authenticated;

grant select, insert, update, delete
on public.inventory_manual_entry_alerts
to service_role;

alter table public.inventory_barcode_aliases enable row level security;
alter table public.inventory_manual_entry_alerts enable row level security;

drop policy if exists inventory_barcode_aliases_select_inventory_users on public.inventory_barcode_aliases;
create policy inventory_barcode_aliases_select_inventory_users on public.inventory_barcode_aliases
for select
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse', 'sales')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_barcode_aliases_write_ops_users on public.inventory_barcode_aliases;
create policy inventory_barcode_aliases_write_ops_users on public.inventory_barcode_aliases
for all
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_manual_entry_alerts_select_admin_users on public.inventory_manual_entry_alerts;
create policy inventory_manual_entry_alerts_select_admin_users on public.inventory_manual_entry_alerts
for select
using (
  public.current_profile_role() in ('superadmin', 'admin')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_manual_entry_alerts_insert_ops_users on public.inventory_manual_entry_alerts;
create policy inventory_manual_entry_alerts_insert_ops_users on public.inventory_manual_entry_alerts
for insert
with check (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
);
