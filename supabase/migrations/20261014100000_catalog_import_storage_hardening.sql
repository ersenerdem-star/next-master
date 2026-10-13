-- Lifecycle hardening for the private catalog source pipeline.
-- Browser admission failures are terminal and clean up the private object;
-- successful queue finalization retires the source so the worker cannot poll it
-- forever after the run has completed.

alter table public.catalog_import_sources
  drop constraint if exists catalog_import_sources_status_check;

alter table public.catalog_import_sources
  add constraint catalog_import_sources_status_check
  check (status in ('created','uploading','uploaded','processing','staged','completed','failed','expired','cancelled'));

create or replace function public.fail_catalog_import_storage_upload(
  input_run_id uuid,
  input_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid := public.current_profile_org_id();
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_message text := left(nullif(trim(coalesce(input_message, '')), ''), 2000);
begin
  if v_actor is null or v_org is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can fail catalog storage uploads';
  end if;

  select * into v_source
  from public.catalog_import_sources
  where run_id = input_run_id
    and organization_id = v_org
    and created_by = v_actor
  for update;

  if not found then
    raise exception 'Catalog storage source was not found';
  end if;

  select * into v_run
  from public.catalog_import_runs
  where id = v_source.run_id
    and organization_id = v_org
  for update;

  if v_run.status in ('failed','cancelled','finalized','succeeded')
     or v_source.status in ('failed','cancelled','completed') then
    return jsonb_build_object(
      'status', v_run.status,
      'run_id', v_run.id,
      'source_id', v_source.id,
      'cleaned', false,
      'replayed', true
    );
  end if;

  -- The function is security definer and owns the private bucket cleanup;
  -- browser callers never receive a service-role or Storage delete capability.
  delete from storage.objects
  where bucket_id = v_source.storage_bucket
    and name = v_source.storage_object_path;

  update public.catalog_import_sources
  set status = 'failed',
      failed_at = now(),
      error_code = 'CATALOG_STORAGE_UPLOAD_FAILED',
      error_message = v_message,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = v_source.id;

  update public.catalog_import_runs
  set processing_queued_at = null,
      processing_queued_by = null
  where id = v_run.id
    and organization_id = v_org;

  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform public.fail_catalog_import(v_run.id, coalesce(v_message, 'Catalog storage upload failed'));

  return jsonb_build_object(
    'status', 'failed',
    'run_id', v_run.id,
    'source_id', v_source.id,
    'cleaned', true
  );
end;
$$;

revoke all on function public.fail_catalog_import_storage_upload(uuid,text)
  from public, anon;
grant execute on function public.fail_catalog_import_storage_upload(uuid,text)
  to authenticated;

create or replace function public.finalize_catalog_import_batch_system(
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
  v_result jsonb;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System finalization actor is not an active organization admin';
  end if;
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  -- Preserve the cursor-native finalizer already present in staging. The
  -- Storage source must never switch the queue back to the old monolithic RPC.
  v_result := public.finalize_catalog_import_batch(
    input_run_id,
    greatest(1, least(coalesce(input_batch_size, 500), 1000))
  );

  -- The old finalizer does the canonical write. Retire only the corresponding
  -- Storage source after that write succeeds; no source is retired early.
  if coalesce(v_result ->> 'has_more', 'true') = 'false'
     and coalesce(v_result ->> 'status', '') in ('finalized', 'succeeded') then
    update public.catalog_import_sources
    set status = 'completed',
        completed_at = coalesce(completed_at, now()),
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where run_id = input_run_id
      and organization_id = input_organization_id
      and status in ('uploaded','processing','staged');
  end if;

  return v_result || jsonb_build_object(
    'batch_size', greatest(1, least(coalesce(input_batch_size, 500), 1000))
  );
end;
$$;

revoke all on function public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer)
  to service_role;
