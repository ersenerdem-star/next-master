-- Resolve quote lines directly from Supabase.
-- Run this in Supabase SQL Editor.

create or replace function cloud_resolve_quote_line(
  input_code text,
  input_brand text default '',
  input_customer_type text default 'A',
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns table (
  found boolean,
  product_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  supplier_id uuid,
  supplier_name text,
  buy_price numeric,
  price_date date,
  sell_price numeric,
  notes text
)
language sql
stable
security definer
set search_path = public
as $$
  with requested_brand as (
    select b.id
    from brands b
    where b.organization_id = current_profile_org_id()
      and b.normalized_name = normalize_part_code(input_brand)
    limit 1
  ),
  catalog_exact as (
    select
      cp.id,
      cp.product_code,
      cp.normalized_code,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.brand_id,
      b.name as brand
    from catalog_products cp
    join brands b on b.id = cp.brand_id
    where cp.organization_id = current_profile_org_id()
      and (
        cp.normalized_code = normalize_part_code(input_code)
        or cp.normalized_oem = normalize_part_code(input_code)
      )
      and (
        coalesce(input_brand, '') = ''
        or cp.brand_id in (select id from requested_brand)
      )
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = normalize_part_code(input_code) then 0 else 1 end,
      case when cp.normalized_oem = normalize_part_code(input_code) then 0 else 1 end,
      b.name,
      cp.product_code
    limit 1
  ),
  supplier_exact as (
    select
      null::uuid as id,
      sp.product_code,
      sp.normalized_code,
      sp.description,
      sp.oem_no,
      null::text as hs_code,
      null::text as origin,
      null::numeric as weight_kg,
      sp.brand_id,
      b.name as brand
    from supplier_prices sp
    join brands b on b.id = sp.brand_id
    where sp.organization_id = current_profile_org_id()
      and sp.is_active
      and sp.buy_price is not null
      and sp.normalized_code = normalize_part_code(input_code)
      and (
        coalesce(input_brand, '') = ''
        or sp.brand_id in (select id from requested_brand)
      )
      and not exists (select 1 from catalog_exact)
    order by
      case when sp.brand_id in (select id from requested_brand) then 0 else 1 end,
      sp.buy_price asc,
      sp.valid_from desc,
      sp.updated_at desc
    limit 1
  ),
  catalog_fuzzy as (
    select
      cp.id,
      cp.product_code,
      cp.normalized_code,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.brand_id,
      b.name as brand
    from catalog_products cp
    join brands b on b.id = cp.brand_id
    where cp.organization_id = current_profile_org_id()
      and not exists (select 1 from catalog_exact)
      and not exists (select 1 from supplier_exact)
      and (
        cp.normalized_code like '%' || normalize_part_code(input_code) || '%'
        or normalize_part_code(input_code) like '%' || cp.normalized_code || '%'
        or (
          nullif(cp.normalized_oem, '') is not null
          and cp.normalized_oem like '%' || normalize_part_code(input_code) || '%'
        )
        or (
          nullif(cp.normalized_oem, '') is not null
          and normalize_part_code(input_code) like '%' || cp.normalized_oem || '%'
        )
      )
      and (
        coalesce(input_brand, '') = ''
        or cp.brand_id in (select id from requested_brand)
      )
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      b.name,
      cp.product_code
    limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all
    select * from supplier_exact
    union all
    select * from catalog_fuzzy
    limit 1
  )
  select
    product_match.id is not null as found,
    product_match.id as product_id,
    coalesce(product_match.product_code, input_code) as product_code,
    product_match.brand,
    product_match.description,
    product_match.oem_no,
    product_match.hs_code,
    product_match.origin,
    product_match.weight_kg,
    best.supplier_id,
    supplier.name as supplier_name,
    best.buy_price,
    best.valid_from as price_date,
    case
      when upper(coalesce(input_customer_type, 'A')) = 'B' then round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2)
    end as sell_price,
    nullif(trim(coalesce(best.notes, '')), '') as notes
  from product_match
  left join lateral (
    select sp.supplier_id, sp.buy_price, sp.valid_from, sp.notes
    from supplier_prices sp
    where sp.organization_id = current_profile_org_id()
      and sp.is_active
      and sp.brand_id = product_match.brand_id
      and sp.normalized_code = product_match.normalized_code
      and sp.buy_price is not null
    order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc
    limit 1
  ) best on true
  left join suppliers supplier on supplier.id = best.supplier_id
  union all
  select
    false,
    null::uuid,
    input_code,
    null::text,
    null::text,
    null::text,
    null::text,
    null::text,
    null::numeric,
    null::uuid,
    null::text,
    null::numeric,
    null::date,
    null::numeric,
    null::text
  where not exists (select 1 from product_match);
$$;

grant execute on function cloud_resolve_quote_line(text, text, text, numeric, numeric) to authenticated;

create or replace function cloud_quote_supplier_options(
  input_code text,
  input_brand text default '',
  input_customer_type text default 'A',
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns table (
  supplier_id uuid,
  supplier_name text,
  buy_price numeric,
  price_date date,
  sell_price numeric,
  notes text
)
language sql
stable
security definer
set search_path = public
as $$
  with requested_brand as (
    select b.id
    from brands b
    where b.organization_id = current_profile_org_id()
      and b.normalized_name = normalize_part_code(input_brand)
    limit 1
  ),
  catalog_exact as (
    select cp.brand_id, cp.normalized_code
    from catalog_products cp
    where cp.organization_id = current_profile_org_id()
      and (
        cp.normalized_code = normalize_part_code(input_code)
        or cp.normalized_oem = normalize_part_code(input_code)
      )
      and (
        coalesce(input_brand, '') = ''
        or cp.brand_id in (select id from requested_brand)
      )
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = normalize_part_code(input_code) then 0 else 1 end,
      case when cp.normalized_oem = normalize_part_code(input_code) then 0 else 1 end,
      cp.product_code
    limit 1
  ),
  supplier_exact as (
    select sp.brand_id, sp.normalized_code
    from supplier_prices sp
    where sp.organization_id = current_profile_org_id()
      and sp.is_active
      and sp.buy_price is not null
      and sp.normalized_code = normalize_part_code(input_code)
      and (
        coalesce(input_brand, '') = ''
        or sp.brand_id in (select id from requested_brand)
      )
      and not exists (select 1 from catalog_exact)
    order by
      case when sp.brand_id in (select id from requested_brand) then 0 else 1 end,
      sp.buy_price asc,
      sp.valid_from desc,
      sp.updated_at desc
    limit 1
  ),
  catalog_fuzzy as (
    select cp.brand_id, cp.normalized_code
    from catalog_products cp
    where cp.organization_id = current_profile_org_id()
      and not exists (select 1 from catalog_exact)
      and not exists (select 1 from supplier_exact)
      and (
        cp.normalized_code like '%' || normalize_part_code(input_code) || '%'
        or normalize_part_code(input_code) like '%' || cp.normalized_code || '%'
        or (
          nullif(cp.normalized_oem, '') is not null
          and cp.normalized_oem like '%' || normalize_part_code(input_code) || '%'
        )
        or (
          nullif(cp.normalized_oem, '') is not null
          and normalize_part_code(input_code) like '%' || cp.normalized_oem || '%'
        )
      )
      and (
        coalesce(input_brand, '') = ''
        or cp.brand_id in (select id from requested_brand)
      )
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      cp.product_code
    limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all
    select * from supplier_exact
    union all
    select * from catalog_fuzzy
    limit 1
  )
  select
    sp.supplier_id,
    supplier.name,
    sp.buy_price,
    sp.valid_from,
    case
      when upper(coalesce(input_customer_type, 'A')) = 'B' then round(coalesce(sp.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(sp.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2)
    end as sell_price,
    nullif(trim(coalesce(sp.notes, '')), '') as notes
  from product_match pm
  join supplier_prices sp
    on sp.organization_id = current_profile_org_id()
   and sp.brand_id = pm.brand_id
   and sp.normalized_code = pm.normalized_code
   and sp.is_active
   and sp.buy_price is not null
  join suppliers supplier on supplier.id = sp.supplier_id
  order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc
  limit 25;
$$;

grant execute on function cloud_quote_supplier_options(text, text, text, numeric, numeric) to authenticated;
