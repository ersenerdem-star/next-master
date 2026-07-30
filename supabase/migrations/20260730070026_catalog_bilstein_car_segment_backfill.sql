/*
 * Product-bounded Bilstein CAR segment backfill.
 *
 * The collector requested vehicle_type=CAR but historically wrote the
 * unsupported value `aftermarket`, which normalized to NULL. A canonical row
 * is eligible only when its tenant, brand and normalized code match a row that
 * was actually staged by the latest authorized PartsFinder CAR run.
 */

create temporary table nm_bilstein_car_product_ids
on commit drop
as
with ranked_runs as (
  select
    run.id,
    run.organization_id,
    case upper(coalesce(run.input_scope ->> 'source_brand', ''))
      when 'FEBI' then 'FEBI'
      when 'BLUE_PRINT' then 'BLUEPRINT'
      else null
    end as brand_norm,
    row_number() over (
      partition by
        run.organization_id,
        upper(coalesce(run.input_scope ->> 'source_brand', ''))
      order by run.started_at desc, run.id
    ) as run_rank
  from public.catalog_import_runs run
  join public.catalog_external_sources source
    on source.organization_id = run.organization_id
   and source.source_key = 'bilstein_group_partsfinder_list'
   and source.is_active
   and source.license_posture = 'allowed'
  where coalesce(run.input_scope ->> 'source_key', '') =
      'bilstein_group_partsfinder_list'
    and upper(coalesce(run.input_scope ->> 'vehicle_type', '')) = 'CAR'
    and upper(coalesce(source.metadata ->> 'vehicle_type', '')) = 'CAR'
    and upper(coalesce(run.input_scope ->> 'source_brand', '')) in (
      'FEBI',
      'BLUE_PRINT'
    )
    and (
      (
        upper(coalesce(run.input_scope ->> 'source_brand', '')) = 'FEBI'
        and coalesce(source.metadata -> 'allowed_brands', '[]'::jsonb) ? 'FEBI'
      )
      or
      (
        upper(coalesce(run.input_scope ->> 'source_brand', '')) = 'BLUE_PRINT'
        and coalesce(source.metadata -> 'allowed_brands', '[]'::jsonb) ? 'BLUE_PRINT'
      )
    )
),
eligible_runs as (
  select
    ranked.id,
    ranked.organization_id,
    ranked.brand_norm
  from ranked_runs ranked
  where ranked.run_rank = 1
)
select distinct product.id as product_id
from eligible_runs run
join public.brands brand
  on brand.organization_id = run.organization_id
 and brand.normalized_name = run.brand_norm
join public.catalog_import_stage stage
  on stage.organization_id = run.organization_id
 and stage.run_id = run.id
 and stage.source_key = 'bilstein_group_partsfinder_list'
join public.catalog_products product
  on product.organization_id = run.organization_id
 and product.brand_id = brand.id
 and product.normalized_code = stage.normalized_code
where run.brand_norm is not null
  and nullif(trim(product.market_segment), '') is null;

create unique index on nm_bilstein_car_product_ids (product_id);

do $backfill$
declare
  changed_rows integer;
begin
  loop
    with batch as materialized (
      select evidence.product_id
      from nm_bilstein_car_product_ids evidence
      join public.catalog_products product
        on product.id = evidence.product_id
      where nullif(trim(product.market_segment), '') is null
      order by evidence.product_id
      limit 5000
    )
    update public.catalog_products product
    set
      market_segment = 'pc',
      updated_at = now()
    from batch
    where product.id = batch.product_id;

    get diagnostics changed_rows = row_count;
    exit when changed_rows = 0;
  end loop;
end;
$backfill$;
