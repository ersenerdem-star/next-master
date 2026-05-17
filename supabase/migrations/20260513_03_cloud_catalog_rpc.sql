-- Cloud catalog page for large datasets.
-- Run this in Supabase SQL Editor.

create or replace function cloud_catalog_page(
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 250
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
  weight_kg numeric
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
      greatest(input_page, 1) as page_no,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset
  ),
  search_flags as (
    select
      raw_search,
      search_norm,
      page_no,
      page_size,
      row_offset,
      (search_norm <> '' and length(search_norm) >= 5) as search_is_code
    from params
  ),
  filtered as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg
    from catalog_products cp
    join brands b on b.id = cp.brand_id
    cross join search_flags f
    where cp.organization_id = current_profile_org_id()
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            cp.normalized_code = f.search_norm
            or cp.normalized_oem = f.search_norm
            or cp.normalized_code like f.search_norm || '%'
            or cp.normalized_oem like f.search_norm || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
            or b.name ilike '%' || f.raw_search || '%'
            or cp.normalized_code like '%' || f.search_norm || '%'
            or (
              nullif(cp.normalized_oem, '') is not null
              and cp.normalized_oem like '%' || f.search_norm || '%'
            )
          )
        )
      )
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count,
      row_number() over (order by filtered.product_code) as row_no
    from filtered
  ),
  paged as (
    select counted.*
    from counted
    cross join search_flags f
    where counted.row_no > f.row_offset
      and counted.row_no <= (f.row_offset + f.page_size)
  )
  select
    total_count,
    id,
    product_code,
    brand,
    description,
    oem_no,
    hs_code,
    origin,
    weight_kg
  from paged;
$$;

grant execute on function cloud_catalog_page(text, integer, integer) to authenticated;
