-- Export cursors use UTF-8 byte ordering, matching worker cursor checks.
-- The exact catalog identity lookup must be indexed before paging 1M prices:
-- otherwise each page performs a catalog scan for every selected SKU.
create index if not exists idx_catalog_products_export_exact_identity
  on public.catalog_products(organization_id,brand_id,public.normalize_catalog_product_code(product_code),product_code,id);
create index if not exists idx_catalog_products_export_code_c_id
  on public.catalog_products(organization_id,brand_id,product_code collate "C",id);
create index if not exists idx_supplier_price_rollups_export_code_c
  on public.supplier_price_rollups(organization_id,brand_id,normalized_code collate "C") where cheapest_price is not null;
create index if not exists idx_release_rows_supplier_export_code_c
  on public.supplier_price_release_rows(release_id,product_code collate "C",(md5(id::text)::uuid))
  where row_status='accepted' and buy_price>0 and currency='EUR';
create index if not exists idx_release_rows_master_export_code_c
  on public.supplier_price_release_rows(release_id,normalized_code collate "C",id)
  where row_status='accepted' and buy_price>0 and currency='EUR';
create index if not exists idx_supplier_prices_export_code_c
  on public.supplier_prices(organization_id,supplier_id,brand_id,(coalesce(product_code,'') collate "C"),id) where is_active;

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
      select distinct r.normalized_code collate "C" as normalized_code from public.supplier_price_release_rows r
      where p.scope='priced' and r.release_id=rel.release_id
        and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
        and r.normalized_code ~ '[A-Z0-9]'
        and (p.after_code is null or r.normalized_code collate "C">p.after_code collate "C")
        and (p.search is null or r.product_code ilike '%'||p.search||'%'
          or r.description ilike '%'||p.search||'%' or r.oem_no ilike '%'||p.search||'%'
          or (p.search_norm is not null and (r.normalized_code like p.search_norm||'%'
            or public.normalize_part_code(r.oem_no) like p.search_norm||'%')))
      order by r.normalized_code collate "C" limit p.page_size
    ) candidate
  ), release_codes as materialized (
    select distinct rc.normalized_code collate "C" as normalized_code from release_candidates rc
    order by normalized_code limit (select page_size from params)
  ), legacy_page as materialized (
    select spr.* from public.supplier_price_rollups spr cross join params p
    where p.scope='priced' and not exists(select 1 from pointers)
      and spr.organization_id=p.org_id and spr.brand_id=p.brand_id and spr.cheapest_price is not null
      and (p.after_code is null or spr.normalized_code collate "C">p.after_code collate "C")
      and (p.search is null or spr.product_code ilike '%'||p.search||'%'
        or spr.description ilike '%'||p.search||'%' or spr.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (spr.normalized_code like p.search_norm||'%'
          or spr.normalized_oem like p.search_norm||'%')))
    order by spr.normalized_code collate "C" limit (select page_size from params)
  ), catalog_page as materialized (
    select cp.* from public.catalog_products cp cross join params p
    where p.scope='catalog' and cp.organization_id=p.org_id and cp.brand_id=p.brand_id
      and (p.after_code is null or (cp.product_code collate "C",cp.id)>(p.after_code collate "C",p.after_id))
      and (p.search is null or cp.product_code ilike '%'||p.search||'%'
        or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
          or cp.normalized_oem like p.search_norm||'%')))
    order by cp.product_code collate "C",cp.id limit (select page_size from params)
  ), page_codes as materialized (
    select rc.normalized_code from release_codes rc
    union
    select public.normalize_catalog_product_code(cp.product_code) from catalog_page cp
  ), supplier_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
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
        where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
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
  order by r.cursor_code collate "C",r.cursor_id;
$function$;

create or replace function public.cloud_supplier_price_export_page(
  input_organization_id uuid,
  input_supplier_id uuid,
  input_brand_id uuid,
  input_search text default '',
  input_freshness text default 'all',
  input_after_product_code text default null,
  input_after_id uuid default null,
  input_page_size integer default 1000
)
returns table (
  total_count bigint,
  price_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  buy_price numeric,
  currency text,
  price_date date,
  moq integer,
  order_multiple integer,
  lead_time_days integer,
  notes text,
  freshness text
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_page_size integer;
  v_search text;
  v_search_norm text;
  v_original_norm text;
  v_freshness text;
  v_has_pointer boolean;
  v_release_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SUPPLIER_PRICE_EXPORT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_organization_id is null or input_supplier_id is null or input_brand_id is null then
    raise exception 'SUPPLIER_PRICE_EXPORT_SCOPE_REQUIRED';
  end if;

  v_page_size := least(greatest(coalesce(input_page_size, 1000), 1), 5000);
  v_search := nullif(pg_catalog.btrim(coalesce(input_search, '')), '');
  v_search_norm := public.normalize_part_code(coalesce(v_search, ''));
  v_original_norm := pg_catalog.regexp_replace(v_search_norm, '^([A-Z]{1,3})([0-9]{6,})$', '\2');
  v_freshness := lower(coalesce(nullif(pg_catalog.btrim(input_freshness), ''), 'all'));
  if v_freshness not in ('all', 'fresh', 'aging', 'stale', 'unknown') then
    raise exception 'SUPPLIER_PRICE_EXPORT_FRESHNESS_INVALID';
  end if;

  select exists(select 1 from public.supplier_current_price_pointers ptr
    where ptr.organization_id=input_organization_id and ptr.supplier_id=input_supplier_id and ptr.brand_id=input_brand_id)
    into v_has_pointer;
  if v_has_pointer then
    select ptr.release_id into v_release_id from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
    where ptr.organization_id=input_organization_id and ptr.supplier_id=input_supplier_id and ptr.brand_id=input_brand_id;
    -- An invalid pointer intentionally yields no rows; stale legacy prices are not substituted.
    return query with page as materialized (
      select r.* from public.supplier_price_release_rows r
      where r.release_id=v_release_id and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
          and r.normalized_code ~ '[A-Z0-9]'
          and (v_search is null or r.product_code ilike '%'||v_search||'%' or r.description ilike '%'||v_search||'%'
            or r.oem_no ilike '%'||v_search||'%' or (v_search_norm<>'' and
              (r.normalized_code like v_search_norm||'%' or public.normalize_part_code(r.oem_no) like v_search_norm||'%')))
          and (v_freshness='all'
            or (v_freshness='fresh' and r.valid_from>=current_date-90)
            or (v_freshness='aging' and r.valid_from>=current_date-180 and r.valid_from<current_date-90)
            or (v_freshness='stale' and r.valid_from<current_date-180)
            or (v_freshness='unknown' and r.valid_from is null))
        and (input_after_product_code is null or
          (r.product_code collate "C",md5(r.id::text)::uuid)>(input_after_product_code collate "C",input_after_id))
      order by r.product_code collate "C",md5(r.id::text)::uuid limit v_page_size
    ), total as (
      select count(*)::bigint n from public.supplier_price_release_rows r
      where input_after_product_code is null and r.release_id=v_release_id and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
          and r.normalized_code ~ '[A-Z0-9]'
          and (v_search is null or r.product_code ilike '%'||v_search||'%' or r.description ilike '%'||v_search||'%'
            or r.oem_no ilike '%'||v_search||'%' or (v_search_norm<>'' and
              (r.normalized_code like v_search_norm||'%' or public.normalize_part_code(r.oem_no) like v_search_norm||'%')))
          and (v_freshness='all'
            or (v_freshness='fresh' and r.valid_from>=current_date-90)
            or (v_freshness='aging' and r.valid_from>=current_date-180 and r.valid_from<current_date-90)
            or (v_freshness='stale' and r.valid_from<current_date-180)
            or (v_freshness='unknown' and r.valid_from is null))
    )
    select case when input_after_product_code is null then t.n else null end,
      md5(p.id::text)::uuid,p.product_code,b.name,p.description,p.oem_no,p.buy_price,p.currency,
      p.valid_from,p.moq,null::integer,p.lead_time_days,p.notes,
      case when p.valid_from is null then 'unknown' when p.valid_from<current_date-180 then 'stale'
        when p.valid_from<current_date-90 then 'aging' else 'fresh' end
    from page p cross join total t
    join public.brands b on b.id=input_brand_id and b.organization_id=input_organization_id
    order by p.product_code collate "C",md5(p.id::text)::uuid;
    return;
  end if;

  return query
  with scoped as not materialized (
    select
      sp.id,
      sp.product_code,
      b.name as brand,
      sp.description,
      sp.oem_no,
      sp.buy_price,
      sp.currency,
      sp.valid_from,
      sp.moq,
      sp.order_multiple,
      sp.lead_time_days,
      sp.notes,
      case
        when sp.valid_from is null then 'unknown'
        when sp.valid_from < current_date - interval '180 days' then 'stale'
        when sp.valid_from < current_date - interval '90 days' then 'aging'
        else 'fresh'
      end as freshness
    from public.supplier_prices sp
    join public.brands b
      on b.id = sp.brand_id
     and b.organization_id = input_organization_id
    where sp.organization_id = input_organization_id
      and sp.supplier_id = input_supplier_id
      and sp.brand_id = input_brand_id
      and sp.is_active
      and (
        v_search is null
        or sp.product_code ilike '%' || v_search || '%'
        or coalesce(sp.description, '') ilike '%' || v_search || '%'
        or coalesce(sp.oem_no, '') ilike '%' || v_search || '%'
        or (v_search_norm <> '' and (
          sp.normalized_code = v_search_norm
          or sp.normalized_oem = v_search_norm
          or sp.normalized_code like v_search_norm || '%'
          or sp.normalized_oem like v_search_norm || '%'
          or (pg_catalog.length(v_original_norm) >= 6 and sp.normalized_oem like '%' || v_original_norm || '%')
        ))
      )
      and (
        v_freshness = 'all'
        or (v_freshness = 'fresh' and sp.valid_from >= current_date - interval '90 days')
        or (v_freshness = 'aging' and sp.valid_from >= current_date - interval '180 days' and sp.valid_from < current_date - interval '90 days')
        or (v_freshness = 'stale' and sp.valid_from < current_date - interval '180 days')
        or (v_freshness = 'unknown' and sp.valid_from is null)
      )
      and (
        input_after_product_code is null
        or coalesce(sp.product_code, '') collate "C" > coalesce(input_after_product_code, '') collate "C"
        or (coalesce(sp.product_code, '') = coalesce(input_after_product_code, '') and input_after_id is not null and sp.id > input_after_id)
      )
  ),
  page as (
    select s.*
    from scoped s
    order by coalesce(s.product_code, '') collate "C" asc, s.id asc
    limit v_page_size
  ),
  first_page_count as (
    select count(*)::bigint as total_count
    from (
      -- Count is deliberately emitted only for the first page. Subsequent
      -- keyset requests never repeat an all-row COUNT/window operation.
      select 1 from public.supplier_prices sp
      join public.brands b on b.id = sp.brand_id and b.organization_id = input_organization_id
      where input_after_product_code is null
        and sp.organization_id = input_organization_id
        and sp.supplier_id = input_supplier_id
        and sp.brand_id = input_brand_id
        and sp.is_active
        and (
          v_search is null
          or sp.product_code ilike '%' || v_search || '%'
          or coalesce(sp.description, '') ilike '%' || v_search || '%'
          or coalesce(sp.oem_no, '') ilike '%' || v_search || '%'
          or (v_search_norm <> '' and (
            sp.normalized_code = v_search_norm
            or sp.normalized_oem = v_search_norm
            or sp.normalized_code like v_search_norm || '%'
            or sp.normalized_oem like v_search_norm || '%'
            or (pg_catalog.length(v_original_norm) >= 6 and sp.normalized_oem like '%' || v_original_norm || '%')
          ))
        )
        and (
          v_freshness = 'all'
          or (v_freshness = 'fresh' and sp.valid_from >= current_date - interval '90 days')
          or (v_freshness = 'aging' and sp.valid_from >= current_date - interval '180 days' and sp.valid_from < current_date - interval '90 days')
          or (v_freshness = 'stale' and sp.valid_from < current_date - interval '180 days')
          or (v_freshness = 'unknown' and sp.valid_from is null)
        )
    ) counted
  )
  select
    case when input_after_product_code is null then fc.total_count else null end,
    p.id,
    p.product_code,
    p.brand,
    p.description,
    p.oem_no,
    p.buy_price,
    p.currency,
    p.valid_from,
    p.moq,
    p.order_multiple,
    p.lead_time_days,
    p.notes,
    p.freshness
  from page p
  cross join first_page_count fc
  order by coalesce(p.product_code, '') collate "C" asc, p.id asc;
end;
$function$;

revoke all on function public.cloud_supplier_price_export_page(uuid, uuid, uuid, text, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.cloud_supplier_price_export_page(uuid, uuid, uuid, text, text, text, uuid, integer)
  to service_role;

revoke all on function public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) from public,anon,authenticated;
grant execute on function public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) to service_role;
