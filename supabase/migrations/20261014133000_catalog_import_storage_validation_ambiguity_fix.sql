-- Storage imports can contain millions of staged rows. The legacy validation
-- RPC builds and updates the whole run in one transaction, which exceeds the
-- PostgREST statement budget for large files. Keep a durable validation cursor
-- so the long-lived catalog worker can validate bounded batches.
alter table public.catalog_import_runs
  add column if not exists validation_cursor integer not null default -1;

create index if not exists idx_catalog_import_stage_run_validation
  on public.catalog_import_stage (run_id, row_index)
  where validation_status = 'pending';

create index if not exists idx_catalog_import_stage_run_code_brand
  on public.catalog_import_stage (run_id, normalized_code, brand);

drop function if exists public.validate_catalog_import_storage_batch_system(uuid,uuid,uuid,integer);
create or replace function public.validate_catalog_import_storage_batch_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_batch_size integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_org uuid;
  v_actor_role text;
  v_run public.catalog_import_runs%rowtype;
  v_cursor integer;
  v_next_cursor integer;
  v_batch_size integer := greatest(100, least(coalesce(input_batch_size, 1000), 1000));
  v_batch_count integer := 0;
  v_total integer := 0;
  v_insert integer := 0;
  v_update integer := 0;
  v_skip integer := 0;
  v_error integer := 0;
  v_duplicate integer := 0;
  v_has_more boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';
  end if;

  select organization_id, lower(role::text)
    into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System validation actor is not an active organization admin';
  end if;

  select * into v_run
  from public.catalog_import_runs
  where id = input_run_id and organization_id = input_organization_id
  for update;
  if not found then raise exception 'Catalog import run was not found'; end if;
  if v_run.status in ('failed','cancelled','finalized','succeeded','validation_failed','finalize_failed') then
    return jsonb_build_object('status',v_run.status,'run_id',v_run.id,'has_more',false,'replayed',true);
  end if;

  v_cursor := greatest(coalesce(v_run.validation_cursor, -1), -1);
  update public.catalog_import_runs
  set status = 'validating', error_message = null
  where id = v_run.id and organization_id = input_organization_id;

  with batch_rows as materialized (
    select s.*,
           b.id as brand_id,
           cp.id as existing_product_id,
           cp.product_code as existing_product_code,
           cp.description as existing_description,
           cp.oem_no as existing_oem_no,
           cp.hs_code as existing_hs_code,
           cp.origin as existing_origin,
           cp.weight_kg as existing_weight_kg,
           cp.image_url as existing_image_url,
           cp.lifecycle_status as existing_lifecycle_status,
           cp.lifecycle_note as existing_lifecycle_note,
           cp.ean as existing_ean,
           cp.vehicle as existing_vehicle,
           cp.vehicle_model as existing_vehicle_model,
           cp.market_segment as existing_market_segment,
           cp.description_tr as existing_description_tr
    from public.catalog_import_stage s
    left join public.brands b
      on b.organization_id = input_organization_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    left join public.catalog_products cp
      on cp.organization_id = input_organization_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = v_run.id
      and s.organization_id = input_organization_id
      and s.row_index > v_cursor
    order by s.row_index asc
    limit v_batch_size
  ), scored as (
    select br.*,
      exists (
        select 1
        from public.catalog_import_stage d
        where d.run_id = br.run_id
          and d.organization_id = br.organization_id
          and d.row_index <> br.row_index
          and d.normalized_code = br.normalized_code
          and public.normalize_catalog_brand_key(d.brand) = public.normalize_catalog_brand_key(br.brand)
      ) as duplicate_in_run,
      array_remove(array[
        case when br.existing_product_id is not null and br.product_code is distinct from br.existing_product_code then 'product_code' end,
        case when br.existing_product_id is not null and br.description is distinct from br.existing_description then 'description' end,
        case when br.existing_product_id is not null and br.oem_no is distinct from br.existing_oem_no then 'oem_no' end,
        case when br.existing_product_id is not null and br.hs_code is distinct from br.existing_hs_code then 'hs_code' end,
        case when br.existing_product_id is not null and br.origin is distinct from br.existing_origin then 'origin' end,
        case when br.existing_product_id is not null and br.weight_kg is distinct from br.existing_weight_kg then 'weight_kg' end,
        case when br.existing_product_id is not null and br.image_url is distinct from br.existing_image_url then 'image_url' end,
        case when br.existing_product_id is not null and br.lifecycle_status is distinct from br.existing_lifecycle_status then 'lifecycle_status' end,
        case when br.existing_product_id is not null and br.lifecycle_note is distinct from br.existing_lifecycle_note then 'lifecycle_note' end,
        case when br.existing_product_id is not null and br.ean is distinct from br.existing_ean then 'ean' end,
        case when br.existing_product_id is not null and br.vehicle is distinct from br.existing_vehicle then 'vehicle' end,
        case when br.existing_product_id is not null and br.vehicle_model is distinct from br.existing_vehicle_model then 'vehicle_model' end,
        case when br.existing_product_id is not null and br.market_segment is distinct from public.normalize_catalog_market_segment(br.market_segment) then 'market_segment' end,
        case when br.existing_product_id is not null and br.description_tr is distinct from br.existing_description_tr then 'description_tr' end
      ], null)::text[] as changed_fields
    from batch_rows br
  ), classified as (
    select sc.*,
      case
        when nullif(trim(coalesce(sc.brand, '')), '') is null then 'error'
        when sc.brand_id is null then 'error'
        when nullif(trim(coalesce(sc.product_code, '')), '') is null then 'error'
        when nullif(trim(coalesce(sc.normalized_code, '')), '') is null then 'error'
        when sc.weight_kg is not null and sc.weight_kg <= 0 then 'error'
        when sc.duplicate_in_run then 'error'
        when nullif(trim(coalesce(sc.source_url, '')), '') is not null and sc.source_url !~* '^https://' then 'error'
        when nullif(trim(coalesce(sc.source_fingerprint, '')), '') is not null and sc.source_fingerprint !~ '^[0-9a-fA-F]{64}$' then 'error'
        when sc.existing_product_id is null then 'insert'
        when v_run.mode = 'insert_only' then 'skip'
        when coalesce(cardinality(sc.changed_fields), 0) = 0 then 'skip'
        else 'update'
      end as proposed_action,
      case
        when nullif(trim(coalesce(sc.brand, '')), '') is null then 'Brand is required'
        when sc.brand_id is null then 'Brand was not found in the catalog'
        when nullif(trim(coalesce(sc.product_code, '')), '') is null then 'Product code is required'
        when nullif(trim(coalesce(sc.normalized_code, '')), '') is null then 'Normalized code is required'
        when sc.weight_kg is not null and sc.weight_kg <= 0 then 'Weight must be greater than zero'
        when sc.duplicate_in_run then 'Duplicate brand and product code in this import run'
        when nullif(trim(coalesce(sc.source_url, '')), '') is not null and sc.source_url !~* '^https://' then 'Source URL must use HTTPS'
        when nullif(trim(coalesce(sc.source_fingerprint, '')), '') is not null and sc.source_fingerprint !~ '^[0-9a-fA-F]{64}$' then 'Source fingerprint must be a SHA-256 hex digest'
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
        'duplicate_in_run', sc.duplicate_in_run,
        'changed_fields', to_jsonb(coalesce(sc.changed_fields, ARRAY[]::text[]))
      ) as conflict_summary
    from scored sc
  ), updated as (
    update public.catalog_import_stage s
    set validation_status = case when c.proposed_action = 'error' then 'error' else 'valid' end,
        validation_message = c.validation_message,
        proposed_action = c.proposed_action,
        conflict_summary = c.conflict_summary
    from classified c
    where s.id = c.id
    returning c.proposed_action, c.duplicate_in_run
  )
  select count(*)::integer,
         coalesce(max((select max(row_index) from batch_rows)), v_cursor),
         count(*) filter (where updated.proposed_action = 'insert')::integer,
         count(*) filter (where updated.proposed_action = 'update')::integer,
         count(*) filter (where updated.proposed_action = 'skip')::integer,
         count(*) filter (where updated.proposed_action = 'error')::integer,
         count(*) filter (where updated.duplicate_in_run)::integer
  into v_batch_count, v_next_cursor, v_insert, v_update, v_skip, v_error, v_duplicate
  from updated;

  if v_batch_count = 0 then
    select coalesce(max(row_index), v_cursor) into v_next_cursor
    from public.catalog_import_stage
    where run_id = v_run.id and organization_id = input_organization_id;
  end if;

  update public.catalog_import_runs
  set validation_cursor = v_next_cursor
  where id = v_run.id and organization_id = input_organization_id;

  select exists(
    select 1 from public.catalog_import_stage
    where run_id = v_run.id and organization_id = input_organization_id and row_index > v_next_cursor
  ) into v_has_more;

  if not v_has_more then
    select count(*)::integer,
           count(*) filter (where s.proposed_action = 'insert')::integer,
           count(*) filter (where s.proposed_action = 'update')::integer,
           count(*) filter (where s.proposed_action = 'skip')::integer,
           count(*) filter (where s.validation_status = 'error')::integer,
           count(*) filter (where coalesce((s.conflict_summary->>'duplicate_in_run')::boolean, false))::integer
    into v_total, v_insert, v_update, v_skip, v_error, v_duplicate
    from public.catalog_import_stage s
    where s.run_id = v_run.id and s.organization_id = input_organization_id;

    update public.catalog_import_runs
    set status = case when v_total = 0 or v_error > 0 then 'validation_failed' else 'validated' end,
        finished_at = case when v_total = 0 or v_error > 0 then now() else null end,
        error_message = case when v_total = 0 then 'Catalog import run has no staged rows' when v_error > 0 then 'Catalog import validation failed' else null end,
        staged_rows = v_total,
        valid_rows = greatest(v_total - v_error, 0),
        error_rows = v_error,
        duplicate_rows = v_duplicate,
        insert_rows = v_insert,
        update_rows = v_update,
        skip_rows = v_skip,
        processed_rows = 0
    where id = v_run.id and organization_id = input_organization_id;
  end if;

  return jsonb_build_object(
    'status', case when v_has_more then 'validating' when v_total = 0 or v_error > 0 then 'validation_failed' else 'validated' end,
    'run_id', v_run.id,
    'batch_processed', v_batch_count,
    'validation_cursor', v_next_cursor,
    'total_count', case when v_has_more then null else v_total end,
    'insert_count', case when v_has_more then null else v_insert end,
    'update_count', case when v_has_more then null else v_update end,
    'skip_count', case when v_has_more then null else v_skip end,
    'error_count', case when v_has_more then null else v_error end,
    'has_more', v_has_more
  );
end;
$$;

revoke all on function public.validate_catalog_import_storage_batch_system(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.validate_catalog_import_storage_batch_system(uuid,uuid,uuid,integer)
  to service_role;
