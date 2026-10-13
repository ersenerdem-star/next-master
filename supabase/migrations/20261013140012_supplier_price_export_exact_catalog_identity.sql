-- Catalog enrichment must use the same punctuation-preserving SKU identity as
-- the published release. catalog_products.normalized_code is a legacy compact
-- lookup key and can conflate 61/1 with 611. Preserve the page, total, tenant,
-- price and service-role contracts from 20261013140010.

create index if not exists idx_catalog_products_export_exact_code
  on public.catalog_products
  (organization_id, brand_id, public.normalize_catalog_product_code(product_code));

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
      and r.normalized_code ~ '[A-Z0-9]'
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
          and r.normalized_code ~ '[A-Z0-9]'
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
          and r.normalized_code ~ '[A-Z0-9]'
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
  left join lateral (
    select c.product_code, c.description, c.lifecycle_status, c.lifecycle_note
    from public.catalog_products c
    where c.organization_id = p.organization_id
      and c.brand_id = p.brand_id
      and public.normalize_catalog_product_code(c.product_code) = pr.normalized_code
    order by c.product_code asc nulls last, c.id
    limit 1
  ) cp on true
  order by pr.normalized_code asc;
$$;

-- This SECURITY DEFINER RPC takes arbitrary organization and margin inputs.
-- Preserve the service-only boundary established by the preceding migration.
revoke all on function public.cloud_portal_customer_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer) from public, anon, authenticated;
grant execute on function public.cloud_portal_customer_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer) to service_role;

CREATE OR REPLACE FUNCTION public.cloud_admin_price_list_page_fast(input_organization_id uuid, input_brand_id uuid, input_price_list_type text DEFAULT 'A'::text, input_margin numeric DEFAULT 0, input_after_product_code text DEFAULT NULL::text, input_after_normalized_code text DEFAULT NULL::text, input_page_size integer DEFAULT 1000)
 RETURNS TABLE(normalized_code text, product_code text, brand text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, price_list_type text, sales_price numeric, price_date date, lifecycle_status text, lifecycle_note text, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with params as materialized (select input_organization_id organization_id,input_brand_id brand_id,case when upper(trim(coalesce(input_price_list_type,'A'))) in ('A','B') then upper(trim(coalesce(input_price_list_type,'A'))) else 'A' end price_list_type,coalesce(input_margin,0) margin,nullif(trim(coalesce(input_after_normalized_code,'')),'') after_normalized_code,least(greatest(coalesce(input_page_size,1000),1),5000) page_size),
  current_release as materialized (select ptr.release_id from public.supplier_current_price_pointers ptr join public.supplier_price_publications pub on pub.id=ptr.publication_id and pub.status='published' join params p on p.organization_id=ptr.organization_id and p.brand_id=ptr.brand_id),
  total_release_count as materialized (select count(distinct r.normalized_code)::bigint total_count from public.supplier_price_release_rows r join current_release cr on cr.release_id=r.release_id join params p on true where r.row_status='accepted' and r.buy_price is not null and nullif(trim(coalesce(r.normalized_code,'')),'') is not null and r.normalized_code ~ '[A-Z0-9]' and p.after_normalized_code is null),
  page_rows as materialized (select distinct on (r.normalized_code) r.normalized_code,nullif(trim(coalesce(r.product_code,'')),'') release_product_code,nullif(trim(coalesce(r.description,'')),'') release_description,r.buy_price,r.valid_from from public.supplier_price_release_rows r join current_release cr on cr.release_id=r.release_id join params p on true where r.row_status='accepted' and r.buy_price is not null and nullif(trim(coalesce(r.normalized_code,'')),'') is not null and r.normalized_code ~ '[A-Z0-9]' and (p.after_normalized_code is null or r.normalized_code>p.after_normalized_code) order by r.normalized_code asc,r.buy_price asc,r.id asc limit (select page_size from params)),
  catalog_winners as materialized (select distinct on (cp.organization_id,cp.brand_id,pr.normalized_code) cp.organization_id,cp.brand_id,pr.normalized_code,nullif(trim(coalesce(cp.product_code,'')),'') product_code,nullif(trim(coalesce(cp.description,'')),'') description,nullif(trim(coalesce(cp.oem_no,'')),'') oem_no,nullif(trim(coalesce(cp.hs_code,'')),'') hs_code,nullif(trim(coalesce(cp.origin,'')),'') origin,cp.weight_kg,nullif(trim(coalesce(cp.lifecycle_status,'')),'') lifecycle_status,nullif(trim(coalesce(cp.lifecycle_note,'')),'') lifecycle_note from public.catalog_products cp join page_rows pr on public.normalize_catalog_product_code(cp.product_code)=pr.normalized_code join params p on p.organization_id=cp.organization_id and p.brand_id=cp.brand_id order by cp.organization_id,cp.brand_id,pr.normalized_code,cp.product_code asc nulls last,cp.id)
  select pr.normalized_code,coalesce(cw.product_code,pr.release_product_code,pr.normalized_code),b.name,coalesce(cw.description,pr.release_description,''),coalesce(cw.oem_no,''),coalesce(cw.hs_code,''),coalesce(cw.origin,''),cw.weight_kg,p.price_list_type,round(pr.buy_price*(1+p.margin),2),pr.valid_from,coalesce(cw.lifecycle_status,'active'),cw.lifecycle_note,tc.total_count from page_rows pr join params p on true left join total_release_count tc on true join public.brands b on b.id=p.brand_id left join catalog_winners cw on cw.organization_id=p.organization_id and cw.brand_id=p.brand_id and cw.normalized_code=pr.normalized_code order by pr.normalized_code asc;
$function$;

revoke all on function public.cloud_admin_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer) from public, anon, authenticated;
grant execute on function public.cloud_admin_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer) to service_role;
