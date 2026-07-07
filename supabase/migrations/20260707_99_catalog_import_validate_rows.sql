-- Slice 3 for catalog import validation.
-- Validation updates staged rows and run summaries only.
-- No catalog truth is mutated in this slice.

alter table public.catalog_import_runs
  drop constraint if exists catalog_import_runs_status_check;

alter table public.catalog_import_runs
  add constraint catalog_import_runs_status_check
  check (status in ('running', 'validating', 'validated', 'validation_failed', 'finalizing', 'succeeded', 'failed', 'cancelled'));

drop function if exists public.validate_catalog_import(uuid);

create or replace function public.validate_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run public.catalog_import_runs%rowtype;
  v_total_count integer := 0;
  v_insert_count integer := 0;
  v_update_count integer := 0;
  v_skip_count integer := 0;
  v_error_count integer := 0;
  v_duplicate_count integer := 0;
  v_conflict_count integer := 0;
  v_status text := 'validation_failed';
  v_error_message text := null;
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

  if v_run.status not in ('running', 'validated', 'validation_failed') then
    raise exception 'Catalog import run is not accepting validation';
  end if;

  select count(*)::integer
    into v_total_count
  from public.catalog_import_stage s
  where s.run_id = v_run.id
    and s.organization_id = v_org_id;

  if v_total_count <= 0 then
    update public.catalog_import_runs
    set status = 'validation_failed',
        finished_at = now(),
        error_message = 'Catalog import run has no staged rows',
        staged_rows = 0,
        valid_rows = 0,
        error_rows = 0,
        duplicate_rows = 0,
        insert_rows = 0,
        update_rows = 0,
        skip_rows = 0,
        processed_rows = 0
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'validation_failed',
      'run_id', v_run.id,
      'total_count', 0,
      'insert_count', 0,
      'update_count', 0,
      'skip_count', 0,
      'error_count', 0,
      'duplicate_count', 0,
      'conflict_count', 0
    );
  end if;

  update public.catalog_import_runs
  set status = 'validating',
      error_message = null
  where id = v_run.id;

  with stage_source as (
    select
      s.id,
      s.row_index,
      s.brand,
      s.product_code,
      s.normalized_code,
      s.description,
      s.oem_no,
      s.hs_code,
      s.origin,
      s.weight_kg,
      s.image_url,
      s.lifecycle_status,
      s.lifecycle_note,
      public.normalize_catalog_brand_key(s.brand) as brand_key,
      b.id as brand_id,
      b.name as matched_brand_name,
      cp.id as existing_product_id,
      cp.product_code as existing_product_code,
      cp.description as existing_description,
      cp.oem_no as existing_oem_no,
      cp.hs_code as existing_hs_code,
      cp.origin as existing_origin,
      cp.weight_kg as existing_weight_kg,
      cp.image_url as existing_image_url,
      cp.lifecycle_status as existing_lifecycle_status,
      cp.lifecycle_note as existing_lifecycle_note
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
  ),
  scored as (
    select
      ss.*,
      count(*) over (partition by ss.brand_key, ss.normalized_code) as duplicate_group_count,
      array_remove(ARRAY[
        case when ss.existing_product_id is not null and ss.product_code is distinct from ss.existing_product_code then 'product_code' end,
        case when ss.existing_product_id is not null and ss.description is distinct from ss.existing_description then 'description' end,
        case when ss.existing_product_id is not null and ss.oem_no is distinct from ss.existing_oem_no then 'oem_no' end,
        case when ss.existing_product_id is not null and ss.hs_code is distinct from ss.existing_hs_code then 'hs_code' end,
        case when ss.existing_product_id is not null and ss.origin is distinct from ss.existing_origin then 'origin' end,
        case when ss.existing_product_id is not null and ss.weight_kg is distinct from ss.existing_weight_kg then 'weight_kg' end,
        case when ss.existing_product_id is not null and ss.image_url is distinct from ss.existing_image_url then 'image_url' end,
        case when ss.existing_product_id is not null and ss.lifecycle_status is distinct from ss.existing_lifecycle_status then 'lifecycle_status' end,
        case when ss.existing_product_id is not null and ss.lifecycle_note is distinct from ss.existing_lifecycle_note then 'lifecycle_note' end
      ], null)::text[] as changed_fields
    from stage_source ss
  ),
  classified as (
    select
      sc.*,
      case
        when nullif(trim(coalesce(sc.brand, '')), '') is null then 'error'
        when nullif(trim(coalesce(sc.product_code, '')), '') is null then 'error'
        when nullif(trim(coalesce(sc.normalized_code, '')), '') is null then 'error'
        when sc.weight_kg is not null and sc.weight_kg <= 0 then 'error'
        when sc.duplicate_group_count > 1 then 'error'
        when sc.existing_product_id is null then 'insert'
        when v_run.mode = 'insert_only' then 'skip'
        when coalesce(cardinality(sc.changed_fields), 0) = 0 then 'skip'
        else 'update'
      end as proposed_action,
      case
        when nullif(trim(coalesce(sc.brand, '')), '') is null then 'Brand is required'
        when nullif(trim(coalesce(sc.product_code, '')), '') is null then 'Product code is required'
        when nullif(trim(coalesce(sc.normalized_code, '')), '') is null then 'Normalized code is required'
        when sc.weight_kg is not null and sc.weight_kg <= 0 then 'Weight must be greater than zero'
        when sc.duplicate_group_count > 1 then 'Duplicate brand and product code in this import run'
        when sc.existing_product_id is null then null
        when v_run.mode = 'insert_only' then 'Existing catalog product will be skipped in insert-only mode'
        when coalesce(cardinality(sc.changed_fields), 0) = 0 then 'Existing catalog product already matches staged values'
        else null
      end as validation_message,
      jsonb_build_object(
        'brand_exists', sc.brand_id is not null,
        'existing_product_exists', sc.existing_product_id is not null,
        'existing_product_id', sc.existing_product_id,
        'existing_product_code', sc.existing_product_code,
        'duplicate_in_run', sc.duplicate_group_count > 1,
        'changed_fields', to_jsonb(coalesce(sc.changed_fields, ARRAY[]::text[])),
        'field_deltas', jsonb_strip_nulls(
          jsonb_build_object(
            'product_code', case when sc.existing_product_id is not null and sc.product_code is distinct from sc.existing_product_code then jsonb_build_object('from', sc.existing_product_code, 'to', sc.product_code) end,
            'description', case when sc.existing_product_id is not null and sc.description is distinct from sc.existing_description then jsonb_build_object('from', sc.existing_description, 'to', sc.description) end,
            'oem_no', case when sc.existing_product_id is not null and sc.oem_no is distinct from sc.existing_oem_no then jsonb_build_object('from', sc.existing_oem_no, 'to', sc.oem_no) end,
            'hs_code', case when sc.existing_product_id is not null and sc.hs_code is distinct from sc.existing_hs_code then jsonb_build_object('from', sc.existing_hs_code, 'to', sc.hs_code) end,
            'origin', case when sc.existing_product_id is not null and sc.origin is distinct from sc.existing_origin then jsonb_build_object('from', sc.existing_origin, 'to', sc.origin) end,
            'weight_kg', case when sc.existing_product_id is not null and sc.weight_kg is distinct from sc.existing_weight_kg then jsonb_build_object('from', sc.existing_weight_kg, 'to', sc.weight_kg) end,
            'image_url', case when sc.existing_product_id is not null and sc.image_url is distinct from sc.existing_image_url then jsonb_build_object('from', sc.existing_image_url, 'to', sc.image_url) end,
            'lifecycle_status', case when sc.existing_product_id is not null and sc.lifecycle_status is distinct from sc.existing_lifecycle_status then jsonb_build_object('from', sc.existing_lifecycle_status, 'to', sc.lifecycle_status) end,
            'lifecycle_note', case when sc.existing_product_id is not null and sc.lifecycle_note is distinct from sc.existing_lifecycle_note then jsonb_build_object('from', sc.existing_lifecycle_note, 'to', sc.lifecycle_note) end
          )
        )
      ) as conflict_summary,
      (
        sc.existing_product_id is not null
        or sc.duplicate_group_count > 1
        or coalesce(cardinality(sc.changed_fields), 0) > 0
      ) as has_conflict
    from scored sc
  ),
  updated_stage as (
    update public.catalog_import_stage s
    set validation_status = case when c.proposed_action = 'error' then 'error' else 'valid' end,
        validation_message = c.validation_message,
        proposed_action = c.proposed_action,
        conflict_summary = c.conflict_summary
    from classified c
    where s.id = c.id
      and s.run_id = v_run.id
      and s.organization_id = v_org_id
    returning c.proposed_action, c.has_conflict, c.duplicate_group_count
  )
  select
    count(*)::integer,
    count(*) filter (where proposed_action = 'insert')::integer,
    count(*) filter (where proposed_action = 'update')::integer,
    count(*) filter (where proposed_action = 'skip')::integer,
    count(*) filter (where proposed_action = 'error')::integer,
    count(*) filter (where duplicate_group_count > 1)::integer,
    count(*) filter (where has_conflict)::integer
  into
    v_total_count,
    v_insert_count,
    v_update_count,
    v_skip_count,
    v_error_count,
    v_duplicate_count,
    v_conflict_count
  from classified;

  if v_error_count > 0 then
    v_status := 'validation_failed';
    v_error_message := 'Catalog import validation failed';
  else
    v_status := 'validated';
    v_error_message := null;
  end if;

  update public.catalog_import_runs
  set status = v_status,
      finished_at = case when v_status = 'validated' then null else now() end,
      error_message = v_error_message,
      staged_rows = v_total_count,
      valid_rows = greatest(v_total_count - v_error_count, 0),
      error_rows = v_error_count,
      duplicate_rows = v_duplicate_count,
      insert_rows = v_insert_count,
      update_rows = v_update_count,
      skip_rows = v_skip_count,
      processed_rows = v_total_count
  where id = v_run.id;

  return jsonb_build_object(
    'status', v_status,
    'run_id', v_run.id,
    'total_count', v_total_count,
    'insert_count', v_insert_count,
    'update_count', v_update_count,
    'skip_count', v_skip_count,
    'error_count', v_error_count,
    'duplicate_count', v_duplicate_count,
    'conflict_count', v_conflict_count
  );
end;
$$;

grant execute on function public.validate_catalog_import(uuid) to authenticated;
grant execute on function public.validate_catalog_import(uuid) to service_role;
