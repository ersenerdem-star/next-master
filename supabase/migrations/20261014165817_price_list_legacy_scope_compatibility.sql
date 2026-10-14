-- Keep existing commercial prices readable during per-supplier migration.
-- A pointer owns its exact tenant/supplier/brand scope, even when invalid:
-- stale legacy rows from that scope must never substitute for its publication.
-- Both customer/admin exports use one source and retain their margin units.
create or replace function public.cloud_price_list_source_page(
  input_organization_id uuid,input_brand_id uuid,
  input_after_normalized_code text default null,input_page_size integer default 1000
) returns table(normalized_code text,product_code text,description text,buy_price numeric,
  price_date date,total_count bigint)
language sql stable security definer set search_path to '' as $function$
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
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and r.normalized_code ~ '[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date
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
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and r.normalized_code ~ '[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date
      union all
      select l.code from legacy l cross join params p where p.after_code is null
    ) codes
  )
  select page.code,page.product_code,page.description,page.buy_price,page.valid_from,
    case when p.after_code is null then t.n else null end
  from page cross join params p cross join first_total t
  order by page.code;
$function$;
revoke all on function public.cloud_price_list_source_page(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.cloud_price_list_source_page(uuid,uuid,text,integer) to service_role;

create or replace function public.cloud_admin_price_list_brands(input_organization_id uuid)
returns table(id uuid,name text)
language sql stable security definer set search_path to '' as $function$
  select b.id,b.name from public.brands b
  where b.organization_id=input_organization_id and (
    exists(select 1 from public.supplier_current_price_pointers ptr
      join public.supplier_price_publications pub on pub.id=ptr.publication_id
        and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
        and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
      join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      where ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        and r.row_status='accepted' and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and r.normalized_code ~ '[A-Z0-9]')
    or exists(select 1 from public.supplier_prices sp
      where sp.organization_id=b.organization_id and sp.brand_id=b.id and sp.is_active
        and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
        and (sp.valid_to is null or sp.valid_to>=current_date)
        and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
        and not exists(select 1 from public.supplier_current_price_pointers ptr
          where ptr.organization_id=sp.organization_id and ptr.supplier_id=sp.supplier_id and ptr.brand_id=sp.brand_id))
  ) order by b.name,b.id;
$function$;
revoke all on function public.cloud_admin_price_list_brands(uuid) from public,anon,authenticated;
grant execute on function public.cloud_admin_price_list_brands(uuid) to service_role;

create or replace function public.cloud_admin_price_list_page_fast(
  input_organization_id uuid,input_brand_id uuid,input_price_list_type text default 'A',
  input_margin numeric default 0,input_after_product_code text default null,
  input_after_normalized_code text default null,input_page_size integer default 1000
) returns table(normalized_code text,product_code text,brand text,description text,oem_no text,
  hs_code text,origin text,weight_kg numeric,price_list_type text,sales_price numeric,
  price_date date,lifecycle_status text,lifecycle_note text,total_count bigint)
language sql stable security definer set search_path to '' as $function$
  select pr.normalized_code,
    coalesce(nullif(btrim(cp.product_code),''),nullif(btrim(pr.product_code),''),pr.normalized_code),
    b.name,coalesce(nullif(btrim(cp.description),''),nullif(btrim(pr.description),''),''),
    coalesce(nullif(btrim(cp.oem_no),''),''),coalesce(nullif(btrim(cp.hs_code),''),''),
    coalesce(nullif(btrim(cp.origin),''),''),cp.weight_kg,
    case when upper(btrim(coalesce(input_price_list_type,'A'))) in ('A','B')
      then upper(btrim(coalesce(input_price_list_type,'A'))) else 'A' end,
    round(pr.buy_price*(1+coalesce(input_margin,0)),2),pr.price_date,
    coalesce(nullif(btrim(cp.lifecycle_status),''),'active'),nullif(btrim(cp.lifecycle_note),''),pr.total_count
  from public.cloud_price_list_source_page(input_organization_id,input_brand_id,input_after_normalized_code,input_page_size) pr
  join public.brands b on b.id=input_brand_id and b.organization_id=input_organization_id
  left join lateral (
    select c.product_code,c.description,c.oem_no,c.hs_code,c.origin,c.weight_kg,c.lifecycle_status,c.lifecycle_note
    from public.catalog_products c where c.organization_id=input_organization_id and c.brand_id=input_brand_id
      and public.normalize_catalog_product_code(c.product_code)=pr.normalized_code
    order by c.product_code asc nulls last,c.id limit 1
  ) cp on true order by pr.normalized_code collate "C";
$function$;
revoke all on function public.cloud_admin_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer) from public,anon,authenticated;
grant execute on function public.cloud_admin_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer) to service_role;

create or replace function public.cloud_portal_customer_price_list_page_fast(
  input_organization_id uuid,input_brand_id uuid,input_price_list_type text default 'A',
  input_margin_percent numeric default 0,input_after_product_code text default null,
  input_after_normalized_code text default null,input_page_size integer default 1000
) returns table(normalized_code text,product_code text,brand text,description text,price_list_type text,
  sales_price numeric,price_date date,lifecycle_status text,lifecycle_note text,total_count bigint)
language sql stable security definer set search_path to '' as $function$
  -- The account resolver supplies custom percentages via the existing A path.
  -- Never read the account's margin or accept browser authorization here.
  select a.normalized_code,a.product_code,a.brand,a.description,a.price_list_type,
    a.sales_price,a.price_date,a.lifecycle_status,a.lifecycle_note,a.total_count
  from public.cloud_admin_price_list_page_fast(input_organization_id,input_brand_id,input_price_list_type,
    coalesce(input_margin_percent,0)/100,input_after_product_code,input_after_normalized_code,input_page_size) a
  order by a.normalized_code collate "C";
$function$;
revoke all on function public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer) from public,anon,authenticated;
grant execute on function public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer) to service_role;

create or replace function public.get_admin_price_list_export_version(input_organization_id uuid,input_brand_id uuid)
returns text language sql stable security definer set search_path to '' as $function$
  with pointers as materialized (
    select ptr.*,pub.status publication_status,pub.published_at,pub.created_at
    from public.supplier_current_price_pointers ptr
    left join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id
    where ptr.organization_id=input_organization_id and ptr.brand_id=input_brand_id
  ), legacy as materialized (
    select sp.id,sp.supplier_id,sp.product_code,sp.description,sp.buy_price,sp.currency,
      sp.valid_from,sp.valid_to,sp.updated_at
    from public.supplier_prices sp where sp.organization_id=input_organization_id
      and sp.brand_id=input_brand_id and sp.is_active
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  )
  select md5('price-source-legacy-compatible-v1:'||coalesce(input_organization_id::text,'')||':'||coalesce(input_brand_id::text,'')||':'||
    coalesce((select count(*)::text||':'||coalesce(extract(epoch from max(spr.refreshed_at))::text,'')
      from public.supplier_price_rollups spr where spr.organization_id=input_organization_id
        and spr.brand_id=input_brand_id and spr.cheapest_price is not null),'')||':'||
    coalesce((select count(*)::text||':'||coalesce(extract(epoch from max(cp.updated_at))::text,'')
      from public.catalog_products cp where cp.organization_id=input_organization_id and cp.brand_id=input_brand_id),'')||':'||
    coalesce((select b.name from public.brands b where b.id=input_brand_id and b.organization_id=input_organization_id),'')||':'||
    coalesce((select string_agg(jsonb_build_array(ptr.supplier_id,ptr.release_id,ptr.publication_id,
      ptr.publication_status,extract(epoch from ptr.published_at),extract(epoch from ptr.created_at))::text,',' order by ptr.supplier_id) from pointers ptr),'')||':'||
    coalesce((select jsonb_agg(jsonb_build_array(ref.id,ref.old_code,ref.new_code,ref.is_active,extract(epoch from ref.updated_at)) order by ref.id)::text
      from public.item_code_references ref where ref.organization_id=input_organization_id and ref.brand_id=input_brand_id),'[]')||':'||
    coalesce((select min(r.valid_from)::text from pointers ptr
      cross join lateral(select rr.valid_from from public.supplier_price_release_rows rr
        where ptr.publication_status='published' and rr.release_id=ptr.release_id and rr.row_status='accepted'
          and rr.buy_price>0 and rr.currency='EUR' and rr.valid_from>current_date
        order by rr.valid_from limit 1) r),'')||':'||
    -- Hash the actual fallback source, not a periodic rollup. This detects
    -- same-count replacement and edits even if max(updated_at) is unchanged.
    coalesce((select string_agg(md5(jsonb_build_array(l.id,l.supplier_id,l.product_code,l.description,
      l.buy_price,l.currency,l.valid_from,l.valid_to,extract(epoch from l.updated_at))::text),',' order by l.id) from legacy l),'')||':'||
    case when exists(select 1 from legacy) then current_date::text else '' end);
$function$;
revoke all on function public.get_admin_price_list_export_version(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_admin_price_list_export_version(uuid,uuid) to service_role;
