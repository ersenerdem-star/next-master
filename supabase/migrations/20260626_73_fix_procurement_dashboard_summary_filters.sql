-- Fix procurement dashboard summary filters.
-- The previous version could return zero rows because auth/profile scoping and
-- parameter aliases could hide rows even when explicit organization/brand
-- parameters matched existing supplier_price_rollups data.

create or replace function public.procurement_dashboard_summary(
  p_organization_id uuid,
  p_brand_id uuid default null,
  p_high_gap_threshold numeric default 10,
  p_limit integer default 10
)
returns table (
  total_rollups bigint,
  with_second_supplier bigint,
  single_supplier_count bigint,
  avg_gap_percent numeric,
  high_gap_count bigint,
  max_refreshed_at timestamptz,
  top_high_gap_items jsonb,
  single_supplier_items jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with inputs as (
    select
      p_organization_id as input_organization_id,
      p_brand_id as input_brand_id,
      coalesce(p_high_gap_threshold, 10) as input_high_gap_threshold,
      least(greatest(coalesce(p_limit, 10), 1), 50) as input_limit
  ),
  filtered as (
    select
      r.organization_id,
      r.brand_id,
      coalesce(b.name, '') as brand,
      r.product_code,
      r.normalized_code,
      r.cheapest_supplier_id,
      coalesce(cheapest.name, '') as cheapest_supplier,
      r.cheapest_price,
      r.second_supplier_id,
      coalesce(nullif(r.second_supplier_name, ''), second_supplier.name, '') as second_supplier_name,
      r.second_price,
      r.price_gap,
      r.price_gap_percent,
      r.supplier_count,
      r.refreshed_at,
      inputs.input_high_gap_threshold,
      inputs.input_limit
    from public.supplier_price_rollups r
    cross join inputs
    left join public.brands b on b.id = r.brand_id
    left join public.suppliers cheapest on cheapest.id = r.cheapest_supplier_id
    left join public.suppliers second_supplier on second_supplier.id = r.second_supplier_id
    where r.organization_id = input_organization_id
      and (input_brand_id is null or r.brand_id = input_brand_id)
  ),
  aggregate_summary as (
    select
      count(*)::bigint as total_rollups,
      count(*) filter (where second_price is not null)::bigint as with_second_supplier,
      count(*) filter (where second_price is null)::bigint as single_supplier_count,
      avg(price_gap_percent) as avg_gap_percent,
      count(*) filter (
        where price_gap_percent >= input_high_gap_threshold
      )::bigint as high_gap_count,
      max(refreshed_at) as max_refreshed_at
    from filtered
  ),
  top_high_gap_items as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'brand', item.brand,
          'product_code', item.product_code,
          'normalized_code', item.normalized_code,
          'cheapest_supplier', item.cheapest_supplier,
          'cheapest_price', item.cheapest_price,
          'second_supplier_name', item.second_supplier_name,
          'second_price', item.second_price,
          'price_gap', item.price_gap,
          'price_gap_percent', item.price_gap_percent
        )
        order by item.price_gap_percent desc nulls last, item.price_gap desc nulls last, item.product_code
      ),
      '[]'::jsonb
    ) as items
    from (
      select
        brand,
        product_code,
        normalized_code,
        cheapest_supplier,
        cheapest_price,
        second_supplier_name,
        second_price,
        price_gap,
        price_gap_percent
      from filtered
      where price_gap_percent >= input_high_gap_threshold
      order by price_gap_percent desc nulls last, price_gap desc nulls last, product_code
      limit (select input_limit from inputs)
    ) item
  ),
  single_supplier_items as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'brand', item.brand,
          'product_code', item.product_code,
          'normalized_code', item.normalized_code,
          'cheapest_supplier', item.cheapest_supplier,
          'cheapest_price', item.cheapest_price,
          'stock_qty', null,
          'lead_time_days', null
        )
        order by item.cheapest_price desc nulls last, item.product_code
      ),
      '[]'::jsonb
    ) as items
    from (
      select
        brand,
        product_code,
        normalized_code,
        cheapest_supplier,
        cheapest_price
      from filtered
      where second_price is null
      order by cheapest_price desc nulls last, product_code
      limit (select input_limit from inputs)
    ) item
  )
  select
    coalesce(aggregate_summary.total_rollups, 0),
    coalesce(aggregate_summary.with_second_supplier, 0),
    coalesce(aggregate_summary.single_supplier_count, 0),
    aggregate_summary.avg_gap_percent,
    coalesce(aggregate_summary.high_gap_count, 0),
    aggregate_summary.max_refreshed_at,
    top_high_gap_items.items,
    single_supplier_items.items
  from aggregate_summary
  cross join top_high_gap_items
  cross join single_supplier_items;
$$;

grant execute on function public.procurement_dashboard_summary(uuid, uuid, numeric, integer) to authenticated;
grant execute on function public.procurement_dashboard_summary(uuid, uuid, numeric, integer) to service_role;
