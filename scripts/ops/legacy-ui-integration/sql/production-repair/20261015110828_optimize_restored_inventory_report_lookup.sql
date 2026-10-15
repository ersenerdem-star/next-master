-- Same report result, RLS and grants; avoid an OR-driven full catalog scan.
set local lock_timeout='5s';
create or replace function public.reporting_inventory_by_brand_product_warehouse(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  warehouse_id uuid,
  warehouse_code text,
  warehouse_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  description text,
  origin text,
  qty_in numeric,
  qty_out numeric,
  on_hand_qty numeric,
  total_cost numeric,
  last_moved_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with enriched as (
    select
      im.organization_id,
      im.warehouse_id,
      im.warehouse_code,
      im.warehouse_name,
      brand_match.brand_id,
      coalesce(brand_match.brand, im.brand, '') as brand,
      product_match.product_id,
      coalesce(product_match.product_code, im.product_code, '') as product_code,
      coalesce(product_match.description, '') as description,
      coalesce(product_match.origin, '') as origin,
      im.qty_in,
      im.qty_out,
      im.total_cost,
      im.moved_at,
      im.related_party
    from public.inventory_movements im
    left join lateral (
      select br.id as brand_id, br.name as brand
      from public.brands br
      where br.organization_id = im.organization_id
        and (
          br.id = im.brand_id
          or (
            im.brand_id is null
            and br.normalized_name = public.normalize_part_code(coalesce(im.brand, ''))
          )
        )
      order by br.name
      limit 1
    ) brand_match on true
    left join lateral (
      -- Separate mutually exclusive identity paths so each lookup can use its
      -- existing primary-key or organization/normalized-code index under RLS.
      select candidate.product_id, candidate.product_code, candidate.description, candidate.origin
      from (
        select cp.id as product_id, cp.product_code, cp.description, cp.origin
        from public.catalog_products cp
        where im.product_id is not null
          and cp.organization_id = im.organization_id and cp.id = im.product_id
        union all
        select cp.id as product_id, cp.product_code, cp.description, cp.origin
        from public.catalog_products cp
        where im.product_id is null
          and cp.organization_id = im.organization_id
          and cp.normalized_code = public.normalize_part_code(coalesce(im.product_code, ''))
          and cp.brand_id is not distinct from brand_match.brand_id
      ) candidate
      order by candidate.product_code
      limit 1
    ) product_match on true
    where im.organization_id = p_organization_id and p_organization_id = public.current_profile_org_id() and auth.uid() is not null
      and (p_start_date is null or im.moved_at::date >= p_start_date)
      and (p_end_date is null or im.moved_at::date <= p_end_date)
  )
  select
    enriched.organization_id,
    enriched.warehouse_id,
    enriched.warehouse_code,
    enriched.warehouse_name,
    enriched.brand_id,
    enriched.brand,
    enriched.product_id,
    enriched.product_code,
    enriched.description,
    enriched.origin,
    sum(enriched.qty_in) as qty_in,
    sum(enriched.qty_out) as qty_out,
    sum(enriched.qty_in - enriched.qty_out) as on_hand_qty,
    sum(enriched.total_cost) as total_cost,
    max(enriched.moved_at) as last_moved_at
  from enriched
  where (p_brand_id is null or enriched.brand_id = p_brand_id)
    and (
      nullif(trim(coalesce(p_product_query, '')), '') is null
      or enriched.product_code ilike '%' || trim(p_product_query) || '%'
      or enriched.description ilike '%' || trim(p_product_query) || '%'
    )
    and (
      nullif(trim(coalesce(p_party_query, '')), '') is null
      or enriched.related_party ilike '%' || trim(p_party_query) || '%'
    )
  group by
    enriched.organization_id,
    enriched.warehouse_id,
    enriched.warehouse_code,
    enriched.warehouse_name,
    enriched.brand_id,
    enriched.brand,
    enriched.product_id,
    enriched.product_code,
    enriched.description,
    enriched.origin
  order by enriched.warehouse_code, enriched.brand, enriched.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;
