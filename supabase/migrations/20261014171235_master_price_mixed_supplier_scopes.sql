-- A publication replaces one supplier/brand scope, not the whole brand.
-- Merge eligible unowned legacy suppliers into Master/Comparison pages and
-- exports. Never read stale rollups after a partial publication. No rows,
-- pointers, publications or commercial prices are changed by this migration.

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
  ), legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp cross join params p
    where sp.organization_id=p.org_id and sp.brand_id=p.brand_id and sp.is_active
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  ), release_candidates as materialized (
    select candidate.normalized_code from releases rel cross join params p
    cross join lateral (
      select distinct r.normalized_code collate "C" as normalized_code from public.supplier_price_release_rows r
      where p.scope='priced' and r.release_id=rel.release_id
        and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code collate "C">coalesce(p.after_code,'') collate "C"
        and (p.search is null or r.product_code ilike '%'||p.search||'%'
          or r.description ilike '%'||p.search||'%' or r.oem_no ilike '%'||p.search||'%'
          or (p.search_norm is not null and (r.normalized_code like p.search_norm||'%'
            or public.normalize_part_code(r.oem_no) like p.search_norm||'%')))
      order by r.normalized_code collate "C" limit p.page_size
    ) candidate
  ), legacy_codes as materialized (
    select distinct l.exact_code normalized_code from legacy l cross join params p
    where p.scope='priced' and l.exact_code>coalesce(p.after_code,'') collate "C"
      and (p.search is null or l.product_code ilike '%'||p.search||'%'
        or l.description ilike '%'||p.search||'%' or l.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (l.exact_code like p.search_norm||'%'
          or public.normalize_part_code(l.oem_no) like p.search_norm||'%')))
    order by normalized_code limit (select page_size from params)
  ), price_codes as materialized (
    select code.normalized_code from (
      select rc.normalized_code from release_candidates rc
      union select lc.normalized_code from legacy_codes lc
    ) code order by code.normalized_code collate "C" limit (select page_size from params)
  ), catalog_page as materialized (
    -- Separate guarded branches retain a tuple index seek in generic plans.
    -- An OR around the cursor otherwise scans the preceding catalog pages.
    select candidate.* from params p cross join lateral (
      (select cp.* from public.catalog_products cp
       where p.scope='catalog' and p.after_code is null
         and cp.organization_id=p.org_id and cp.brand_id=p.brand_id
      and (p.search is null or cp.product_code ilike '%'||p.search||'%'
        or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
          or cp.normalized_oem like p.search_norm||'%')))
       order by cp.product_code collate "C",cp.id limit p.page_size)
      union all
      (select cp.* from public.catalog_products cp
       where p.scope='catalog' and p.after_code is not null
         and cp.organization_id=p.org_id and cp.brand_id=p.brand_id
         and (cp.product_code collate "C",cp.id)>(p.after_code collate "C",p.after_id)
      and (p.search is null or cp.product_code ilike '%'||p.search||'%'
        or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
          or cp.normalized_oem like p.search_norm||'%')))
       order by cp.product_code collate "C",cp.id limit p.page_size)
    ) candidate
  ), page_codes as materialized (
    select rc.normalized_code from price_codes rc
    union
    select public.normalize_catalog_product_code(cp.product_code) from catalog_page cp
  ), published_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
    order by r.normalized_code,rel.supplier_id,r.buy_price,r.id
  ), legacy_best as materialized (
    select distinct on (l.exact_code,l.supplier_id)
      l.exact_code normalized_code,l.supplier_id,l.product_code,l.description,l.oem_no,
      l.buy_price,l.valid_from,l.notes,l.id
    from page_codes pc join legacy l on l.exact_code=pc.normalized_code
    order by l.exact_code,l.supplier_id,l.valid_from desc,l.id::text desc
  ), supplier_best as materialized (
    select pb.normalized_code,pb.supplier_id,pb.product_code,pb.description,pb.oem_no,
      pb.buy_price,pb.valid_from,pb.notes,pb.id published_order_id from published_best pb
    union all
    select lb.normalized_code,lb.supplier_id,lb.product_code,lb.description,lb.oem_no,
      lb.buy_price,lb.valid_from,lb.notes,null from legacy_best lb
  ), ranked as materialized (
    select sb.*,row_number() over(partition by sb.normalized_code order by sb.buy_price,sb.published_order_id asc nulls last,sb.valid_from desc,sb.supplier_id) rank,
      s.name supplier_name
    from supplier_best sb cross join params p
    left join public.suppliers s on s.id=sb.supplier_id and s.organization_id=p.org_id
  ), price_summary as materialized (
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
    from price_summary ps join params p on p.scope='priced'
    left join lateral (
      select c.* from public.catalog_products c where c.organization_id=p.org_id and c.brand_id=p.brand_id
        -- The catalog expression index uses the database default collation.
        -- Keep byte-ordered export cursors separate from this equality lookup.
        and public.normalize_catalog_product_code(c.product_code)=ps.normalized_code collate "default"
      order by c.product_code,c.id limit 1
    ) cp on true
  ), catalog_rows as materialized (
    select cp.id product_id,cp.product_code,coalesce(cp.description,'') description,coalesce(cp.oem_no,'') oem_no,
      cp.hs_code,cp.origin,cp.weight_kg,
      ps.cheapest_supplier,ps.cheapest_price,ps.second_supplier_name,ps.second_price,
      ps.price_date,coalesce(ps.supplier_count,0) supplier_count,ps.notes
    from catalog_page cp
    left join price_summary ps on ps.normalized_code=public.normalize_catalog_product_code(cp.product_code)
  ), source_total as materialized (
    select case when p.after_code is not null then null::bigint
      when p.scope='catalog' then (select count(*) from public.catalog_products cp
        where cp.organization_id=p.org_id and cp.brand_id=p.brand_id
          and (p.search is null or cp.product_code ilike '%'||p.search||'%' or cp.description ilike '%'||p.search||'%'
            or cp.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (cp.normalized_code like p.search_norm||'%' or cp.normalized_oem like p.search_norm||'%'))))
      else (select count(distinct all_codes.normalized_code) from (
        select r.normalized_code collate "C" normalized_code
        from releases rel join public.supplier_price_release_rows r on r.release_id=rel.release_id
        where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
          and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
          and r.normalized_code ~ '[A-Z0-9]'
          and (p.search is null or r.product_code ilike '%'||p.search||'%' or r.description ilike '%'||p.search||'%'
            or r.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (r.normalized_code like p.search_norm||'%' or public.normalize_part_code(r.oem_no) like p.search_norm||'%')))
        union all
        select l.exact_code from legacy l
        where p.search is null or l.product_code ilike '%'||p.search||'%' or l.description ilike '%'||p.search||'%'
          or l.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
            (l.exact_code like p.search_norm||'%' or public.normalize_part_code(l.oem_no) like p.search_norm||'%'))
      ) all_codes)
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


revoke all on function public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) from public,anon,authenticated;
grant execute on function public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) to service_role;

create or replace function public.cloud_master_published_price_page_v3(
  input_search text default '',
  input_brand_id uuid default null,
  input_page integer default 1,
  input_page_size integer default 50,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_organization_id uuid;
  v_brand_name text;
  v_page integer;
  v_page_size integer;
  v_scan_limit integer;
  v_exact_code text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'MASTER_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'MASTER_ACCESS_DENIED';
  end if;
  if input_brand_id is null or input_page is null or input_page not between 1 and 100
     or input_page_size is null or input_page_size not between 1 and 100
     or pg_catalog.length(coalesce(input_search, '')) > 100
     or input_margin_a is null or input_margin_a not between -1 and 10
     or input_margin_b is null or input_margin_b not between -1 and 10 then
    raise exception 'MASTER_PAGE_INPUT_INVALID';
  end if;
  select b.name into v_brand_name
  from public.brands b
  where b.id = input_brand_id and b.organization_id = v_organization_id;
  if v_brand_name is null then
    raise exception 'MASTER_BRAND_SCOPE_INVALID';
  end if;

  v_page := input_page;
  v_page_size := input_page_size;
  v_scan_limit := v_page * v_page_size;
  v_exact_code := nullif(
    pg_catalog.upper(pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(input_search, '')), '[[:space:]]+', '', 'g')),
    '');
  -- Search is exact SKU identity. A punctuation-preserving code such as 61/1
  -- must never be merged with 611 by the legacy alphanumeric normalizer.

  with pointer_scope as materialized (
    select ptr.*
    from public.supplier_current_price_pointers ptr
    where ptr.organization_id = v_organization_id
      and ptr.brand_id = input_brand_id
  ),
  legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp
    where sp.organization_id=v_organization_id and sp.brand_id=input_brand_id and sp.is_active
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and exists(select 1 from pointer_scope)
      and not exists(select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
  ),
  current_releases as materialized (
    select ptr.release_id, ptr.supplier_id, s.name as supplier_name,
      rel.accepted_rows
    from pointer_scope ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id and pub.release_id = ptr.release_id
     and pub.organization_id = ptr.organization_id
     and pub.supplier_id = ptr.supplier_id and pub.brand_id = ptr.brand_id
     and pub.status = 'published'
    left join public.suppliers s
      on s.id = ptr.supplier_id and s.organization_id = ptr.organization_id
    left join public.supplier_price_releases rel
      on rel.id = ptr.release_id and rel.organization_id = ptr.organization_id
     and rel.supplier_id = ptr.supplier_id and rel.brand_id = ptr.brand_id
  ),
  release_codes as materialized (
    select candidate.normalized_code
    from current_releases cr
    cross join lateral (
      select distinct r.normalized_code
      from public.supplier_price_release_rows r
      where r.release_id = cr.release_id
        and (v_exact_code is null or r.normalized_code = v_exact_code)
        and r.row_status = 'accepted' and r.buy_price > 0
        and r.currency = 'EUR' and r.valid_from <= current_date
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code = pg_catalog.upper(
          pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
      order by r.normalized_code
      limit v_scan_limit
    ) candidate
  ),
  legacy_codes as materialized (
    select distinct l.exact_code normalized_code from legacy l
    where v_exact_code is null or l.exact_code=v_exact_code
    order by l.exact_code limit v_scan_limit
  ),
  candidate_codes as materialized (
    select rc.normalized_code collate "C" normalized_code from release_codes rc
    union select lc.normalized_code from legacy_codes lc
  ),
  page_codes as materialized (
    select normalized_code
    from candidate_codes
    order by normalized_code collate "C"
    limit v_page_size offset ((v_page - 1) * v_page_size)
  ),
  published_rows as materialized (
    select r.normalized_code, r.product_code, r.description, r.buy_price,
      r.valid_from, r.notes, cr.supplier_id, cr.supplier_name,
      row_number() over (
        partition by r.normalized_code, cr.supplier_id
        order by r.valid_from desc, r.id desc
      ) as supplier_rank
    from page_codes pc
    join current_releases cr on true
    join public.supplier_price_release_rows r
      on r.release_id = cr.release_id and r.normalized_code = pc.normalized_code
    where r.row_status = 'accepted' and r.buy_price > 0
      and r.currency = 'EUR' and r.valid_from <= current_date
      and r.normalized_code = pg_catalog.upper(
        pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
  ),
  legacy_rows as materialized (
    select l.exact_code normalized_code,l.product_code,l.description,l.buy_price,l.valid_from,l.notes,
      l.supplier_id,s.name supplier_name,
      row_number() over(partition by l.exact_code,l.supplier_id order by l.valid_from desc,l.id::text desc) supplier_rank
    from page_codes pc join legacy l on l.exact_code=pc.normalized_code
    left join public.suppliers s on s.id=l.supplier_id and s.organization_id=v_organization_id
  ),
  supplier_rows as materialized (
    select * from published_rows union all select * from legacy_rows
  ),
  ranked as materialized (
    select sr.*,
      row_number() over (
        partition by sr.normalized_code
        order by sr.buy_price, sr.valid_from desc, sr.supplier_id
      ) as price_rank
    from supplier_rows sr
    where sr.supplier_rank = 1
  ),
  summary as materialized (
    select normalized_code,
      max(product_code) filter (where price_rank = 1) as product_code,
      max(description) filter (where price_rank = 1) as description,
      max(supplier_name) filter (where price_rank = 1) as cheapest_supplier,
      max(buy_price) filter (where price_rank = 1) as cheapest_price,
      max(supplier_name) filter (where price_rank = 2) as second_supplier_name,
      max(buy_price) filter (where price_rank = 2) as second_price,
      max(valid_from) filter (where price_rank = 1) as price_date,
      max(notes) filter (where price_rank = 1) as notes,
      count(*)::bigint as supplier_count
    from ranked
    group by normalized_code
  ),
  scope_totals as (
    -- Accepted-row metadata avoids a full 1M-row COUNT(DISTINCT) on every
    -- page. It is an upper-bound estimate when suppliers share SKUs or a
    -- historical release contains filtered rows.
    select exists(select 1 from pointer_scope) as has_published_scope,
      (coalesce(sum(accepted_rows), 0)+(select count(*) from legacy))::bigint as estimated_count
    from current_releases
  )
  select pg_catalog.jsonb_build_object(
    'has_published_scope', st.has_published_scope,
    'rows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'total_count', case when v_exact_code is null then st.estimated_count
          else 1 end,
        'product_id', null,
        'product_code', sm.product_code,
        'brand', v_brand_name,
        'description', sm.description,
        'oem_no', null, 'hs_code', null, 'origin', null, 'weight_kg', null,
        'cheapest_supplier', sm.cheapest_supplier,
        'cheapest_price', sm.cheapest_price,
        'second_supplier_name', sm.second_supplier_name,
        'second_price', sm.second_price,
        'price_gap', case when sm.second_price is null then null
          else sm.second_price - sm.cheapest_price end,
        'price_gap_percent', case when sm.second_price is null then null
          else pg_catalog.round((sm.second_price - sm.cheapest_price)
            * 100 / sm.cheapest_price, 2) end,
        'price_date', sm.price_date,
        'sales_a', pg_catalog.round(sm.cheapest_price * (1 + input_margin_a), 2),
        'sales_b', pg_catalog.round(sm.cheapest_price * (1 + input_margin_b), 2),
        'supplier_count', sm.supplier_count,
        'catalog_status', 'Supplier Price Only',
        'notes', sm.notes,
        'has_notes', nullif(pg_catalog.btrim(coalesce(sm.notes, '')), '') is not null
      ) order by sm.normalized_code)
      from summary sm
    ), '[]'::jsonb)
  ) into v_result
  from scope_totals st;

  return v_result;
end;
$function$;

revoke all on function public.cloud_master_published_price_page_v3(text,uuid,integer,integer,numeric,numeric)
  from public, anon;
grant execute on function public.cloud_master_published_price_page_v3(text,uuid,integer,integer,numeric,numeric)
  to authenticated;

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
  select md5('price-source-legacy-compatible-v2:'||coalesce(input_organization_id::text,'')||':'||coalesce(input_brand_id::text,'')||':'||
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


create or replace function public.get_catalog_master_export_version(
  input_organization_id uuid,input_brand_id uuid,input_scope text default 'priced'
) returns text language sql stable security definer set search_path to '' as $function$
  select md5('mixed-supplier-master-v1:'||coalesce(input_scope,'priced')||':'||
    public.get_admin_price_list_export_version(input_organization_id,input_brand_id)||':'||
    coalesce((select string_agg(jsonb_build_array(s.id,s.name)::text,',' order by s.id)
      from public.suppliers s where s.organization_id=input_organization_id),'')||':'||
    coalesce((select string_agg(md5(jsonb_build_array(sp.id,sp.oem_no,sp.notes)::text),',' order by sp.id)
      from public.supplier_prices sp where sp.organization_id=input_organization_id and sp.brand_id=input_brand_id
        and sp.is_active and not exists(select 1 from public.supplier_current_price_pointers ptr
          where ptr.organization_id=sp.organization_id and ptr.brand_id=sp.brand_id and ptr.supplier_id=sp.supplier_id)),''));
$function$;
revoke all on function public.get_catalog_master_export_version(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_master_export_version(uuid,uuid,text) to service_role;

-- Catalog preview keeps its NULL total and bounded display page.
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
language plpgsql stable security definer set search_path to '' as $function$
declare
  v_org uuid;
  v_size integer:=least(greatest(coalesce(input_page_size,50),1),250);
  v_offset bigint:=(greatest(coalesce(input_page,1),1)::bigint-1)*least(greatest(coalesce(input_page_size,50),1),250);
begin
  if auth.uid() is null then raise exception 'MASTER_AUTH_REQUIRED'; end if;
  v_org:=public.current_profile_org_id();
  if v_org is null then raise exception 'MASTER_ACCESS_DENIED'; end if;
  if not exists(select 1 from public.brands b where b.id=input_brand_id and b.organization_id=v_org) then
    raise exception 'MASTER_BRAND_SCOPE_INVALID';
  end if;
  return query
  with params as materialized (
    select v_org org_id,input_brand_id brand_id,nullif(btrim(input_search),'') search,
      nullif(public.normalize_part_code(input_search),'') search_norm
  ), catalog_page as materialized (
    -- Keep ordering and pagination inside the tenant-scoped catalog lookup.
    -- A generic plan must not sort the whole catalog before the 50-row page.
    select candidate.* from params p cross join lateral (
      select cp.* from public.catalog_products cp
      where cp.organization_id=p.org_id and cp.brand_id=p.brand_id
        and (p.search is null or cp.product_code ilike '%'||p.search||'%'
          or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
          or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
            or cp.normalized_oem like p.search_norm||'%')))
      order by cp.product_code collate "C",cp.id limit v_size offset v_offset
    ) candidate
  ), pointers as materialized (
    select ptr.* from public.supplier_current_price_pointers ptr
    join params p on ptr.organization_id=p.org_id and ptr.brand_id=p.brand_id
  ), releases as materialized (
    select ptr.release_id,ptr.supplier_id from pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
  ), legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp cross join params p
    where sp.organization_id=p.org_id and sp.brand_id=p.brand_id and sp.is_active
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  ), page_codes as materialized (
    select distinct public.normalize_catalog_product_code(cp.product_code) normalized_code from catalog_page cp
  ), published_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
    order by r.normalized_code,rel.supplier_id,r.buy_price,r.id
  ), legacy_best as materialized (
    select distinct on (l.exact_code,l.supplier_id)
      l.exact_code normalized_code,l.supplier_id,l.product_code,l.description,l.oem_no,
      l.buy_price,l.valid_from,l.notes,l.id
    from page_codes pc join legacy l on l.exact_code=pc.normalized_code
    order by l.exact_code,l.supplier_id,l.valid_from desc,l.id::text desc
  ), supplier_best as materialized (
    select pb.normalized_code,pb.supplier_id,pb.product_code,pb.description,pb.oem_no,
      pb.buy_price,pb.valid_from,pb.notes,pb.id published_order_id from published_best pb
    union all
    select lb.normalized_code,lb.supplier_id,lb.product_code,lb.description,lb.oem_no,
      lb.buy_price,lb.valid_from,lb.notes,null from legacy_best lb
  ), ranked as materialized (
    select sb.*,row_number() over(partition by sb.normalized_code order by sb.buy_price,sb.published_order_id asc nulls last,sb.valid_from desc,sb.supplier_id) rank,
      s.name supplier_name
    from supplier_best sb cross join params p
    left join public.suppliers s on s.id=sb.supplier_id and s.organization_id=p.org_id
  ), price_summary as materialized (
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
  )
  select null::bigint,cp.id,cp.product_code,b.name,coalesce(cp.description,''),coalesce(cp.oem_no,''),
    cp.hs_code,cp.origin,cp.weight_kg,coalesce(ps.cheapest_supplier,''),ps.cheapest_price,
    coalesce(ps.second_supplier_name,''),ps.second_price,ps.second_price-ps.cheapest_price,
    case when ps.cheapest_price>0 then round((ps.second_price-ps.cheapest_price)*100/ps.cheapest_price,2) else null end,
    ps.price_date,round(ps.cheapest_price*(1+coalesce(input_margin_a,0)),2),
    round(ps.cheapest_price*(1+coalesce(input_margin_b,0)),2),coalesce(ps.supplier_count,0),
    'In Catalog'::text,ps.notes,nullif(btrim(ps.notes),'') is not null
  from catalog_page cp cross join params p join public.brands b on b.id=p.brand_id and b.organization_id=p.org_id
  left join price_summary ps on ps.normalized_code=public.normalize_catalog_product_code(cp.product_code)
  order by cp.product_code collate "C",cp.id;
end;
$function$;
revoke all on function public.cloud_master_page_fast(text,uuid,integer,integer,numeric,numeric) from public,anon;
grant execute on function public.cloud_master_page_fast(text,uuid,integer,integer,numeric,numeric) to authenticated;
