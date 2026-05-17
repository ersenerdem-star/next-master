-- Cloud Master RPC for paginated/searchable master rows.
-- Run this in Supabase SQL Editor.

drop function if exists cloud_master_page(text, text, integer, integer, numeric, numeric, text);

create or replace function cloud_master_page(
  input_search text default '',
  input_brand text default '',
  input_page integer default 1,
  input_page_size integer default 250,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15,
  input_scope text default 'catalog'
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
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      normalize_part_code(input_search) as search_norm,
      nullif(trim(coalesce(input_brand, '')), '') as raw_brand,
      normalize_part_code(input_brand) as brand_norm,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset,
      coalesce(input_scope, 'catalog') as scope_name
  ),
  brand_filter as (
    select
      p.raw_search,
      p.search_norm,
      p.raw_brand,
      p.brand_norm,
      p.page_size,
      p.row_offset,
      p.scope_name,
      (p.search_norm <> '' and length(p.search_norm) >= 5) as search_is_code,
      array_remove(array_agg(b.id), null) as brand_ids
    from params p
    left join brands b
      on b.organization_id = current_profile_org_id()
     and (p.raw_brand is null or b.normalized_name = p.brand_norm)
    group by
      p.raw_search,
      p.search_norm,
      p.raw_brand,
      p.brand_norm,
      p.page_size,
      p.row_offset,
      p.scope_name
  ),
  filtered_supplier_prices as (
    select
      sp.brand_id,
      sp.normalized_code,
      sp.product_code,
      sp.description,
      sp.oem_no,
      sp.normalized_oem,
      sp.supplier_id,
      sp.buy_price,
      sp.valid_from,
      sp.updated_at
    from supplier_prices sp
    cross join brand_filter f
    where sp.organization_id = current_profile_org_id()
      and sp.is_active
      and sp.buy_price is not null
      and (
        f.raw_brand is null
        or sp.brand_id = any(f.brand_ids)
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            sp.normalized_code = f.search_norm
            or sp.normalized_oem = f.search_norm
            or sp.normalized_code like f.search_norm || '%'
            or (
              nullif(sp.normalized_oem, '') is not null
              and sp.normalized_oem like f.search_norm || '%'
            )
          )
        )
        or (
          not f.search_is_code
          and (
            sp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(sp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(sp.oem_no, '') ilike '%' || f.raw_search || '%'
            or sp.normalized_code like '%' || f.search_norm || '%'
            or (
              nullif(sp.normalized_oem, '') is not null
              and sp.normalized_oem like '%' || f.search_norm || '%'
            )
          )
        )
      )
  ),
  supplier_best as (
    select distinct on (fsp.brand_id, fsp.normalized_code)
      fsp.brand_id,
      fsp.normalized_code,
      fsp.product_code,
      fsp.description,
      fsp.oem_no,
      fsp.normalized_oem,
      fsp.supplier_id,
      fsp.buy_price,
      fsp.valid_from,
      fsp.updated_at
    from filtered_supplier_prices fsp
    order by fsp.brand_id, fsp.normalized_code, fsp.buy_price asc, fsp.valid_from desc, fsp.updated_at desc
  ),
  combined as (
    select
      cp.id,
      sb.brand_id,
      coalesce(cp.product_code, sb.product_code) as product_code,
      sb.normalized_code,
      coalesce(nullif(cp.description, ''), sb.description) as description,
      coalesce(nullif(cp.oem_no, ''), sb.oem_no) as oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      sb.supplier_id,
      sb.buy_price,
      sb.valid_from,
      case when cp.id is null then 'Supplier Only'::text else 'In Catalog'::text end as catalog_status
    from supplier_best sb
    cross join brand_filter f
    left join catalog_products cp
      on cp.organization_id = current_profile_org_id()
     and cp.brand_id = sb.brand_id
     and cp.normalized_code = sb.normalized_code
    where f.scope_name = 'all'
       or cp.id is not null
  ),
  counted as (
    select
      c.*,
      b.name as brand,
      count(*) over () as total_count,
      row_number() over (order by b.name, c.product_code) as row_no
    from combined c
    join brands b on b.id = c.brand_id
  ),
  paged as (
    select counted.*
    from counted
    cross join brand_filter f
    where counted.row_no > f.row_offset
      and counted.row_no <= (f.row_offset + f.page_size)
  )
  select
    paged.total_count,
    paged.id as product_id,
    paged.product_code,
    paged.brand,
    paged.description,
    paged.oem_no,
    paged.hs_code,
    paged.origin,
    paged.weight_kg,
    supplier.name as cheapest_supplier,
    paged.buy_price as cheapest_price,
    paged.valid_from as price_date,
    round(coalesce(paged.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2) as sales_a,
    round(coalesce(paged.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2) as sales_b,
    coalesce(note_stats.supplier_count, 0) as supplier_count,
    paged.catalog_status,
    note_stats.notes,
    coalesce(note_stats.has_notes, false) as has_notes
  from paged
  left join suppliers supplier on supplier.id = paged.supplier_id
  left join lateral (
    select
      count(distinct sp.supplier_id)::bigint as supplier_count,
      string_agg(distinct nullif(trim(coalesce(sp.notes, '')), ''), ' | ') as notes,
      bool_or(nullif(trim(coalesce(sp.notes, '')), '') is not null) as has_notes
    from supplier_prices sp
    where sp.organization_id = current_profile_org_id()
      and sp.is_active
      and sp.brand_id = paged.brand_id
      and sp.normalized_code = paged.normalized_code
      and sp.buy_price is not null
  ) note_stats on true;
$$;

grant execute on function cloud_master_page(text, text, integer, integer, numeric, numeric, text) to authenticated;
