-- NM-CATALOG-WP2-F2-H3-DB: quarantine staged import images.
-- Import may continue to finalize permitted catalog fields, but it cannot
-- write catalog_products.image_url until a separately approved source-fill path exists.

alter table public.catalog_import_runs
  add column if not exists image_quarantined_count integer not null default 0;

alter function public.validate_catalog_import(uuid)
  rename to validate_catalog_import_pre_h3;

create or replace function public.validate_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_org_id uuid;
  v_total integer := 0;
  v_insert integer := 0;
  v_update integer := 0;
  v_skip integer := 0;
  v_error integer := 0;
  v_duplicate integer := 0;
  v_image_quarantined integer := 0;
begin
  v_result := public.validate_catalog_import_pre_h3(input_run_id);
  v_org_id := public.current_profile_org_id();

  update public.catalog_import_stage s
  set conflict_summary = jsonb_set(
        jsonb_set(
          jsonb_set(
            coalesce(s.conflict_summary, '{}'::jsonb),
            '{changed_fields}',
            to_jsonb(array(
              select value
              from jsonb_array_elements_text(coalesce(s.conflict_summary->'changed_fields', '[]'::jsonb)) as f(value)
              where value <> 'image_url'
            )),
            true
          ),
          '{field_deltas}',
          coalesce(s.conflict_summary->'field_deltas', '{}'::jsonb) - 'image_url',
          true
        ),
        '{image_url_quarantined}',
        to_jsonb(nullif(trim(coalesce(s.image_url, '')), '') is not null),
        true
      )
  where s.run_id = input_run_id
    and s.organization_id = v_org_id;

  update public.catalog_import_stage s
  set proposed_action = 'skip',
      validation_message = 'Staged image_url is quarantined; no canonical Product field change remains'
  where s.run_id = input_run_id
    and s.organization_id = v_org_id
    and s.validation_status = 'valid'
    and s.proposed_action = 'update'
    and jsonb_array_length(coalesce(s.conflict_summary->'changed_fields', '[]'::jsonb)) = 0;

  select
    count(*)::integer,
    count(*) filter (where proposed_action = 'insert')::integer,
    count(*) filter (where proposed_action = 'update')::integer,
    count(*) filter (where proposed_action = 'skip')::integer,
    count(*) filter (where validation_status = 'error')::integer,
    count(*) filter (where coalesce((conflict_summary->>'duplicate_in_run')::boolean, false))::integer,
    count(*) filter (where nullif(trim(coalesce(image_url, '')), '') is not null)::integer
  into v_total, v_insert, v_update, v_skip, v_error, v_duplicate, v_image_quarantined
  from public.catalog_import_stage
  where run_id = input_run_id
    and organization_id = v_org_id;

  update public.catalog_import_runs
  set staged_rows = v_total,
      valid_rows = greatest(v_total - v_error, 0),
      error_rows = v_error,
      duplicate_rows = v_duplicate,
      insert_rows = v_insert,
      update_rows = v_update,
      skip_rows = v_skip,
      processed_rows = v_total,
      image_quarantined_count = v_image_quarantined
  where id = input_run_id
    and organization_id = v_org_id;

  return v_result || jsonb_build_object(
    'total_count', v_total,
    'insert_count', v_insert,
    'update_count', v_update,
    'skip_count', v_skip,
    'error_count', v_error,
    'duplicate_count', v_duplicate,
    'image_quarantined_count', v_image_quarantined
  );
end;
$$;

revoke all on function public.validate_catalog_import_pre_h3(uuid) from public, anon, authenticated, service_role;
revoke all on function public.validate_catalog_import(uuid) from public, anon, authenticated, service_role;
grant execute on function public.validate_catalog_import(uuid) to authenticated;

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
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_error_count integer := 0;
  v_image_quarantined integer := 0;
  v_finalized_by uuid := auth.uid();
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import catalog data';
  end if;
  if input_run_id is null then
    raise exception 'Catalog import run is required';
  end if;

  select * into v_run
  from public.catalog_import_runs
  where id = input_run_id and organization_id = v_org_id
  for update;

  if not found then raise exception 'Catalog import run was not found'; end if;
  if v_run.status = 'finalized' then raise exception 'Catalog import run has already been finalized'; end if;
  if v_run.status <> 'validated' then raise exception 'Catalog import run cannot be finalized from status %', v_run.status; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_run.organization_id::text || ':' || v_run.id::text || ':catalog_import_finalize', 0));

  begin
    update public.catalog_import_runs set status = 'finalizing', error_message = null where id = v_run.id;

    select count(*)::integer into v_error_count
    from public.catalog_import_stage s
    where s.run_id = v_run.id and s.organization_id = v_org_id and s.validation_status = 'error';
    if v_error_count > 0 then raise exception 'Catalog import run still has validation errors'; end if;

    insert into public.brands (organization_id, name)
    select distinct v_org_id, coalesce(nullif(trim(s.brand), ''), 'Unbranded')
    from public.catalog_import_stage s
    where s.run_id = v_run.id and s.organization_id = v_org_id and nullif(trim(coalesce(s.brand, '')), '') is not null
    on conflict (organization_id, normalized_name) do nothing;

    with ordered_stage_rows as (
      select s.*, b.id as brand_id, cp.id as existing_product_id
      from public.catalog_import_stage s
      left join public.brands b on b.organization_id = v_org_id and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
      left join public.catalog_products cp on cp.organization_id = v_org_id and cp.brand_id = b.id and cp.normalized_code = s.normalized_code
      where s.run_id = v_run.id and s.organization_id = v_org_id and s.validation_status = 'valid' and s.proposed_action in ('insert', 'update', 'skip')
      order by s.row_index asc, s.created_at asc, s.id asc
    ),
    inserted_rows as (
      insert into public.catalog_products (
        organization_id, brand_id, product_code, description, oem_no, hs_code,
        origin, weight_kg, lifecycle_status, lifecycle_note
      )
      select v_org_id, osr.brand_id, osr.product_code,
        nullif(trim(coalesce(osr.description, '')), ''),
        nullif(trim(coalesce(osr.oem_no, '')), ''),
        nullif(trim(coalesce(osr.hs_code, '')), ''),
        nullif(trim(coalesce(osr.origin, '')), ''),
        osr.weight_kg,
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
          lifecycle_status = coalesce(nullif(trim(coalesce(osr.lifecycle_status, '')), ''), cp.lifecycle_status),
          lifecycle_note = coalesce(nullif(trim(coalesce(osr.lifecycle_note, '')), ''), cp.lifecycle_note),
          updated_at = now()
      from ordered_stage_rows osr
      where osr.proposed_action = 'update'
        and cp.organization_id = v_org_id and cp.id = osr.existing_product_id
        and cp.brand_id = osr.brand_id and cp.normalized_code = osr.normalized_code
        and (
          cp.description is distinct from coalesce(nullif(trim(coalesce(osr.description, '')), ''), cp.description)
          or cp.oem_no is distinct from coalesce(nullif(trim(coalesce(osr.oem_no, '')), ''), cp.oem_no)
          or cp.hs_code is distinct from coalesce(nullif(trim(coalesce(osr.hs_code, '')), ''), cp.hs_code)
          or cp.origin is distinct from coalesce(nullif(trim(coalesce(osr.origin, '')), ''), cp.origin)
          or cp.weight_kg is distinct from coalesce(osr.weight_kg, cp.weight_kg)
          or cp.lifecycle_status is distinct from coalesce(nullif(trim(coalesce(osr.lifecycle_status, '')), ''), cp.lifecycle_status)
          or cp.lifecycle_note is distinct from coalesce(nullif(trim(coalesce(osr.lifecycle_note, '')), ''), cp.lifecycle_note)
        )
      returning 1
    ),
    skipped_rows as (
      select 1 from ordered_stage_rows osr where osr.proposed_action = 'skip'
    ),
    quarantined_rows as (
      select 1 from ordered_stage_rows osr where nullif(trim(coalesce(osr.image_url, '')), '') is not null
    )
    select
      (select count(*)::integer from inserted_rows),
      (select count(*)::integer from updated_rows),
      (select count(*)::integer from skipped_rows),
      (select count(*)::integer from quarantined_rows)
    into v_inserted, v_updated, v_skipped, v_image_quarantined;

    update public.catalog_import_runs
    set status = 'finalized', finalized_at = now(), finalized_by = coalesce(v_finalized_by, finalized_by, created_by),
        finished_at = now(), error_message = null, inserted_count = v_inserted, updated_count = v_updated,
        skipped_count = v_skipped, image_quarantined_count = v_image_quarantined, error_rows = 0,
        insert_rows = v_inserted, update_rows = v_updated, skip_rows = v_skipped,
        processed_rows = v_inserted + v_updated + v_skipped
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'finalized', 'run_id', v_run.id, 'inserted_count', v_inserted,
      'updated_count', v_updated, 'skipped_count', v_skipped, 'error_count', 0,
      'image_quarantined_count', v_image_quarantined
    );
  exception when others then
    update public.catalog_import_runs set status = 'finalize_failed', finished_at = now(), error_message = sqlerrm where id = v_run.id;
    raise;
  end;
end;
$$;

revoke all on function public.finalize_catalog_import(uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_catalog_import(uuid) to authenticated;

comment on function public.finalize_catalog_import(uuid) is
  'H3 import finalizer. Staged image_url is quarantined and never mutates catalog_products.image_url; only separately governed source-fill may write canonical Product images.';
