-- Import queue contract: HTTP requests only stage/queue work.  A scheduled
-- worker resumes validation, publication and supplier sync in bounded batches.
-- The queue marker is idempotent so a browser retry cannot create duplicate work.

alter table public.catalog_import_runs
  add column if not exists processing_queued_at timestamptz,
  add column if not exists processing_queued_by uuid;

alter table public.supplier_price_import_runs
  add column if not exists processing_queued_at timestamptz,
  add column if not exists processing_queued_by uuid;

create index if not exists idx_catalog_import_runs_processing_queue
  on public.catalog_import_runs (processing_queued_at, started_at)
  where processing_queued_at is not null;

create index if not exists idx_supplier_price_import_runs_processing_queue
  on public.supplier_price_import_runs (processing_queued_at, started_at)
  where processing_queued_at is not null;

create or replace function public.mark_catalog_import_processing_queued(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_run public.catalog_import_runs%rowtype;
begin
  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admins can queue catalog imports';
  end if;

  select * into v_run
  from public.catalog_import_runs
  where id = input_run_id and organization_id = v_org_id
  for update;

  if not found then raise exception 'Catalog import run was not found'; end if;
  if v_run.status in ('failed', 'cancelled', 'finalized') then
    raise exception 'Catalog import run cannot be queued from status %', v_run.status;
  end if;

  update public.catalog_import_runs
  set processing_queued_at = coalesce(processing_queued_at, now()),
      processing_queued_by = coalesce(processing_queued_by, auth.uid())
  where id = v_run.id and organization_id = v_org_id;

  return jsonb_build_object('queued', true, 'run_id', v_run.id,
    'status', v_run.status, 'organization_id', v_org_id);
end;
$$;

revoke all on function public.mark_catalog_import_processing_queued(uuid) from public, anon;
grant execute on function public.mark_catalog_import_processing_queued(uuid) to authenticated;

create or replace function public.validate_catalog_import_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_org uuid;
  v_actor_role text;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;

  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System validation actor is not an active organization admin';
  end if;

  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  return public.validate_catalog_import(input_run_id);
end;
$$;

revoke all on function public.validate_catalog_import_system(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.validate_catalog_import_system(uuid, uuid, uuid) to service_role;

create or replace function public.mark_supplier_price_import_processing_queued(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_run public.supplier_price_import_runs%rowtype;
begin
  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admins can queue supplier imports';
  end if;

  select * into v_run
  from public.supplier_price_import_runs
  where id = input_run_id and organization_id = v_org_id
  for update;

  if not found then raise exception 'Supplier import run was not found'; end if;
  if v_run.status in ('failed', 'succeeded', 'finalized') then
    raise exception 'Supplier import run cannot be queued from status %', v_run.status;
  end if;

  update public.supplier_price_import_runs
  set processing_queued_at = coalesce(processing_queued_at, now()),
      processing_queued_by = coalesce(processing_queued_by, auth.uid())
  where id = v_run.id and organization_id = v_org_id;

  return jsonb_build_object('queued', true, 'run_id', v_run.id,
    'status', v_run.status, 'organization_id', v_org_id);
end;
$$;

revoke all on function public.mark_supplier_price_import_processing_queued(uuid) from public, anon;
grant execute on function public.mark_supplier_price_import_processing_queued(uuid) to authenticated;

create or replace function public.finalize_supplier_price_import_batch_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_batch_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_org uuid;
  v_actor_role text;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System supplier finalization actor is not an active organization admin';
  end if;
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  return public.finalize_supplier_price_import_batch(input_run_id, input_batch_size);
end;
$$;

revoke all on function public.finalize_supplier_price_import_batch_system(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.finalize_supplier_price_import_batch_system(uuid, uuid, uuid, integer) to service_role;

create or replace function public.sync_supplier_price_catalog_from_import_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_org uuid;
  v_actor_role text;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System supplier sync actor is not an active organization admin';
  end if;
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  return public.sync_supplier_price_catalog_from_import(input_run_id);
end;
$$;

revoke all on function public.sync_supplier_price_catalog_from_import_system(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.sync_supplier_price_catalog_from_import_system(uuid, uuid, uuid) to service_role;
