-- Slice 2 for catalog import staging.
-- Stage rows are written to catalog_import_stage only.
-- Catalog truth remains untouched until later finalize slices.

create unique index if not exists idx_catalog_import_stage_run_row_unique
  on public.catalog_import_stage (run_id, row_index);

drop function if exists public.stage_catalog_import_chunk(uuid, jsonb);

create or replace function public.stage_catalog_import_chunk(
  input_run_id uuid,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run public.catalog_import_runs%rowtype;
  v_inserted integer := 0;
  v_error_rows integer := 0;
  v_total_rows integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import catalog data';
  end if;

  if input_run_id is null then
    raise exception 'Catalog import run is required';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'Catalog import chunk must be a JSON array';
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

  if v_run.status not in ('running', 'validating', 'validated') then
    raise exception 'Catalog import run is not accepting chunks';
  end if;

  create temporary table tmp_catalog_import_chunk_rows (
    input_row_index integer,
    brand text,
    product_code text,
    description text,
    oem_no text,
    hs_code text,
    origin text,
    weight_kg_text text,
    image_url text,
    lifecycle_status text,
    lifecycle_note text,
    input_ordinality bigint
  ) on commit drop;

  insert into tmp_catalog_import_chunk_rows (
    input_row_index,
    brand,
    product_code,
    description,
    oem_no,
    hs_code,
    origin,
    weight_kg_text,
    image_url,
    lifecycle_status,
    lifecycle_note,
    input_ordinality
  )
  select
    case
      when nullif(trim(coalesce(item.value->>'row_index', '')), '') ~ '^[0-9]+$'
        then (item.value->>'row_index')::integer
      else null
    end,
    nullif(trim(coalesce(item.value->>'brand', '')), ''),
    nullif(trim(coalesce(item.value->>'product_code', '')), ''),
    nullif(trim(coalesce(item.value->>'description', '')), ''),
    nullif(trim(coalesce(item.value->>'oem_no', '')), ''),
    nullif(trim(coalesce(item.value->>'hs_code', '')), ''),
    nullif(trim(coalesce(item.value->>'origin', '')), ''),
    nullif(trim(coalesce(item.value->>'weight_kg', '')), ''),
    nullif(trim(coalesce(item.value->>'image_url', '')), ''),
    nullif(trim(coalesce(item.value->>'lifecycle_status', '')), ''),
    nullif(trim(coalesce(item.value->>'lifecycle_note', '')), ''),
    item.ordinality
  from jsonb_array_elements(payload) with ordinality as item(value, ordinality);

  get diagnostics v_total_rows = row_count;

  if v_total_rows <= 0 then
    return jsonb_build_object(
      'status', 'ok',
      'run_id', v_run.id,
      'staged_count', 0,
      'error_count', 0,
      'total_count', 0
    );
  end if;

  with run_scope as (
    select
      coalesce(max(row_index), -1) as max_row_index
    from public.catalog_import_stage
    where run_id = v_run.id
  ),
  normalized_rows as (
    select
      coalesce(t.input_row_index, s.max_row_index + t.input_ordinality::integer) as row_index,
      t.brand,
      t.product_code,
      t.description,
      t.oem_no,
      t.hs_code,
      t.origin,
      t.weight_kg_text,
      public.reporting_to_numeric(t.weight_kg_text) as weight_kg,
      t.image_url,
      case
        when lower(trim(coalesce(t.lifecycle_status, ''))) ~ '^(discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|unavailable|not available|teslim edilemiyor|sunulmuyor|artik sunulmuyor|uretimden|kaldirilacak)$'
          then 'discontinued'
        else 'active'
      end as lifecycle_status,
      t.lifecycle_note,
      t.input_ordinality,
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
    from tmp_catalog_import_chunk_rows t
    cross join run_scope s
    left join public.brands b
      on b.organization_id = v_run.organization_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(coalesce(t.brand, ''))
    left join public.catalog_products cp
      on cp.organization_id = v_run.organization_id
     and cp.brand_id = b.id
     and cp.normalized_code = public.normalize_part_code(
       public.normalize_catalog_display_code_for_brand(coalesce(t.product_code, ''), coalesce(b.name, coalesce(t.brand, '')))
     )
    where true
  ),
  deduped_rows as (
    select distinct on (row_index)
      *
    from normalized_rows
    order by row_index, input_ordinality desc
  ),
  prepared_rows as (
    select
      v_run.id as run_id,
      v_run.organization_id,
      d.row_index,
      d.brand,
      d.product_code,
      coalesce(
        public.normalize_part_code(
          public.normalize_catalog_display_code_for_brand(
            coalesce(d.product_code, ''),
            coalesce(d.matched_brand_name, coalesce(d.brand, ''))
          )
        ),
        ''
      ) as normalized_code,
      d.description,
      d.oem_no,
      d.hs_code,
      d.origin,
      d.weight_kg_text,
      d.weight_kg,
      d.image_url,
      d.lifecycle_status,
      d.lifecycle_note,
      case
        when d.brand is null and d.product_code is null then 'error'
        when d.brand is null then 'error'
        when d.product_code is null then 'error'
        when d.weight_kg_text is not null and d.weight_kg is null then 'error'
        else 'valid'
      end as validation_status,
      case
        when d.brand is null then 'Brand is required'
        when d.product_code is null then 'Product code is required'
        when d.weight_kg_text is not null and d.weight_kg is null then 'Weight is invalid'
        else null
      end as validation_message,
      case
        when d.brand is null or d.product_code is null then 'error'
        when d.weight_kg_text is not null and d.weight_kg is null then 'error'
        when d.existing_product_id is not null and v_run.mode = 'insert_only' then 'skip'
        when d.existing_product_id is not null then 'update'
        else 'insert'
      end as proposed_action,
      jsonb_build_object(
        'brand_exists', d.brand_id is not null,
        'existing_product_exists', d.existing_product_id is not null,
        'existing_product_id', d.existing_product_id,
        'existing_product_code', d.existing_product_code
      ) as conflict_summary
    from deduped_rows d
  ),
  upserted_stage as (
    insert into public.catalog_import_stage (
      run_id,
      organization_id,
      row_index,
      brand,
      product_code,
      normalized_code,
      description,
      oem_no,
      hs_code,
      origin,
      weight_kg,
      image_url,
      lifecycle_status,
      lifecycle_note,
      validation_status,
      validation_message,
      proposed_action,
      conflict_summary
    )
    select
      run_id,
      organization_id,
      row_index,
      brand,
      product_code,
      normalized_code,
      description,
      oem_no,
      hs_code,
      origin,
      weight_kg,
      image_url,
      lifecycle_status,
      lifecycle_note,
      validation_status,
      validation_message,
      proposed_action,
      conflict_summary
    from prepared_rows
    on conflict (run_id, row_index) do update set
      organization_id = excluded.organization_id,
      brand = excluded.brand,
      product_code = excluded.product_code,
      normalized_code = excluded.normalized_code,
      description = excluded.description,
      oem_no = excluded.oem_no,
      hs_code = excluded.hs_code,
      origin = excluded.origin,
      weight_kg = excluded.weight_kg,
      image_url = excluded.image_url,
      lifecycle_status = excluded.lifecycle_status,
      lifecycle_note = excluded.lifecycle_note,
      validation_status = excluded.validation_status,
      validation_message = excluded.validation_message,
      proposed_action = excluded.proposed_action,
      conflict_summary = excluded.conflict_summary
    returning validation_status
  )
  select
    count(*)::integer,
    count(*) filter (where validation_status = 'error')::integer
  into v_inserted, v_error_rows
  from upserted_stage;

  update public.catalog_import_runs
  set staged_rows = staged_rows + v_inserted,
      valid_rows = valid_rows + greatest(v_inserted - v_error_rows, 0),
      error_rows = error_rows + v_error_rows,
      duplicate_rows = duplicate_rows + greatest(v_total_rows - v_inserted, 0)
  where id = v_run.id;

  return jsonb_build_object(
    'status', 'ok',
    'run_id', v_run.id,
    'staged_count', v_inserted,
    'error_count', v_error_rows,
    'total_count', v_total_rows
  );
end;
$$;

grant execute on function public.stage_catalog_import_chunk(uuid, jsonb) to authenticated;
grant execute on function public.stage_catalog_import_chunk(uuid, jsonb) to service_role;
