-- Customer price list fast export page RPC.
-- Page rollups first, then set-based catalog enrichment for customer price list exports.

drop function if exists public.cloud_customer_price_list_export_page_fast(uuid, text, numeric, integer, integer);

create or replace function public.cloud_customer_price_list_export_page_fast(
  input_brand_id uuid default null,
  input_price_list_type text default 'A',
  input_margin numeric default 0.10,
  input_page integer default 1,
  input_page_size integer default 5000
)
returns table (
  product_code text,
  brand text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  price_list_type text,
  sales_price numeric,
  price_date date,
  notes text
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
      case
        when upper(trim(coalesce(input_price_list_type, 'A'))) in ('A', 'B')
          then upper(trim(coalesce(input_price_list_type, 'A')))
        else null
      end as price_list_type,
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
      spr.cheapest_price,
      spr.price_date,
      spr.notes
    from params p
    join public.supplier_price_rollups spr
      on spr.organization_id = p.org_id
     and p.brand_id is not null
     and p.price_list_type is not null
     and spr.brand_id = p.brand_id
     and spr.cheapest_price is not null
    where p.org_id is not null
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
    coalesce(nullif(cw.product_code, ''), nullif(pr.rollup_product_code, ''), pr.normalized_code) as product_code,
    b.name as brand,
    coalesce(nullif(cw.description, ''), nullif(pr.rollup_description, ''), '') as description,
    coalesce(nullif(cw.oem_no, ''), nullif(pr.rollup_oem_no, ''), '') as oem_no,
    cw.hs_code,
    cw.origin,
    cw.weight_kg,
    p.price_list_type,
    round(pr.cheapest_price * (1 + coalesce(input_margin, 0)), 2) as sales_price,
    pr.price_date,
    pr.notes
  from page_rollups pr
  join params p
    on true
  join public.brands b
    on b.id = pr.brand_id
  left join catalog_winners cw
    on cw.organization_id = pr.organization_id
   and cw.brand_id = pr.brand_id
   and cw.normalized_code = pr.normalized_code
  order by pr.rollup_product_code asc nulls last, pr.normalized_code asc nulls last;
$$;

grant execute on function public.cloud_customer_price_list_export_page_fast(uuid, text, numeric, integer, integer) to authenticated;
grant execute on function public.cloud_customer_price_list_export_page_fast(uuid, text, numeric, integer, integer) to service_role;
