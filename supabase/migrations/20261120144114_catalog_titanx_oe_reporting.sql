-- Correct TITANX missing-OE reporting without changing catalog or legacy counters.
-- Existing counters count only the single oem_no field. The adjustment below
-- is read in the same MVCC snapshot as the report, and is limited to TITANX
-- to avoid scanning the entire catalog. Other brands keep their legacy values.
-- A separate general-purpose projection will be needed for other brands.

set lock_timeout = '5s';

create or replace function public.catalog_titanx_oem_reference_correction(
  input_brand_id uuid default null
)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)::bigint
  from public.brands b
  join public.catalog_products cp
    on cp.organization_id = b.organization_id and cp.brand_id = b.id
  where b.organization_id = public.current_profile_org_id()
    and lower(trim(b.name)) = 'titanx'
    and (input_brand_id is null or b.id = input_brand_id)
    and nullif(trim(coalesce(cp.oem_no, '')), '') is null
    and exists (
      select 1 from public.catalog_product_identifiers i
      where i.organization_id = cp.organization_id
        and i.catalog_product_id = cp.id
        and i.identifier_type = 'oem'
        and nullif(trim(i.normalized_value), '') is not null
    );
$$;

revoke all on function public.catalog_titanx_oem_reference_correction(uuid)
  from public, anon;
grant execute on function public.catalog_titanx_oem_reference_correction(uuid)
  to authenticated, service_role;

create or replace function public.get_catalog_integrity_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with org as (
    select public.current_profile_org_id() as organization_id
  ), status as (
    select
      coalesce(s.total_products, 0) as total_products,
      coalesce(s.projected_products, 0) as projected_products,
      coalesce(s.clear_count, 0) as projected_clear_count,
      coalesce(s.incomplete_count, 0) as projected_incomplete_count,
      coalesce(s.conflict_count, 0) as conflict_count,
      coalesce(s.pending_count, 0) as queue_depth,
      coalesce(s.failed_count, 0) as failed_count,
      coalesce(s.catalog_complete_count, 0) as catalog_complete_count,
      coalesce(s.catalog_incomplete_count, 0) as catalog_incomplete_count,
      coalesce(s.missing_description_count, 0) as missing_description_count,
      coalesce(s.missing_origin_count, 0) as missing_origin_count,
      coalesce(s.missing_hs_code_count, 0) as missing_hs_code_count,
      coalesce(s.missing_weight_count, 0) as missing_weight_count,
      coalesce(s.missing_ean_count, 0) as missing_ean_count,
      greatest(0, coalesce(s.missing_oem_count, 0) - public.catalog_titanx_oem_reference_correction(null)) as missing_oem_count,
      coalesce(s.missing_vehicle_count, 0) as missing_vehicle_count,
      coalesce(s.missing_image_count, 0) as missing_image_count,
      s.last_catalog_change_at,
      s.last_evaluated_at,
      coalesce(s.backfill_status, 'queued') as backfill_status,
      coalesce(s.backfill_queued_products, 0) as backfill_queued_products,
      s.backfill_updated_at,
      s.backfill_error
    from org
    left join public.catalog_integrity_summary s
      on s.organization_id = org.organization_id
  ), calculated as (
    select
      status.*,
      projected_clear_count
        + projected_incomplete_count
        + conflict_count
        + failed_count as evaluated_products
    from status
  )
  select jsonb_build_object(
    'total_products', total_products,
    'projected_products', projected_products,
    'evaluated_products', evaluated_products,
    'clear_count', catalog_complete_count,
    'incomplete_count', catalog_incomplete_count,
    'conflict_count', conflict_count,
    'pending_count', greatest(total_products - evaluated_products, 0),
    'queue_depth', queue_depth,
    'failed_count', failed_count,
    'evaluation_coverage_percent', case
      when total_products = 0 then 100
      else round((evaluated_products::numeric * 100) / total_products, 1)
    end,
    'data_completeness_percent', case
      when total_products = 0 then 100
      else round((catalog_complete_count::numeric * 100) / total_products, 1)
    end,
    'missing_description_count', missing_description_count,
    'missing_origin_count', missing_origin_count,
    'missing_hs_code_count', missing_hs_code_count,
    'missing_weight_count', missing_weight_count,
    'missing_ean_count', missing_ean_count,
    'missing_oem_count', missing_oem_count,
    'missing_vehicle_count', missing_vehicle_count,
    'missing_image_count', missing_image_count,
    'last_catalog_change_at', last_catalog_change_at,
    'last_evaluated_at', last_evaluated_at,
    'backfill_status', backfill_status,
    'backfill_queued_products', backfill_queued_products,
    'backfill_updated_at', backfill_updated_at,
    'backfill_error', backfill_error
  )
  from calculated;
$$;

revoke all on function public.get_catalog_integrity_summary()
  from public, anon;
grant execute on function public.get_catalog_integrity_summary()
  to authenticated, service_role;

create or replace function public.get_catalog_operations_brand_status(
  input_limit integer default 12
)
returns table (
  brand_id uuid,
  brand text,
  total_products bigint,
  complete_count bigint,
  incomplete_count bigint,
  data_completeness_percent numeric,
  missing_ean_count bigint,
  missing_oem_count bigint,
  missing_vehicle_count bigint,
  missing_image_count bigint,
  missing_description_count bigint,
  missing_description_tr_count bigint,
  missing_vehicle_model_count bigint,
  missing_market_segment_count bigint,
  last_catalog_change_at timestamptz,
  projection_updated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    s.brand_id,
    b.name as brand,
    s.total_products,
    s.complete_count,
    s.incomplete_count,
    case when s.total_products = 0 then 100
      else round((s.complete_count::numeric * 100) / s.total_products, 1)
    end as data_completeness_percent,
    s.missing_ean_count,
    case when lower(trim(b.name)) = 'titanx'
      then greatest(0, s.missing_oem_count - public.catalog_titanx_oem_reference_correction(s.brand_id))
      else s.missing_oem_count end as missing_oem_count,
    s.missing_vehicle_count,
    s.missing_image_count,
    s.missing_description_count,
    s.missing_description_tr_count,
    s.missing_vehicle_model_count,
    s.missing_market_segment_count,
    s.last_catalog_change_at,
    s.updated_at as projection_updated_at
  from public.catalog_operations_brand_summary s
  join public.brands b
    on b.organization_id = s.organization_id
   and b.id = s.brand_id
  where s.organization_id = public.current_profile_org_id()
    and s.total_products > 0
  order by s.total_products desc, b.name
  limit least(greatest(coalesce(input_limit, 12), 1), 100);
$$;

revoke all on function public.get_catalog_operations_brand_status(integer)
  from public, anon;
grant execute on function public.get_catalog_operations_brand_status(integer)
  to authenticated, service_role;

