-- Master fast catalog page RPC.
-- Adds a new UUID-based fast path without replacing public.cloud_master_page.

create index if not exists idx_supplier_price_rollups_org_brand_priced_product_code
  on public.supplier_price_rollups (organization_id, brand_id, product_code, normalized_code)
  where cheapest_price is not null;

drop function if exists public.cloud_master_page_fast(text, uuid, integer, integer, numeric, numeric);

create or replace function public.cloud_master_page_fast(
  input_search text default '',
  input_brand_id uuid default null,
  input_page integer default 1,
  input_page_size integer default 50,
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
  with params as (
    select
      public.current_profile_org_id() as org_id,
      input_brand_id as brand_id,
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      nullif(public.normalize_part_code(input_search), '') as search_norm,
      least(greatest(input_page_size, 1), 250) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 250)) as row_offset
  )
  select
    null::bigint as total_count,
    cp.id as product_id,
    cp.product_code,
    b.name as brand,
    coalesce(cp.description, '') as description,
    coalesce(cp.oem_no, '') as oem_no,
    cp.hs_code,
    cp.origin,
    cp.weight_kg,
    coalesce(cheapest_supplier.name, '') as cheapest_supplier,
    spr.cheapest_price,
    coalesce(nullif(spr.second_supplier_name, ''), second_supplier.name, '') as second_supplier_name,
    spr.second_price,
    spr.price_gap,
    spr.price_gap_percent,
    spr.price_date,
    case
      when spr.cheapest_price is null then null
      else round(spr.cheapest_price * (1 + coalesce(input_margin_a, 0)), 2)
    end as sales_a,
    case
      when spr.cheapest_price is null then null
      else round(spr.cheapest_price * (1 + coalesce(input_margin_b, 0)), 2)
    end as sales_b,
    coalesce(spr.supplier_count, 0)::bigint as supplier_count,
    'In Catalog'::text as catalog_status,
    spr.notes,
    coalesce(spr.has_notes, false) as has_notes
  from params p
  join public.catalog_products cp
    on cp.organization_id = p.org_id
   and p.brand_id is not null
   and cp.brand_id = p.brand_id
  join public.brands b
    on b.id = cp.brand_id
  left join public.supplier_price_rollups spr
    on spr.organization_id = cp.organization_id
   and spr.brand_id = cp.brand_id
   and spr.normalized_code = cp.normalized_code
  left join public.suppliers cheapest_supplier
    on cheapest_supplier.id = spr.cheapest_supplier_id
  left join public.suppliers second_supplier
    on second_supplier.id = spr.second_supplier_id
  where p.org_id is not null
    and (
      p.raw_search is null
      or cp.product_code ilike '%' || p.raw_search || '%'
      or coalesce(cp.description, '') ilike '%' || p.raw_search || '%'
      or coalesce(cp.oem_no, '') ilike '%' || p.raw_search || '%'
      or (
        p.search_norm is not null
        and (
          cp.normalized_code = p.search_norm
          or cp.normalized_oem = p.search_norm
          or cp.normalized_code like p.search_norm || '%'
          or cp.normalized_oem like p.search_norm || '%'
        )
      )
    )
  order by cp.product_code asc nulls last, cp.normalized_code asc nulls last
  limit (select page_size from params)
  offset (select row_offset from params);
$$;

grant execute on function public.cloud_master_page_fast(text, uuid, integer, integer, numeric, numeric) to authenticated;
