alter table public.inventory_movements
  add column if not exists shelf_address text not null default '',
  add column if not exists section_code text not null default '';

create index if not exists idx_inventory_movements_org_location
  on public.inventory_movements (organization_id, warehouse_id, shelf_address, section_code, moved_at desc);
