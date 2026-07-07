-- Slice 4 for catalog import finalization.
-- Validated staged rows are applied into catalog truth inside one transaction.
-- API/UI/Gateway switching happens later.

alter table public.catalog_import_runs
  drop constraint if exists catalog_import_runs_status_check;

alter table public.catalog_import_runs
  add constraint catalog_import_runs_status_check
    check (
      status in (
        'running',
        'validating',
        'validated',
        'validation_failed',
        'finalizing',
        'finalized',
        'finalize_failed',
        'failed',
        'cancelled'
      )
    );

alter table public.catalog_import_runs
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid,
  add column if not exists inserted_count integer not null default 0,
  add column if not exists updated_count integer not null default 0,
  add column if not exists skipped_count integer not null default 0;

drop function if exists public.finalize_catalog_import(uuid);

create or replace function public.finalize_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_org_id uuid;
  v_run public.catalog_import_runs%rowtype;
  v_brand_count integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_error_count integer := 0;
  v_finalized_by uuid := auth.uid();
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import catalog data';
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

  if v_run.status = 'finalized' then
    raise exception 'Catalog import run has already been finalized';
  end if;

  if v_run.status <> 'validated' then
    raise exception 'Catalog import run cannot be finalized from status %', v_run.status;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_run.organization_id::text || ':' || v_run.id::text || ':catalog_import_finalize', 0)
  );

  begin
    update public.catalog_import_runs
    set status = 'finalizing',
        error_message = null
    where id = v_run.id;

    select count(*)::integer
      into v_error_count
    from public.catalog_import_stage s
    where s.run_id = v_run.id
      and s.organization_id = v_org_id
      and s.validation_status = 'error';

    if v_error_count > 0 then
      raise exception 'Catalog import run still has validation errors';
    end if;

    insert into public.brands (organization_id, name)
    select distinct v_org_id, coalesce(nullif(trim(s.brand), ''), 'Unbranded')
    from public.catalog_import_stage s
    where s.run_id = v_run.id
      and s.organization_id = v_org_id
      and nullif(trim(coalesce(s.brand, '')), '') is not null
    on conflict (organization_id, normalized_name) do nothing;

    with ordered_stage_rows as (
      select
        s.*,
        b.id as brand_id,
        b.name as matched_brand_name,
        cp.id as existing_product_id,
        cp.brand_id as existing_brand_id,
        cp.product_code as existing_product_code,
        cp.normalized_code as existing_normalized_code,
        cp.description as existing_description,
        cp.oem_no as existing_oem_no,
        cp.hs_code as existing_hs_code,
        cp.origin as existing_origin,
        cp.weight_kg as existing_weight_kg,
        cp.image_url as existing_image_url,
        cp.lifecycle_status as existing_lifecycle_status,
        cp.lifecycle_note as existing_lifecycle_note,
        cp.notes as existing_notes,
        cp.vehicle as existing_vehicle,
        cp.market_segment as existing_market_segment
      from public.catalog_import_stage s
      left join public.brands b
        on b.organization_id = v_org_id
       and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
      left join public.catalog_products cp
        on cp.organization_id = v_org_id
       and cp.brand_id = b.id
       and cp.normalized_code = s.normalized_code
      where s.run_id = v_run.id
        and s.organization_id = v_org_id
        and s.validation_status = 'valid'
        and s.proposed_action in ('insert', 'update', 'skip')
      order by s.row_index asc, s.created_at asc, s.id asc
    ),
    inserted_rows as (
    insert into public.catalog_products (
        organization_id,
        brand_id,
        product_code,
        description,
        oem_no,
        hs_code,
        origin,
        weight_kg,
        image_url,
        lifecycle_status,
        lifecycle_note
      )
      select
        v_org_id,
        osr.brand_id,
        osr.product_code,
        nullif(trim(coalesce(osr.description, '')), ''),
        nullif(trim(coalesce(osr.oem_no, '')), ''),
        nullif(trim(coalesce(osr.hs_code, '')), ''),
        nullif(trim(coalesce(osr.origin, '')), ''),
        osr.weight_kg,
        nullif(trim(coalesce(osr.image_url, '')), ''),
        coalesce(nullif(trim(coalesce(osr.lifecycle_status, '')), ''), 'active'),
        nullif(trim(coalesce(osr.lifecycle_note, '')), '')
      from ordered_stage_rows osr
      where osr.proposed_action = 'insert'
      on conflict (organization_id, brand_id, normalized_code) do nothing
      returning 1
    ),
    updated_rows as (
      update public.catalog_products cp
      set description = coalesce(nullif(trim(coalesce(osr.description, '')), ''), cp.description),
          oem_no = coalesce(nullif(trim(coalesce(osr.oem_no, '')), ''), cp.oem_no),
          hs_code = coalesce(nullif(trim(coalesce(osr.hs_code, '')), ''), cp.hs_code),
          origin = coalesce(nullif(trim(coalesce(osr.origin, '')), ''), cp.origin),
          weight_kg = coalesce(osr.weight_kg, cp.weight_kg),
          image_url = coalesce(nullif(trim(coalesce(osr.image_url, '')), ''), cp.image_url),
          lifecycle_status = coalesce(nullif(trim(coalesce(osr.lifecycle_status, '')), ''), cp.lifecycle_status),
          lifecycle_note = coalesce(nullif(trim(coalesce(osr.lifecycle_note, '')), ''), cp.lifecycle_note),
          updated_at = now()
      from ordered_stage_rows osr
      where osr.proposed_action = 'update'
        and cp.organization_id = v_org_id
        and cp.id = osr.existing_product_id
        and cp.brand_id = osr.brand_id
        and cp.normalized_code = osr.normalized_code
        and (
          cp.description is distinct from coalesce(nullif(trim(coalesce(osr.description, '')), ''), cp.description)
          or cp.oem_no is distinct from coalesce(nullif(trim(coalesce(osr.oem_no, '')), ''), cp.oem_no)
          or cp.hs_code is distinct from coalesce(nullif(trim(coalesce(osr.hs_code, '')), ''), cp.hs_code)
          or cp.origin is distinct from coalesce(nullif(trim(coalesce(osr.origin, '')), ''), cp.origin)
          or cp.weight_kg is distinct from coalesce(osr.weight_kg, cp.weight_kg)
          or cp.image_url is distinct from coalesce(nullif(trim(coalesce(osr.image_url, '')), ''), cp.image_url)
          or cp.lifecycle_status is distinct from coalesce(nullif(trim(coalesce(osr.lifecycle_status, '')), ''), cp.lifecycle_status)
          or cp.lifecycle_note is distinct from coalesce(nullif(trim(coalesce(osr.lifecycle_note, '')), ''), cp.lifecycle_note)
        )
      returning 1
    ),
    skipped_rows as (
      select 1
      from ordered_stage_rows osr
      where osr.proposed_action = 'skip'
    )
    select
      (select count(*)::integer from inserted_rows),
      (select count(*)::integer from updated_rows),
      (select count(*)::integer from skipped_rows)
    into v_inserted, v_updated, v_skipped;

    update public.catalog_import_runs
    set status = 'finalized',
        finalized_at = now(),
        finalized_by = coalesce(v_finalized_by, finalized_by, created_by),
        finished_at = now(),
        error_message = null,
        inserted_count = v_inserted,
        updated_count = v_updated,
        skipped_count = v_skipped,
        error_rows = 0,
        insert_rows = v_inserted,
        update_rows = v_updated,
        skip_rows = v_skipped,
        processed_rows = v_inserted + v_updated + v_skipped
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'finalized',
      'run_id', v_run.id,
      'inserted_count', v_inserted,
      'updated_count', v_updated,
      'skipped_count', v_skipped,
      'error_count', 0
    );
  exception
    when others then
      update public.catalog_import_runs
      set status = 'finalize_failed',
          finished_at = now(),
          error_message = sqlerrm
      where id = v_run.id;
      raise;
  end;
end;
$$;

grant execute on function public.finalize_catalog_import(uuid) to authenticated;
grant execute on function public.finalize_catalog_import(uuid) to service_role;
