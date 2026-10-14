-- Record the previously out-of-band catalog RPCs, close PUBLIC execution,
-- and give background exports bounded keyset sources for full-size lists.
-- A/B prices use the published release selected by the current pointer.
-- Legacy rollups are used only where the brand has no V3 pointer.

CREATE OR REPLACE FUNCTION public.cloud_catalog_export_fast(input_organization_id uuid, input_brand_id uuid, input_market_segment text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with params as materialized (
    select
      input_organization_id as organization_id,
      input_brand_id as brand_id,
      nullif(trim(coalesce(input_market_segment, '')), '') as market_segment
  ),
  catalog_rows as materialized (
    select
      cp.id,
      nullif(trim(coalesce(cp.product_code, '')), '') as product_code,
      b.name as brand,
      nullif(trim(coalesce(cp.ean, '')), '') as ean,
      nullif(trim(coalesce(cp.description, '')), '') as description,
      nullif(trim(coalesce(cp.description_tr, '')), '') as description_tr,
      nullif(trim(coalesce(cp.oem_no, '')), '') as oem_no,
      nullif(trim(coalesce(cp.vehicle, '')), '') as vehicle,
      nullif(trim(coalesce(cp.vehicle_model, '')), '') as vehicle_model,
      nullif(trim(coalesce(cp.hs_code, '')), '') as hs_code,
      nullif(trim(coalesce(cp.origin, '')), '') as origin,
      nullif(trim(coalesce(cp.market_segment, '')), '') as market_segment,
      cp.weight_kg,
      nullif(trim(coalesce(cp.image_url, '')), '') as image_url,
      nullif(trim(coalesce(cp.lifecycle_status, '')), '') as lifecycle_status,
      nullif(trim(coalesce(cp.lifecycle_note, '')), '') as lifecycle_note
    from public.catalog_products cp
    join params p
      on p.organization_id = cp.organization_id
     and p.brand_id = cp.brand_id
    join public.brands b
      on b.id = cp.brand_id
     and b.organization_id = cp.organization_id
    where p.market_segment is null
       or cp.market_segment = p.market_segment
    order by cp.product_code asc nulls last, cp.id asc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_array(
        product_code,
        brand,
        ean,
        description,
        description_tr,
        oem_no,
        vehicle,
        vehicle_model,
        hs_code,
        origin,
        market_segment,
        weight_kg,
        image_url,
        coalesce(lifecycle_status, 'active'),
        lifecycle_note
      )
      order by product_code asc nulls last, id asc
    ),
    '[]'::jsonb
  )
  from catalog_rows;
$function$
;

CREATE OR REPLACE FUNCTION public.get_catalog_export_version(input_organization_id uuid, input_brand_id uuid, input_market_segment text DEFAULT ''::text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with params as (
    select
      input_organization_id as organization_id,
      input_brand_id as brand_id,
      nullif(trim(coalesce(input_market_segment, '')), '') as market_segment
  )
  select md5(
    coalesce(p.organization_id::text, '') || ':' ||
    coalesce(p.brand_id::text, '') || ':' ||
    coalesce(p.market_segment, '') || ':' ||
    coalesce((
      select count(*)::text || ':' ||
             coalesce(max(cp.updated_at)::text, '') || ':' ||
             coalesce(max(cp.id::text), '')
      from public.catalog_products cp
      where cp.organization_id = p.organization_id
        and cp.brand_id = p.brand_id
        and (p.market_segment is null or cp.market_segment = p.market_segment)
    ), '0:')
  )
  from params p;
$function$
;


create or replace function public.get_catalog_master_export_version(
  input_organization_id uuid, input_brand_id uuid, input_scope text default 'priced'
) returns text language sql stable security definer set search_path to '' as $function$
  select md5(coalesce(input_scope, 'priced') || ':' ||
    public.get_admin_price_list_export_version(input_organization_id,input_brand_id) || ':' ||
    coalesce((select string_agg(s.id::text || ':' || s.name, ',' order by s.id)
      from public.suppliers s where s.organization_id=input_organization_id), '') || ':' ||
    coalesce((select b.name from public.brands b where b.organization_id=input_organization_id and b.id=input_brand_id), ''));
$function$;

create index if not exists idx_catalog_products_export_id
  on public.catalog_products(organization_id,brand_id,id);
create index if not exists idx_catalog_products_export_code_id
  on public.catalog_products(organization_id,brand_id,product_code,id);

create or replace function public.cloud_catalog_export_page_v3(
  input_organization_id uuid, input_brand_id uuid,
  input_market_segment text default '', input_after_id uuid default null,
  input_page_size integer default 1000
) returns table(
  product_id uuid, product_code text, brand text, ean text, description text,
  description_tr text, oem_no text, vehicle text, vehicle_model text, hs_code text,
  origin text, market_segment text, weight_kg numeric, image_url text,
  lifecycle_status text, lifecycle_note text, total_count bigint
) language sql stable security definer set search_path to '' as $function$
  with page as materialized (
    select cp.* from public.catalog_products cp
    where cp.organization_id=input_organization_id and cp.brand_id=input_brand_id
      and (nullif(btrim(input_market_segment),'') is null or cp.market_segment=btrim(input_market_segment))
      and (input_after_id is null or cp.id>input_after_id)
    order by cp.id limit least(greatest(coalesce(input_page_size,1000),1),5000)
  ), total as (
    select count(*)::bigint n from public.catalog_products cp
    where input_after_id is null and cp.organization_id=input_organization_id and cp.brand_id=input_brand_id
      and (nullif(btrim(input_market_segment),'') is null or cp.market_segment=btrim(input_market_segment))
  )
  select cp.id,cp.product_code,b.name,cp.ean,cp.description,cp.description_tr,
    cp.oem_no,cp.vehicle,cp.vehicle_model,cp.hs_code,cp.origin,cp.market_segment,
    cp.weight_kg,cp.image_url,coalesce(cp.lifecycle_status,'active'),cp.lifecycle_note,
    case when input_after_id is null then t.n else null end
  from page cp join public.brands b on b.id=cp.brand_id and b.organization_id=cp.organization_id
  cross join total t order by cp.id;
$function$;

create or replace function public.cloud_catalog_master_export_page_v3(
  input_organization_id uuid, input_brand_id uuid,
  input_scope text default 'priced', input_search text default '',
  input_after_code text default null, input_after_id uuid default null,
  input_page_size integer default 1000, input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
) returns table(
  total_count bigint, product_id uuid, product_code text, brand text,
  description text, oem_no text, hs_code text, origin text, weight_kg numeric,
  cheapest_supplier text, cheapest_price numeric, second_supplier_name text,
  second_price numeric, price_gap numeric, price_gap_percent numeric,
  price_date date, sales_a numeric, sales_b numeric, sales_c numeric,
  supplier_count bigint, catalog_status text, notes text, has_notes boolean,
  cursor_code text, cursor_id uuid
) language sql stable security definer set search_path to '' as $function$
  with params as materialized (
    select input_organization_id org_id,input_brand_id brand_id,
      case when lower(coalesce(input_scope,''))='catalog' then 'catalog' else 'priced' end scope,
      nullif(btrim(input_search),'') search,
      nullif(public.normalize_part_code(input_search),'') search_norm,
      input_after_code after_code,input_after_id after_id,
      least(greatest(coalesce(input_page_size,1000),1),5000) page_size
  ), pointers as materialized (
    select ptr.* from public.supplier_current_price_pointers ptr
    join params p on ptr.organization_id=p.org_id and ptr.brand_id=p.brand_id
  ), releases as materialized (
    select ptr.release_id,ptr.supplier_id from pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
  ), release_candidates as materialized (
    select candidate.normalized_code from releases rel cross join params p
    cross join lateral (
      select distinct r.normalized_code from public.supplier_price_release_rows r
      where p.scope='priced' and r.release_id=rel.release_id
        and r.row_status='accepted' and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
        and r.normalized_code ~ '[A-Z0-9]'
        and (p.after_code is null or r.normalized_code>p.after_code)
        and (p.search is null or r.product_code ilike '%'||p.search||'%'
          or r.description ilike '%'||p.search||'%' or r.oem_no ilike '%'||p.search||'%'
          or (p.search_norm is not null and (r.normalized_code like p.search_norm||'%'
            or public.normalize_part_code(r.oem_no) like p.search_norm||'%')))
      order by r.normalized_code limit p.page_size
    ) candidate
  ), release_codes as materialized (
    select distinct rc.normalized_code from release_candidates rc
    order by rc.normalized_code limit (select page_size from params)
  ), legacy_page as materialized (
    select spr.* from public.supplier_price_rollups spr cross join params p
    where p.scope='priced' and not exists(select 1 from pointers)
      and spr.organization_id=p.org_id and spr.brand_id=p.brand_id and spr.cheapest_price is not null
      and (p.after_code is null or spr.normalized_code>p.after_code)
      and (p.search is null or spr.product_code ilike '%'||p.search||'%'
        or spr.description ilike '%'||p.search||'%' or spr.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (spr.normalized_code like p.search_norm||'%'
          or spr.normalized_oem like p.search_norm||'%')))
    order by spr.normalized_code limit (select page_size from params)
  ), catalog_page as materialized (
    select cp.* from public.catalog_products cp cross join params p
    where p.scope='catalog' and cp.organization_id=p.org_id and cp.brand_id=p.brand_id
      and (p.after_code is null or (cp.product_code,cp.id)>(p.after_code,p.after_id))
      and (p.search is null or cp.product_code ilike '%'||p.search||'%'
        or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
          or cp.normalized_oem like p.search_norm||'%')))
    order by cp.product_code,cp.id limit (select page_size from params)
  ), page_codes as materialized (
    select rc.normalized_code from release_codes rc
    union
    select public.normalize_catalog_product_code(cp.product_code) from catalog_page cp
  ), supplier_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
    order by r.normalized_code,rel.supplier_id,r.buy_price,r.id
  ), ranked as materialized (
    select sb.*,row_number() over(partition by sb.normalized_code order by sb.buy_price,sb.id) rank,
      s.name supplier_name
    from supplier_best sb cross join params p
    left join public.suppliers s on s.id=sb.supplier_id and s.organization_id=p.org_id
  ), published_summary as materialized (
    select r.normalized_code,
      max(r.product_code) filter(where r.rank=1) product_code,
      max(r.description) filter(where r.rank=1) description,
      max(r.oem_no) filter(where r.rank=1) oem_no,
      max(r.supplier_name) filter(where r.rank=1) cheapest_supplier,
      max(r.buy_price) filter(where r.rank=1) cheapest_price,
      max(r.supplier_name) filter(where r.rank=2) second_supplier_name,
      max(r.buy_price) filter(where r.rank=2) second_price,
      max(r.valid_from) filter(where r.rank=1) price_date,
      max(r.notes) filter(where r.rank=1) notes,count(*)::bigint supplier_count
    from ranked r group by r.normalized_code
  ), priced_rows as materialized (
    select ps.normalized_code,cp.id product_id,
      coalesce(nullif(cp.product_code,''),ps.product_code,ps.normalized_code) product_code,
      coalesce(nullif(cp.description,''),ps.description,'') description,
      coalesce(nullif(cp.oem_no,''),ps.oem_no,'') oem_no,
      cp.hs_code,cp.origin,cp.weight_kg,ps.cheapest_supplier,ps.cheapest_price,
      ps.second_supplier_name,ps.second_price,ps.price_date,ps.supplier_count,ps.notes
    from published_summary ps join release_codes rc on rc.normalized_code=ps.normalized_code cross join params p
    left join lateral (
      select c.* from public.catalog_products c where c.organization_id=p.org_id and c.brand_id=p.brand_id
        and public.normalize_catalog_product_code(c.product_code)=ps.normalized_code
      order by c.product_code,c.id limit 1
    ) cp on true
    union all
    select lp.normalized_code,cp.id,coalesce(nullif(lp.product_code,''),cp.product_code,lp.normalized_code),
      coalesce(nullif(cp.description,''),lp.description,''),coalesce(nullif(cp.oem_no,''),lp.oem_no,''),
      cp.hs_code,cp.origin,cp.weight_kg,s.name,lp.cheapest_price,
      coalesce(nullif(lp.second_supplier_name,''),s2.name),lp.second_price,lp.price_date,lp.supplier_count::bigint,lp.notes
    from legacy_page lp cross join params p
    left join lateral (
      select c.* from public.catalog_products c where c.organization_id=p.org_id and c.brand_id=p.brand_id
        and c.normalized_code=lp.normalized_code order by c.product_code,c.id limit 1
    ) cp on true
    left join public.suppliers s on s.id=lp.cheapest_supplier_id and s.organization_id=p.org_id
    left join public.suppliers s2 on s2.id=lp.second_supplier_id and s2.organization_id=p.org_id
  ), catalog_rows as materialized (
    select cp.id product_id,cp.product_code,coalesce(cp.description,'') description,coalesce(cp.oem_no,'') oem_no,
      cp.hs_code,cp.origin,cp.weight_kg,
      case when exists(select 1 from pointers) then ps.cheapest_supplier else s.name end cheapest_supplier,
      case when exists(select 1 from pointers) then ps.cheapest_price else spr.cheapest_price end cheapest_price,
      case when exists(select 1 from pointers) then ps.second_supplier_name else coalesce(nullif(spr.second_supplier_name,''),s2.name) end second_supplier_name,
      case when exists(select 1 from pointers) then ps.second_price else spr.second_price end second_price,
      case when exists(select 1 from pointers) then ps.price_date else spr.price_date end price_date,
      coalesce(case when exists(select 1 from pointers) then ps.supplier_count else spr.supplier_count::bigint end,0) supplier_count,
      case when exists(select 1 from pointers) then ps.notes else spr.notes end notes
    from catalog_page cp cross join params p
    left join published_summary ps on ps.normalized_code=public.normalize_catalog_product_code(cp.product_code)
    left join public.supplier_price_rollups spr on not exists(select 1 from pointers)
      and spr.organization_id=p.org_id and spr.brand_id=p.brand_id and spr.normalized_code=cp.normalized_code
    left join public.suppliers s on s.id=spr.cheapest_supplier_id and s.organization_id=p.org_id
    left join public.suppliers s2 on s2.id=spr.second_supplier_id and s2.organization_id=p.org_id
  ), source_total as (
    select case when p.after_code is not null then null::bigint
      when p.scope='catalog' then (select count(*) from public.catalog_products cp
        where cp.organization_id=p.org_id and cp.brand_id=p.brand_id
          and (p.search is null or cp.product_code ilike '%'||p.search||'%' or cp.description ilike '%'||p.search||'%'
            or cp.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (cp.normalized_code like p.search_norm||'%' or cp.normalized_oem like p.search_norm||'%'))))
      when exists(select 1 from pointers) then (select count(distinct r.normalized_code)
        from releases rel join public.supplier_price_release_rows r on r.release_id=rel.release_id
        where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
          and r.normalized_code ~ '[A-Z0-9]'
          and (p.search is null or r.product_code ilike '%'||p.search||'%' or r.description ilike '%'||p.search||'%'
            or r.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (r.normalized_code like p.search_norm||'%' or public.normalize_part_code(r.oem_no) like p.search_norm||'%'))))
      else (select count(*) from public.supplier_price_rollups spr
        where spr.organization_id=p.org_id and spr.brand_id=p.brand_id and spr.cheapest_price is not null
          and (p.search is null or spr.product_code ilike '%'||p.search||'%' or spr.description ilike '%'||p.search||'%'
            or spr.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (spr.normalized_code like p.search_norm||'%' or spr.normalized_oem like p.search_norm||'%'))))
      end n from params p
  ), result as (
    select pr.product_id,pr.product_code,pr.description,pr.oem_no,pr.hs_code,pr.origin,pr.weight_kg,
      pr.cheapest_supplier,pr.cheapest_price,pr.second_supplier_name,pr.second_price,pr.price_date,pr.supplier_count,pr.notes,
      case when pr.product_id is null then 'Supplier Only' else 'In Catalog' end catalog_status,
      pr.normalized_code cursor_code,null::uuid cursor_id from priced_rows pr
    union all
    select cr.product_id,cr.product_code,cr.description,cr.oem_no,cr.hs_code,cr.origin,cr.weight_kg,
      cr.cheapest_supplier,cr.cheapest_price,cr.second_supplier_name,cr.second_price,cr.price_date,cr.supplier_count,cr.notes,
      'In Catalog',cr.product_code,cr.product_id from catalog_rows cr
  )
  select st.n,r.product_id,r.product_code,b.name,r.description,r.oem_no,r.hs_code,r.origin,r.weight_kg,
    coalesce(r.cheapest_supplier,''),r.cheapest_price,coalesce(r.second_supplier_name,''),r.second_price,
    r.second_price-r.cheapest_price,
    case when r.cheapest_price>0 then round((r.second_price-r.cheapest_price)*100/r.cheapest_price,2) else null end,
    r.price_date,round(r.cheapest_price*(1+coalesce(input_margin_a,0)),2),
    round(r.cheapest_price*(1+coalesce(input_margin_b,0)),2),null::numeric,
    r.supplier_count,r.catalog_status,r.notes,nullif(btrim(r.notes),'') is not null,r.cursor_code,r.cursor_id
  from result r cross join params p cross join source_total st
  join public.brands b on b.organization_id=p.org_id and b.id=p.brand_id
  order by r.cursor_code,r.cursor_id;
$function$;
CREATE OR REPLACE FUNCTION public.cloud_catalog_master_export_page_fast(input_organization_id uuid, input_brand_id uuid, input_scope text DEFAULT 'priced'::text, input_search text DEFAULT ''::text, input_page integer DEFAULT 1, input_page_size integer DEFAULT 1000, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(total_count bigint, product_id uuid, product_code text, brand text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, cheapest_supplier text, cheapest_price numeric, second_supplier_name text, second_price numeric, price_gap numeric, price_gap_percent numeric, price_date date, sales_a numeric, sales_b numeric, sales_c numeric, supplier_count bigint, catalog_status text, notes text, has_notes boolean)

 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_after_code text := null;
  v_after_id uuid := null;
  v_page integer;
  v_total bigint;
  v_seen integer;
  r record;
begin
  for v_page in 1..greatest(coalesce(input_page,1),1) loop
    v_seen := 0;
    for r in select * from public.cloud_catalog_master_export_page_v3(
      input_organization_id,input_brand_id,input_scope,input_search,v_after_code,v_after_id,
      input_page_size,input_margin_a,input_margin_b)
    loop
      v_seen := v_seen+1;
      v_after_code := r.cursor_code;
      v_after_id := r.cursor_id;
      v_total := coalesce(r.total_count,v_total);
      if v_page=greatest(coalesce(input_page,1),1) then
        total_count := v_total;
        product_id := r.product_id;
        product_code := r.product_code;
        brand := r.brand;
        description := r.description;
        oem_no := r.oem_no;
        hs_code := r.hs_code;
        origin := r.origin;
        weight_kg := r.weight_kg;
        cheapest_supplier := r.cheapest_supplier;
        cheapest_price := r.cheapest_price;
        second_supplier_name := r.second_supplier_name;
        second_price := r.second_price;
        price_gap := r.price_gap;
        price_gap_percent := r.price_gap_percent;
        price_date := r.price_date;
        sales_a := r.sales_a;
        sales_b := r.sales_b;
        sales_c := r.sales_c;
        supplier_count := r.supplier_count;
        catalog_status := r.catalog_status;
        notes := r.notes;
        has_notes := r.has_notes;
        return next;
      end if;
    end loop;
    if v_seen=0 then exit; end if;
  end loop;
end;
$function$;

revoke all on function public.cloud_catalog_export_fast(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_export_fast(uuid,uuid,text) to service_role;
revoke all on function public.cloud_catalog_master_export_page_fast(uuid,uuid,text,text,integer,integer,numeric,numeric) from public,anon,authenticated;
grant execute on function public.cloud_catalog_master_export_page_fast(uuid,uuid,text,text,integer,integer,numeric,numeric) to service_role;
revoke all on function public.get_catalog_export_version(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_export_version(uuid,uuid,text) to service_role;
revoke all on function public.get_catalog_master_export_version(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_master_export_version(uuid,uuid,text) to service_role;
revoke all on function public.cloud_catalog_export_page_v3(uuid,uuid,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.cloud_catalog_export_page_v3(uuid,uuid,text,uuid,integer) to service_role;
revoke all on function public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) from public,anon,authenticated;
grant execute on function public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) to service_role;
