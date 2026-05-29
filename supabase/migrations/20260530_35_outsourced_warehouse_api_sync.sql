alter table public.warehouses
  add column if not exists warehouse_kind text not null default 'internal',
  add column if not exists outsource_partner_name text not null default '',
  add column if not exists external_sync_enabled boolean not null default false,
  add column if not exists external_api_provider text not null default '',
  add column if not exists external_api_url text not null default '',
  add column if not exists external_location_code text not null default '',
  add column if not exists external_auth_type text not null default 'none',
  add column if not exists external_api_token_env text not null default '',
  add column if not exists external_last_sync_at timestamptz,
  add column if not exists external_last_sync_status text not null default '',
  add column if not exists external_last_sync_message text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouses'::regclass
      and conname = 'warehouses_kind_check'
  ) then
    alter table public.warehouses
      add constraint warehouses_kind_check
      check (warehouse_kind in ('internal', 'outsourced'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouses'::regclass
      and conname = 'warehouses_external_auth_type_check'
  ) then
    alter table public.warehouses
      add constraint warehouses_external_auth_type_check
      check (external_auth_type in ('none', 'bearer_env'));
  end if;
end $$;

create table if not exists public.warehouse_external_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  outsource_partner_name text not null default '',
  external_api_provider text not null default '',
  request_url text not null default '',
  status text not null default 'started',
  fetched_item_count integer not null default 0,
  accepted_item_count integer not null default 0,
  adjustment_count integer not null default 0,
  zeroed_item_count integer not null default 0,
  invalid_item_count integer not null default 0,
  message text not null default '',
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_external_sync_runs'::regclass
      and conname = 'warehouse_external_sync_runs_status_check'
  ) then
    alter table public.warehouse_external_sync_runs
      add constraint warehouse_external_sync_runs_status_check
      check (status in ('started', 'success', 'failed'));
  end if;
end $$;

create index if not exists idx_warehouse_external_sync_runs_org_started
  on public.warehouse_external_sync_runs (organization_id, started_at desc);

create index if not exists idx_warehouse_external_sync_runs_org_warehouse
  on public.warehouse_external_sync_runs (organization_id, warehouse_id, started_at desc);

grant select, insert, update, delete
on public.warehouse_external_sync_runs
to authenticated;

grant select, insert, update, delete
on public.warehouse_external_sync_runs
to service_role;

alter table public.warehouse_external_sync_runs enable row level security;

drop policy if exists warehouse_external_sync_runs_select_admin on public.warehouse_external_sync_runs;
create policy warehouse_external_sync_runs_select_admin on public.warehouse_external_sync_runs
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_external_sync_runs_write_admin on public.warehouse_external_sync_runs;
create policy warehouse_external_sync_runs_write_admin on public.warehouse_external_sync_runs
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);
