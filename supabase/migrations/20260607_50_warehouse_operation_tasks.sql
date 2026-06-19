create table if not exists public.warehouse_operation_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  workflow_stage text not null default 'putaway',
  status text not null default 'open',
  priority text not null default 'normal',
  source_document_type text not null default '',
  source_document_id text not null default '',
  source_document_no text not null default '',
  source_line_key text not null default '',
  brand text not null default '',
  product_code text not null default '',
  old_code text not null default '',
  description text not null default '',
  origin text not null default '',
  expected_qty numeric(14,2) not null default 0,
  completed_qty numeric(14,2) not null default 0,
  from_location_code text not null default '',
  from_shelf_address text not null default '',
  from_section_code text not null default '',
  to_location_code text not null default '',
  to_shelf_address text not null default '',
  to_section_code text not null default '',
  task_notes text not null default '',
  completion_notes text not null default '',
  assigned_user_id uuid,
  assigned_user_email text not null default '',
  completed_by_user_id uuid,
  completed_by_email text not null default '',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_warehouse_operation_tasks_unique_line
  on public.warehouse_operation_tasks (organization_id, warehouse_id, workflow_stage, source_document_id, source_line_key);

create index if not exists idx_warehouse_operation_tasks_org_wh_status
  on public.warehouse_operation_tasks (organization_id, warehouse_id, status, updated_at desc);

create index if not exists idx_warehouse_operation_tasks_org_workflow
  on public.warehouse_operation_tasks (organization_id, workflow_stage, updated_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_operation_tasks'::regclass
      and conname = 'warehouse_operation_tasks_workflow_stage_check'
  ) then
    alter table public.warehouse_operation_tasks
      add constraint warehouse_operation_tasks_workflow_stage_check
      check (workflow_stage in ('putaway', 'pick', 'transfer'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_operation_tasks'::regclass
      and conname = 'warehouse_operation_tasks_status_check'
  ) then
    alter table public.warehouse_operation_tasks
      add constraint warehouse_operation_tasks_status_check
      check (status in ('open', 'in_progress', 'completed', 'cancelled'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_operation_tasks'::regclass
      and conname = 'warehouse_operation_tasks_priority_check'
  ) then
    alter table public.warehouse_operation_tasks
      add constraint warehouse_operation_tasks_priority_check
      check (priority in ('low', 'normal', 'high', 'urgent'));
  end if;
end $$;

grant select, insert, update, delete
on public.warehouse_operation_tasks
to authenticated;

grant select, insert, update, delete
on public.warehouse_operation_tasks
to service_role;

alter table public.warehouse_operation_tasks enable row level security;

drop policy if exists warehouse_operation_tasks_select_inventory_users on public.warehouse_operation_tasks;
create policy warehouse_operation_tasks_select_inventory_users on public.warehouse_operation_tasks
for select
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse', 'sales')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_operation_tasks_write_ops_users on public.warehouse_operation_tasks;
create policy warehouse_operation_tasks_write_ops_users on public.warehouse_operation_tasks
for all
using (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() in ('superadmin', 'admin', 'warehouse')
  and organization_id = public.current_profile_org_id()
);
