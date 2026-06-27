-- Master priced fast export page RPC.
-- Page rollups first, then set-based catalog enrichment for export.

drop function if exists public.cloud_master_priced_export_page_fast(text, uuid, integer, integer, numeric, numeric);

create or replace function public.cloud_master_priced_export_page_fast(
  input_search text default '',
  input_brand_id uuid default null,
  input_page integer default 1,
  input_page_size integer default 5000,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  cheapest_supplier text,
  cheapest_price numeric,
  second_supplier_name text,
  second_price numeric,
  price_gap numeric,
  price_gap_percent numeric,
  price_date date,
  sales_a numeric,
  sales_b numeric,
  supplier_count bigint,
  catalog_status text,
  notes text,
  has_notes boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with params as materialized (
    select
      public.current_profile_org_id() as org_id,
      input_brand_id as brand_id,
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      nullif(public.normalize_part_code(input_search), '') as search_norm,
      least(greatest(input_page_size, 1), 5000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 5000)) as row_offset
  ),
  page_rollups as materialized (
    select
      spr.organization_id,
      spr.brand_id,
      spr.normalized_code,
      spr.product_code as rollup_product_code,
      spr.description as rollup_description,
      spr.oem_no as rollup_oem_no,
      spr.cheapest_supplier_id,
      spr.cheapest_price,
      spr.second_supplier_id,
      spr.second_supplier_name,
      spr.second_price,
      spr.price_gap,
      spr.price_gap_percent,
      spr.price_date,
      spr.supplier_count,
      spr.notes,
      spr.has_notes
    from params p
    join public.supplier_price_rollups spr
      on spr.organization_id = p.org_id
     and p.brand_id is not null
     and spr.brand_id = p.brand_id
     and spr.cheapest_price is not null
    where p.org_id is not null
      and (
        p.raw_search is null
        or coalesce(spr.product_code, '') ilike '%' || p.raw_search || '%'
        or coalesce(spr.description, '') ilike '%' || p.raw_search || '%'
        or coalesce(spr.oem_no, '') ilike '%' || p.raw_search || '%'
        or (
          p.search_norm is not null
          and (
            spr.normalized_code = p.search_norm
            or coalesce(spr.normalized_oem, '') = p.search_norm
            or spr.normalized_code like p.search_norm || '%'
            or coalesce(spr.normalized_oem, '') like p.search_norm || '%'
          )
        )
      )
    order by spr.product_code asc nulls last, spr.normalized_code asc nulls last
    limit (select page_size from params)
    offset (select row_offset from params)
  ),
  page_catalog_keys as materialized (
    select distinct
      rp.organization_id,
      rp.brand_id,
      rp.normalized_code
    from page_rollups rp
    where rp.normalized_code is not null
  ),
  catalog_winners as materialized (
    select distinct on (cp.organization_id, cp.brand_id, cp.normalized_code)
      cp.organization_id,
      cp.brand_id,
      cp.normalized_code,
      cp.id,
      cp.product_code,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg
    from public.catalog_products cp
    join page_catalog_keys pck
      on pck.organization_id = cp.organization_id
     and pck.brand_id = cp.brand_id
     and pck.normalized_code = cp.normalized_code
    order by cp.organization_id, cp.brand_id, cp.normalized_code, cp.product_code asc nulls last, cp.id
  )
  select
    null::bigint as total_count,
    cw.id as product_id,
    coalesce(nullif(pr.rollup_product_code, ''), nullif(cw.product_code, ''), pr.normalized_code) as product_code,
    b.name as brand,
    coalesce(nullif(cw.description, ''), nullif(pr.rollup_description, ''), '') as description,
    coalesce(nullif(cw.oem_no, ''), nullif(pr.rollup_oem_no, ''), '') as oem_no,
    cw.hs_code,
    cw.origin,
    cw.weight_kg,
    coalesce(cheapest_supplier.name, '') as cheapest_supplier,
    pr.cheapest_price,
    coalesce(nullif(pr.second_supplier_name, ''), second_supplier.name, '') as second_supplier_name,
    pr.second_price,
    pr.price_gap,
    pr.price_gap_percent,
    pr.price_date,
    round(pr.cheapest_price * (1 + coalesce(input_margin_a, 0)), 2) as sales_a,
    round(pr.cheapest_price * (1 + coalesce(input_margin_b, 0)), 2) as sales_b,
    coalesce(pr.supplier_count, 0)::bigint as supplier_count,
    case when cw.id is null then 'Supplier Only' else 'In Catalog' end as catalog_status,
    pr.notes,
    coalesce(pr.has_notes, false) as has_notes
  from page_rollups pr
  join public.brands b
    on b.id = pr.brand_id
  left join catalog_winners cw
    on cw.organization_id = pr.organization_id
   and cw.brand_id = pr.brand_id
   and cw.normalized_code = pr.normalized_code
  left join public.suppliers cheapest_supplier
    on cheapest_supplier.id = pr.cheapest_supplier_id
  left join public.suppliers second_supplier
    on second_supplier.id = pr.second_supplier_id
  order by pr.rollup_product_code asc nulls last, pr.normalized_code asc nulls last;
$$;

grant execute on function public.cloud_master_priced_export_page_fast(text, uuid, integer, integer, numeric, numeric) to authenticated;
