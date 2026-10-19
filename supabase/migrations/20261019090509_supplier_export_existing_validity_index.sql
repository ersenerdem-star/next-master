-- Reuse the existing validity-covering index; no full-table index build.
-- Whitespace removal commutes with uppercase. NULL/empty remain excluded by
-- the unchanged alphanumeric eligibility filter. All price/pointer rules stay.
CREATE OR REPLACE FUNCTION public.cloud_price_list_source_page(input_organization_id uuid, input_brand_id uuid, input_after_normalized_code text DEFAULT NULL::text, input_page_size integer DEFAULT 1000)
 RETURNS TABLE(normalized_code text, product_code text, description text, buy_price numeric, price_date date, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with params as materialized (
    select input_organization_id org_id,input_brand_id brand_id,
      nullif(btrim(input_after_normalized_code),'') after_code,
      least(greatest(coalesce(input_page_size,1000),1),5000) page_size
  ), pointers as materialized (
    select ptr.* from public.supplier_current_price_pointers ptr cross join params p
    where ptr.organization_id=p.org_id and ptr.brand_id=p.brand_id
  ), releases as materialized (
    select ptr.release_id,ptr.supplier_id from pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
  ), legacy as not materialized (
    select public.normalize_catalog_product_code(sp.product_code) collate "C" code,
      sp.supplier_id,sp.product_code,sp.description,sp.buy_price,sp.valid_from,sp.id::text source_id
    from public.supplier_prices sp cross join params p
    where sp.organization_id=p.org_id and sp.brand_id=p.brand_id and sp.is_active
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  ), release_pages as materialized (
    select rel.supplier_id,candidate.* from releases rel cross join params p
    cross join lateral (
      select distinct on (r.normalized_code collate "C") r.normalized_code collate "C" code,
        r.product_code,r.description,r.buy_price,r.valid_from,r.id::text source_id,r.id published_order_id
      from public.supplier_price_release_rows r
      where r.release_id=rel.release_id and r.row_status='accepted'
        and r.normalized_code=upper(regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
        and r.normalized_code<>''
        and r.normalized_code ~ '[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code collate "C">coalesce(p.after_code,'') collate "C"
      order by r.normalized_code collate "C",r.buy_price,r.id
      limit p.page_size
    ) candidate
  ), legacy_latest as materialized (
    select distinct on (l.code,l.supplier_id) l.* from legacy l cross join params p
    where l.code>coalesce(p.after_code,'') collate "C"
    order by l.code,l.supplier_id,l.valid_from desc,l.source_id desc
  ), legacy_page as materialized (
    select distinct on (l.code) l.* from legacy_latest l
    order by l.code,l.buy_price,l.valid_from desc,l.supplier_id
    limit (select page_size from params)
  ), candidates as (
    select r.code,r.supplier_id,r.product_code,r.description,r.buy_price,r.valid_from,r.source_id,r.published_order_id from release_pages r
    union all
    select l.code,l.supplier_id,l.product_code,l.description,l.buy_price,l.valid_from,l.source_id,null from legacy_page l
  ), page as materialized (
    select distinct on (c.code) c.* from candidates c
    -- Preserve existing published equal-price selection by the native row ID.
    -- Legacy-only candidates retain newest-date/supplier deterministic ties.
    order by c.code,c.buy_price,c.published_order_id asc nulls last,c.valid_from desc,c.supplier_id
    limit (select page_size from params)
  ), first_total as materialized (
    select count(distinct codes.code)::bigint n from (
      select r.normalized_code collate "C" code from releases rel cross join params p
      join public.supplier_price_release_rows r on r.release_id=rel.release_id
      where p.after_code is null and r.row_status='accepted'
        and r.normalized_code=upper(regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
        and r.normalized_code<>''
        and r.normalized_code ~ '[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
      union all
      select l.code from legacy l cross join params p where p.after_code is null
    ) codes
  )
  select page.code,page.product_code,page.description,page.buy_price,page.valid_from,
    case when p.after_code is null then t.n else null end
  from page cross join params p cross join first_total t
  order by page.code;
$function$;

REVOKE ALL ON FUNCTION public.cloud_price_list_source_page(uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_price_list_source_page(uuid,uuid,text,integer) TO service_role;

