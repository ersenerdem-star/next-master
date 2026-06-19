create table if not exists public.warehouse_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  location_code text not null default '',
  normalized_location_code text not null default '',
  location_barcode text not null default '',
  normalized_location_barcode text not null default '',
  zone_code text not null default '',
  aisle_code text not null default '',
  rack_code text not null default '',
  level_code text not null default '',
  bin_code text not null default '',
  shelf_address text not null default '',
  section_code text not null default '',
  location_type text not null default 'pick_face',
  pick_sequence integer not null default 0,
  capacity_volume_m3 numeric(14,4) not null default 0,
  capacity_weight_kg numeric(14,4) not null default 0,
  is_active boolean not null default true,
  is_default_pick_face boolean not null default false,
  allow_mixed_sku boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_warehouse_locations_org_wh_code
  on public.warehouse_locations (organization_id, warehouse_id, normalized_location_code);

create unique index if not exists idx_warehouse_locations_org_barcode
  on public.warehouse_locations (organization_id, normalized_location_barcode)
  where normalized_location_barcode <> '';

create index if not exists idx_warehouse_locations_org_wh_type_seq
  on public.warehouse_locations (organization_id, warehouse_id, location_type, pick_sequence, updated_at desc);

create index if not exists idx_warehouse_locations_org_wh_address
  on public.warehouse_locations (organization_id, warehouse_id, shelf_address, section_code);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_locations'::regclass
      and conname = 'warehouse_locations_location_type_check'
  ) then
    alter table public.warehouse_locations
      add constraint warehouse_locations_location_type_check
      check (location_type in ('pick_face', 'reserve', 'bulk', 'staging', 'dock', 'quarantine', 'returns'));
  end if;
end $$;

grant select, insert, update, delete
on public.warehouse_locations
to authenticated;

grant select, insert, update, delete
on public.warehouse_locations
to service_role;

alter table public.warehouse_locations enable row level security;

drop policy if exists warehouse_locations_select_inventory_users on public.warehouse_locations;
create policy warehouse_locations_select_inventory_users on public.warehouse_locations
for select
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse', 'sales')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_locations_write_ops_users on public.warehouse_locations;
create policy warehouse_locations_write_ops_users on public.warehouse_locations
for all
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
);
