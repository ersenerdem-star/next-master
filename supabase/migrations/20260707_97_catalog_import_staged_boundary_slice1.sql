-- Catalog CSV imports now have an explicit run/stage boundary.
-- Slice 1 creates the operational storage plus begin/fail/cancel lifecycle RPCs.
-- Stage chunk, validation, and finalize behavior are implemented in later slices.

create table if not exists public.catalog_import_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mode text not null default 'upsert',
  status text not null default 'running',
  input_scope jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  staged_rows integer not null default 0,
  valid_rows integer not null default 0,
  error_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  insert_rows integer not null default 0,
  update_rows integer not null default 0,
  skip_rows integer not null default 0,
  processed_rows integer,
  created_by uuid default auth.uid(),
  constraint catalog_import_runs_mode_check
    check (mode in ('insert_only', 'upsert')),
  constraint catalog_import_runs_status_check
    check (status in ('running', 'validating', 'validated', 'finalizing', 'succeeded', 'failed', 'cancelled'))
);

create table if not exists public.catalog_import_stage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.catalog_import_runs(id) on delete cascade,
  row_index integer not null,
  brand text,
  product_code text,
  normalized_code text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  image_url text,
  lifecycle_status text,
  lifecycle_note text,
  validation_status text not null default 'pending',
  validation_message text,
  conflict_summary jsonb not null default '{}'::jsonb,
  proposed_action text,
  created_at timestamptz not null default now(),
  constraint catalog_import_stage_validation_status_check
    check (validation_status in ('pending', 'valid', 'error')),
  constraint catalog_import_stage_proposed_action_check
    check (proposed_action is null or proposed_action in ('insert', 'update', 'skip', 'error'))
);

create index if not exists idx_catalog_import_runs_org_started
  on public.catalog_import_runs (organization_id, started_at desc);

create index if not exists idx_catalog_import_runs_org_status
  on public.catalog_import_runs (organization_id, status, started_at desc);

create index if not exists idx_catalog_import_stage_run
  on public.catalog_import_stage (run_id);

create index if not exists idx_catalog_import_stage_run_row
  on public.catalog_import_stage (run_id, row_index);

create index if not exists idx_catalog_import_stage_run_code
  on public.catalog_import_stage (run_id, normalized_code)
  where normalized_code is not null and normalized_code <> '';

alter table public.catalog_import_runs enable row level security;
alter table public.catalog_import_stage enable row level security;

drop policy if exists catalog_import_runs_select_ops
on public.catalog_import_runs;

create policy catalog_import_runs_select_ops
on public.catalog_import_runs
for select
using (
  organization_id = public.current_profile_org_id()
  and public.current_profile_role() in ('admin', 'superadmin')
);

drop policy if exists catalog_import_stage_select_ops
on public.catalog_import_stage;

create policy catalog_import_stage_select_ops
on public.catalog_import_stage
for select
using (
  organization_id = public.current_profile_org_id()
  and public.current_profile_role() in ('admin', 'superadmin')
);

grant select on public.catalog_import_runs to authenticated;
grant select on public.catalog_import_stage to authenticated;
grant select on public.catalog_import_runs to service_role;
grant select on public.catalog_import_stage to service_role;

drop function if exists public.begin_catalog_import(jsonb, text);

create or replace function public.begin_catalog_import(
  input_scope jsonb default '{}'::jsonb,
  input_mode text default 'upsert'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_mode text := lower(nullif(trim(coalesce(input_mode, '')), ''));
  v_scope jsonb := coalesce(input_scope, '{}'::jsonb);
  v_run_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import catalog data';
  end if;

  if v_mode is null then
    v_mode := 'upsert';
  end if;

  if v_mode = 'insert' then
    v_mode := 'insert_only';
  end if;

  if v_mode not in ('insert_only', 'upsert') then
    raise exception 'Catalog import mode must be insert_only or upsert';
  end if;

  if jsonb_typeof(v_scope) is distinct from 'object' then
    raise exception 'Catalog import scope must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_org_id::text || ':catalog_import', 0)
  );

  if exists (
    select 1
    from public.catalog_import_runs r
    where r.organization_id = v_org_id
      and r.status in ('running', 'validating', 'validated', 'finalizing')
  ) then
    raise exception 'Another catalog import is already running.';
  end if;

  insert into public.catalog_import_runs (
    organization_id,
    mode,
    status,
    input_scope
  )
  values (
    v_org_id,
    v_mode,
    'running',
    v_scope
  )
  returning id into v_run_id;

  return jsonb_build_object(
    'status', 'running',
    'run_id', v_run_id,
    'organization_id', v_org_id,
    'mode', v_mode,
    'input_scope', v_scope
  );
end;
$$;

grant execute on function public.begin_catalog_import(jsonb, text) to authenticated;
grant execute on function public.begin_catalog_import(jsonb, text) to service_role;

drop function if exists public.fail_catalog_import(uuid, text);

create or replace function public.fail_catalog_import(
  run_id uuid,
  message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import catalog data';
  end if;

  update public.catalog_import_runs
  set status = 'failed',
      finished_at = now(),
      error_message = nullif(trim(coalesce(message, '')), '')
  where id = run_id
    and organization_id = v_org_id
    and status in ('running', 'validating', 'validated', 'finalizing')
  returning id into v_run_id;

  if v_run_id is null then
    raise exception 'Catalog import run was not found or cannot be failed';
  end if;

  return jsonb_build_object(
    'status', 'failed',
    'run_id', v_run_id
  );
end;
$$;

grant execute on function public.fail_catalog_import(uuid, text) to authenticated;
grant execute on function public.fail_catalog_import(uuid, text) to service_role;

drop function if exists public.cancel_catalog_import(uuid);

create or replace function public.cancel_catalog_import(run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import catalog data';
  end if;

  update public.catalog_import_runs
  set status = 'cancelled',
      finished_at = now(),
      error_message = null
  where id = run_id
    and organization_id = v_org_id
    and status in ('running', 'validating', 'validated', 'finalizing')
  returning id into v_run_id;

  if v_run_id is null then
    raise exception 'Catalog import run was not found or cannot be cancelled';
  end if;

  return jsonb_build_object(
    'status', 'cancelled',
    'run_id', v_run_id
  );
end;
$$;

grant execute on function public.cancel_catalog_import(uuid) to authenticated;
grant execute on function public.cancel_catalog_import(uuid) to service_role;
