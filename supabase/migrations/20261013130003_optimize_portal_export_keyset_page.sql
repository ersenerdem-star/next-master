-- Keep the published-release export scoped to the requested organization and
-- brand, but stop each release scan once it has enough distinct codes for one
-- page. The final DISTINCT ON still selects the cheapest row across suppliers.
-- The two mutually exclusive branches retain the exact first-page predicate:
-- a nonblank code is not assumed to sort above the empty string.

create or replace function public.cloud_portal_customer_price_list_page_fast(
  input_organization_id uuid,
  input_brand_id uuid,
  input_price_list_type text default 'A',
  input_margin_percent numeric default 0,
  input_after_product_code text default null,
  input_after_normalized_code text default null,
  input_page_size integer default 1000
)
returns table(
  normalized_code text,
  product_code text,
  brand text,
  description text,
  price_list_type text,
  sales_price numeric,
  price_date date,
  lifecycle_status text,
  lifecycle_note text,
  total_count bigint
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with params as materialized (
    select input_organization_id as organization_id,
      input_brand_id as brand_id,
      case when upper(trim(coalesce(input_price_list_type, 'A'))) in ('A', 'B')
        then upper(trim(coalesce(input_price_list_type, 'A'))) else 'A' end as price_list_type,
      coalesce(input_margin_percent, 0) as margin_percent,
      nullif(trim(coalesce(input_after_normalized_code, '')), '') as after_normalized_code,
      least(greatest(coalesce(input_page_size, 1000), 1), 5000) as page_size
  ),
  current_release as materialized (
    select ptr.release_id
    from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id
     and pub.status = 'published'
    join params p
      on p.organization_id = ptr.organization_id
     and p.brand_id = ptr.brand_id
  ),
  total_release_count as materialized (
    select count(distinct r.normalized_code)::bigint as total_count
    from public.supplier_price_release_rows r
    join current_release cr on cr.release_id = r.release_id
    join params p on true
    where r.row_status = 'accepted'
      and r.buy_price is not null
      and nullif(trim(coalesce(r.normalized_code, '')), '') is not null
      and p.after_normalized_code is null
  ),
  page_rows as materialized (
    select distinct on (x.normalized_code)
      x.normalized_code, x.release_product_code, x.release_description,
      x.buy_price, x.valid_from
    from current_release cr
    cross join params p
    cross join lateral (
      select * from (
        select distinct on (r.normalized_code)
          r.normalized_code,
          nullif(trim(coalesce(r.product_code, '')), '') as release_product_code,
          nullif(trim(coalesce(r.description, '')), '') as release_description,
          r.buy_price, r.valid_from, r.id
        from public.supplier_price_release_rows r
        where p.after_normalized_code is null
          and r.release_id = cr.release_id
          and r.row_status = 'accepted'
          and r.buy_price is not null
          and nullif(trim(coalesce(r.normalized_code, '')), '') is not null
        order by r.normalized_code, r.buy_price, r.id
        limit p.page_size
      ) first_page
      union all
      select * from (
        select distinct on (r.normalized_code)
          r.normalized_code,
          nullif(trim(coalesce(r.product_code, '')), '') as release_product_code,
          nullif(trim(coalesce(r.description, '')), '') as release_description,
          r.buy_price, r.valid_from, r.id
        from public.supplier_price_release_rows r
        where p.after_normalized_code is not null
          and r.release_id = cr.release_id
          and r.row_status = 'accepted'
          and r.buy_price is not null
          and nullif(trim(coalesce(r.normalized_code, '')), '') is not null
          and r.normalized_code > p.after_normalized_code
        order by r.normalized_code, r.buy_price, r.id
        limit p.page_size
      ) following_page
    ) x
    order by x.normalized_code, x.buy_price, x.id
    limit (select page_size from params)
  )
  select pr.normalized_code,
    coalesce(nullif(trim(cp.product_code), ''), pr.release_product_code, pr.normalized_code),
    b.name,
    coalesce(nullif(trim(cp.description), ''), pr.release_description, ''),
    p.price_list_type,
    round(pr.buy_price * (1 + p.margin_percent / 100), 2),
    pr.valid_from,
    coalesce(nullif(trim(cp.lifecycle_status), ''), 'active'),
    nullif(trim(coalesce(cp.lifecycle_note, '')), ''),
    tc.total_count
  from page_rows pr
  join params p on true
  left join total_release_count tc on true
  join public.brands b on b.id = p.brand_id
  left join public.catalog_products cp
    on cp.organization_id = p.organization_id
   and cp.brand_id = p.brand_id
   and cp.normalized_code = pr.normalized_code
  order by pr.normalized_code asc;
$$;

-- This SECURITY DEFINER RPC takes arbitrary organization and margin inputs.
-- Preserve the service-only boundary established by the preceding migration.
revoke all on function public.cloud_portal_customer_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer) from public, anon, authenticated;
grant execute on function public.cloud_portal_customer_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer) to service_role;
