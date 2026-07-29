-- Provider-fed product identities may be staged for human review without
-- calling validate_catalog_import or finalize_catalog_import.
-- This migration never writes to catalog_products.

alter table public.catalog_import_runs
  drop constraint if exists catalog_import_runs_status_check;

alter table public.catalog_import_runs
  add constraint catalog_import_runs_status_check
  check (status in (
    'running',
    'staged',
    'validating',
    'validated',
    'validation_failed',
    'finalizing',
    'finalized',
    'succeeded',
    'failed',
    'cancelled'
  ));

create or replace function public.seal_catalog_import_stage_only(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run public.catalog_import_runs%rowtype;
  v_total_count integer := 0;
  v_error_count integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can stage catalog data';
  end if;

  if input_run_id is null then
    raise exception 'Catalog import run is required';
  end if;

  select *
    into v_run
  from public.catalog_import_runs
  where id = input_run_id
    and organization_id = v_org_id
  for update;

  if not found then
    raise exception 'Catalog import run was not found';
  end if;

  if v_run.status <> 'running' then
    raise exception 'Catalog import run is not accepting stage-only completion';
  end if;

  select
    count(*)::integer,
    count(*) filter (where validation_status = 'error')::integer
  into v_total_count, v_error_count
  from public.catalog_import_stage
  where run_id = v_run.id
    and organization_id = v_org_id;

  if v_total_count <= 0 then
    raise exception 'Catalog import run has no staged rows';
  end if;

  update public.catalog_import_runs
  set status = 'staged',
      finished_at = now(),
      error_message = null,
      staged_rows = v_total_count,
      valid_rows = 0,
      error_rows = v_error_count,
      duplicate_rows = 0,
      insert_rows = 0,
      update_rows = 0,
      skip_rows = 0,
      processed_rows = v_total_count
  where id = v_run.id;

  return jsonb_build_object(
    'run_id', v_run.id,
    'status', 'staged',
    'staged_count', v_total_count,
    'error_count', v_error_count,
    'total_count', v_total_count
  );
end;
$$;

revoke all on function public.seal_catalog_import_stage_only(uuid) from public, anon;
grant execute on function public.seal_catalog_import_stage_only(uuid) to authenticated;

comment on function public.seal_catalog_import_stage_only(uuid) is
  'Closes a provider import at the review-stage boundary. It never validates or finalizes catalog_products.';
