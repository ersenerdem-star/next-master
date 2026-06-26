-- Lightweight procurement dashboard summary.
-- Reads from supplier_price_rollups only; detailed product comparison remains on cloud_master_page.

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
  with params as (
    select
      p_organization_id as organization_id,
      p_brand_id as brand_id,
      coalesce(p_high_gap_threshold, 10) as high_gap_threshold,
      least(greatest(coalesce(p_limit, 10), 1), 50) as row_limit
  ),
  scoped as (
    select
      spr.organization_id,
      spr.brand_id,
      coalesce(b.name, '') as brand,
      spr.product_code,
      spr.normalized_code,
      spr.cheapest_supplier_id,
      coalesce(cheapest.name, '') as cheapest_supplier,
      spr.cheapest_price,
      spr.second_supplier_id,
      coalesce(nullif(spr.second_supplier_name, ''), second_supplier.name, '') as second_supplier_name,
      spr.second_price,
      spr.price_gap,
      spr.price_gap_percent,
      spr.supplier_count,
      spr.refreshed_at
    from public.supplier_price_rollups spr
    join params p on p.organization_id = spr.organization_id
    left join public.brands b on b.id = spr.brand_id
    left join public.suppliers cheapest on cheapest.id = spr.cheapest_supplier_id
    left join public.suppliers second_supplier on second_supplier.id = spr.second_supplier_id
    where (p.brand_id is null or spr.brand_id = p.brand_id)
      and (
        coalesce(public.is_superadmin(), false)
        or (
          spr.organization_id = public.current_profile_org_id()
          and public.current_profile_role() in ('admin', 'sales', 'warehouse')
        )
      )
  ),
  aggregate_summary as (
    select
      count(*)::bigint as total_rollups,
      count(*) filter (
        where second_supplier_id is not null
          or second_price is not null
          or nullif(trim(second_supplier_name), '') is not null
      )::bigint as with_second_supplier,
      count(*) filter (
        where not (
          second_supplier_id is not null
          or second_price is not null
          or nullif(trim(second_supplier_name), '') is not null
        )
      )::bigint as single_supplier_count,
      avg(price_gap_percent) filter (where price_gap_percent is not null) as avg_gap_percent,
      count(*) filter (
        where coalesce(price_gap_percent, 0) >= (select high_gap_threshold from params)
      )::bigint as high_gap_count,
      max(refreshed_at) as max_refreshed_at
    from scoped
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
      select scoped.*
      from scoped
      cross join params p
      where coalesce(scoped.price_gap_percent, 0) >= p.high_gap_threshold
      order by scoped.price_gap_percent desc nulls last, scoped.price_gap desc nulls last, scoped.product_code
      limit (select row_limit from params)
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
      select scoped.*
      from scoped
      where not (
        scoped.second_supplier_id is not null
        or scoped.second_price is not null
        or nullif(trim(scoped.second_supplier_name), '') is not null
      )
      order by scoped.cheapest_price desc nulls last, scoped.product_code
      limit (select row_limit from params)
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
