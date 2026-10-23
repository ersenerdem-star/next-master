-- Approved automotive identity: Contitech -> Continental CTAM.
-- Bare Continental is resolved only for a strict standard PK belt article.
-- Tire, air spring and VDO identities are not aliases.
CREATE OR REPLACE FUNCTION supplier_price_validation_internal.is_standard_pk_belt_code(input_code text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 select upper(regexp_replace(btrim(coalesce(input_code,'')),'[[:space:]]+','','g'))
   ~ '^[1-9][0-9]?PK[1-9][0-9]{2,4}$';
$fn$;
CREATE OR REPLACE FUNCTION supplier_price_validation_internal.canonical_automotive_brand_key(input_brand text,input_code text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 select case
   when public.normalize_part_code(input_brand) in ('CONTITECH','CONTINENTALCTAM') then 'CONTINENTALCTAM'
   when public.normalize_part_code(input_brand)='CONTINENTAL'
     and supplier_price_validation_internal.is_standard_pk_belt_code(input_code) then 'CONTINENTALCTAM'
   else public.normalize_part_code(input_brand) end;
$fn$;
CREATE OR REPLACE FUNCTION supplier_price_validation_internal.shared_pk_belt_dimension(input_brand text,other_brand text,input_code text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 select supplier_price_validation_internal.is_standard_pk_belt_code(input_code)
   and supplier_price_validation_internal.canonical_automotive_brand_key(input_brand,'') in ('CONTINENTALCTAM','GATES','DAYCO')
   and supplier_price_validation_internal.canonical_automotive_brand_key(other_brand,'') in ('CONTINENTALCTAM','GATES','DAYCO');
$fn$;
REVOKE ALL ON FUNCTION supplier_price_validation_internal.is_standard_pk_belt_code(text),
 supplier_price_validation_internal.canonical_automotive_brand_key(text,text),
 supplier_price_validation_internal.shared_pk_belt_dimension(text,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- No live alias source may become hidden when requests canonicalize to CTAM.
-- Existing held source rows are reused through normal verified upload instead
-- of changing immutable release/session/handoff brand or source bindings.
DO $preflight$
begin
 if exists(select 1 from public.supplier_current_price_pointers p join public.brands b on b.id=p.brand_id
   where b.normalized_name='CONTITECH')
 or exists(select 1 from public.supplier_prices p join public.brands b on b.id=p.brand_id
   where b.normalized_name='CONTITECH' and p.is_active) then
   raise exception 'CONTITECH_ACTIVE_SOURCE_REQUIRES_REVIEW';
 end if;
end;
$preflight$;

CREATE OR REPLACE FUNCTION public.cloud_current_supplier_commercial_options_core(input_organization_id uuid, input_code text, input_brand text)
 RETURNS TABLE(supplier_id uuid, supplier_name text, brand_id uuid, brand text, product_code text, description text, buy_price numeric, price_date date, notes text, moq integer, order_multiple integer, stock_qty integer, valid_to date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with request as materialized (
    select input_organization_id as organization_id,
      upper(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(input_code,'')), '[[:space:]]+', '', 'g')) as exact_code,
      public.normalize_part_code(input_code) as loose_code,
      supplier_price_validation_internal.canonical_automotive_brand_key(input_brand,input_code) as brand_code
  ),
  requested_brand as materialized (
    select b.id, b.name, r.organization_id, r.exact_code, r.loose_code
    from request r
    join public.brands b on b.organization_id=r.organization_id
      and b.normalized_name=r.brand_code
    where r.exact_code<>'' and r.loose_code<>'' and r.brand_code<>''
  ),
  pointer_scope as materialized (
    select ptr.supplier_id, ptr.release_id, ptr.publication_id
    from requested_brand b
    join public.supplier_current_price_pointers ptr
      on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
  ),
  current_publications as materialized (
    select ptr.supplier_id, ptr.release_id
    from requested_brand b
    join pointer_scope ptr on true
    join public.supplier_price_publications pub
      on pub.id=ptr.publication_id and pub.release_id=ptr.release_id
      and pub.organization_id=b.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=b.id
      and pub.status='published'
  ),
  exact_rows as materialized (
    select ptr.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, r.product_code, r.description, r.buy_price,
      r.valid_from as price_date, r.notes, r.moq, r.order_multiple, r.stock_qty, r.valid_to, r.id::text as source_id
    from requested_brand b
    join current_publications ptr on true
    join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      and r.normalized_code=b.exact_code
    join public.suppliers s on s.id=ptr.supplier_id and s.organization_id=b.organization_id
    where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
      and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
      and r.normalized_code=upper(pg_catalog.regexp_replace(r.product_code,'[[:space:]]+','','g'))
    union all
    select sp.supplier_id, s.name, b.id, b.name, sp.product_code,
      sp.description, sp.buy_price, sp.valid_from, sp.notes, sp.moq, sp.order_multiple, sp.stock_qty, sp.valid_to, sp.id::text
    from requested_brand b
    join public.supplier_prices sp on sp.organization_id=b.organization_id
      and sp.brand_id=b.id and sp.normalized_code=b.loose_code
      and sp.is_active and sp.buy_price>0 and sp.currency='EUR'
      and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
    join public.suppliers s on s.id=sp.supplier_id and s.organization_id=b.organization_id
    where upper(pg_catalog.btrim(sp.product_code))=upper(pg_catalog.btrim(input_code))
      and not exists (select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
  ),
  legacy_loose_rows as materialized (
    select sp.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, sp.product_code, sp.description, sp.buy_price,
      sp.valid_from as price_date, sp.notes, sp.moq, sp.order_multiple, sp.stock_qty, sp.valid_to, sp.id::text as source_id
    from requested_brand b
    join public.supplier_prices sp on sp.organization_id=b.organization_id
      and sp.brand_id=b.id and sp.normalized_code=b.loose_code
      and sp.is_active and sp.buy_price>0 and sp.currency='EUR'
      and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
    join public.suppliers s on s.id=sp.supplier_id and s.organization_id=b.organization_id
    where b.loose_code<>'' and not exists (select 1 from exact_rows)
      and not exists (select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
      and upper(pg_catalog.regexp_replace(pg_catalog.btrim(sp.product_code),'[[:space:]]+','','g'))=b.exact_code
  ),
  unambiguous as materialized (
    select count(distinct upper(pg_catalog.regexp_replace(pg_catalog.btrim(product_code),'[[:space:]]+','','g')))=1 as safe
    from legacy_loose_rows
  ),
  candidates as (
    select * from exact_rows
    union all
    select lr.* from legacy_loose_rows lr
    cross join unambiguous u
    where u.safe
  ),
  latest_per_supplier as (
    select c.*, row_number() over (
      partition by c.supplier_id, upper(pg_catalog.regexp_replace(pg_catalog.btrim(c.product_code),'[[:space:]]+','','g'))
      order by c.price_date desc, c.source_id desc
    ) as supplier_rank
    from candidates c
  )
  select c.supplier_id,c.supplier_name,c.brand_id,c.brand,c.product_code,
    c.description,c.buy_price,c.price_date,c.notes,c.moq,c.order_multiple,c.stock_qty,c.valid_to
  from latest_per_supplier c
  where c.supplier_rank=1
  order by c.buy_price asc,c.price_date desc,c.supplier_id
  limit 25;
$function$
;

CREATE OR REPLACE FUNCTION public.cloud_current_supplier_price_options_batch(input_requests jsonb)
 RETURNS TABLE(request_index integer, has_published_scope boolean, options jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'SUPPLIER_PRICE_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'SUPPLIER_PRICE_ORGANIZATION_REQUIRED';
  end if;
  if pg_catalog.jsonb_typeof(input_requests) is distinct from 'array' then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if pg_catalog.jsonb_array_length(input_requests) not between 1 and 25 then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(input_requests) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value->'code') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value->'brand') is distinct from 'string'
      or pg_catalog.length(pg_catalog.btrim(item.value->>'code')) not between 1 and 100
      or pg_catalog.length(pg_catalog.btrim(item.value->>'brand')) not between 1 and 100
  ) then
    raise exception 'SUPPLIER_PRICE_BATCH_INPUT_INVALID';
  end if;

  return query
  with requested as materialized (
    select (item.ordinality - 1)::integer as row_index,
      pg_catalog.btrim(item.value->>'code') as code,
      pg_catalog.btrim(item.value->>'brand') as brand
    from pg_catalog.jsonb_array_elements(input_requests) with ordinality as item(value, ordinality)
  ), scoped as materialized (
    select r.*,
      exists (
        select 1
        from public.brands b
        join public.supplier_current_price_pointers ptr
          on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        where b.organization_id=v_organization_id
          and b.normalized_name=supplier_price_validation_internal.canonical_automotive_brand_key(r.brand,r.code)
      ) as published_scope
    from requested r
  )
  select s.row_index, s.published_scope,
    coalesce(p.options, '[]'::jsonb) as options
  from scoped s
  left join lateral (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o)
      order by o.buy_price, o.price_date desc, o.supplier_id) as options
    from public.cloud_current_supplier_commercial_options_core(
      v_organization_id,s.code,s.brand) o
  ) p on true
  order by s.row_index;
end;
$function$
;

CREATE OR REPLACE FUNCTION supplier_price_validation_internal.cross_brand_audit(input_release_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_result jsonb;
  v_selected_brand_name text;
  v_brand_scope uuid[];
begin
  select r.* into strict v_release from public.supplier_price_releases r where r.id=input_release_id;
  if not exists(select 1 from public.brands b where b.id=v_release.brand_id and b.organization_id=v_release.organization_id)
     or not exists(select 1 from public.suppliers s where s.id=v_release.supplier_id and s.organization_id=v_release.organization_id) then
    raise exception 'BRAND_IDENTITY_SCOPE_INVALID';
  end if;
  if pg_catalog.to_regclass('public.catalog_products') is null
     or pg_catalog.to_regclass('public.supplier_prices') is null
     or pg_catalog.to_regclass('public.catalog_product_source_records') is null then
    return jsonb_build_object('policy','cross-brand-v3','checked',false,'review_required',true,
      'reason','BRAND_IDENTITY_COMPARISON_UNAVAILABLE');
  end if;
  select name into strict v_selected_brand_name from public.brands where id=v_release.brand_id;
  select array_agg(b.id) into v_brand_scope from public.brands b
  where b.organization_id=v_release.organization_id
    and supplier_price_validation_internal.canonical_automotive_brand_key(b.name,'')
      =supplier_price_validation_internal.canonical_automotive_brand_key(v_selected_brand_name,'');
  -- Keep normalization byte-for-byte equivalent to normalize_part_code(text),
  -- but calculate it once per source row. The old function wrapper has its own
  -- search_path setting, so it cannot be inlined and caused repeated heap reads
  -- through the expression index for million-row imports.
  with normalized_incoming as materialized (
    select regexp_replace(upper(coalesce(rr.product_code, '')), '[^A-Z0-9]', '', 'g') code,
      supplier_price_validation_internal.is_standard_pk_belt_code(rr.product_code) dimension_code
    from public.supplier_price_release_rows rr where rr.release_id=input_release_id
  ), incoming as materialized (
    select code,bool_and(dimension_code) dimension_code from normalized_incoming where code <> '' group by code
  ), published_scopes as materialized (
    select r.id release_id,r.brand_id
    from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
    join public.supplier_price_releases r on r.id=ptr.release_id
      and r.organization_id=ptr.organization_id and r.supplier_id=ptr.supplier_id
      and r.brand_id=ptr.brand_id and r.status='published'
    where ptr.organization_id=v_release.organization_id and ptr.brand_id<>all(v_brand_scope)
  ), catalog_matches as materialized (
    select c.brand_id, i.code, supplier_price_validation_internal.is_standard_pk_belt_code(c.product_code) source_pk, exists (
      select 1 from public.catalog_product_source_records sr
      where sr.organization_id=v_release.organization_id and sr.catalog_product_id=c.id
    ) has_provenance
    from incoming i join public.catalog_products c on c.normalized_code=i.code
      and c.organization_id=v_release.organization_id and c.brand_id<>all(v_brand_scope)
  ), raw_matches as materialized (
    select c.brand_id,c.code,c.source_pk from catalog_matches c where c.has_provenance
    union
    select p.brand_id, i.code, supplier_price_validation_internal.is_standard_pk_belt_code(p.product_code) source_pk
    from incoming i join public.supplier_prices p on p.normalized_code=i.code
      and p.organization_id=v_release.organization_id and p.brand_id<>all(v_brand_scope) and p.is_active=true
    union
    -- Small uploads probe the existing compact-code index. They must not
    -- normalize every row of unrelated million-row published lists.
    select rel.brand_id,i.code,supplier_price_validation_internal.is_standard_pk_belt_code(hit.product_code) source_pk from published_scopes rel cross join incoming i
    cross join lateral (
      select rr.product_code from public.supplier_price_release_rows rr
      where rr.release_id=rel.release_id and rr.row_status='accepted'
        and public.normalize_part_code(rr.product_code)=i.code limit 1
    ) hit
    where coalesce(v_release.total_rows,0)<50000
    union
    -- Large uploads retain the single-pass hash comparison, avoiding millions
    -- of random index probes. Both paths implement the same compact identity.
    select rel.brand_id,i.code,supplier_price_validation_internal.is_standard_pk_belt_code(rr.product_code) source_pk from published_scopes rel
    join public.supplier_price_release_rows rr on rr.release_id=rel.release_id and rr.row_status='accepted'
    join incoming i on i.code=regexp_replace(upper(coalesce(rr.product_code,'')), '[^A-Z0-9]', '', 'g')
    where coalesce(v_release.total_rows,0)>=50000
  ), source_matches as materialized (
    select brand_id,code,bool_and(source_pk) source_pk from raw_matches group by brand_id,code
  ), dimension_matches as materialized (
    select m.brand_id,m.code from source_matches m join incoming i on i.code=m.code
    join public.brands b on b.id=m.brand_id and b.organization_id=v_release.organization_id
    where i.dimension_code and m.source_pk
      and supplier_price_validation_internal.shared_pk_belt_dimension(v_selected_brand_name,b.name,m.code)
  ), matches as materialized (
    select m.brand_id,m.code from source_matches m where not exists (
      select 1 from dimension_matches d where d.brand_id=m.brand_id and d.code=m.code
    )
  ), classified_matches as (
    select m.brand_id,m.code,false historical from matches m
    union
    select c.brand_id,c.code,true historical from catalog_matches c
    where not c.has_provenance and not exists (
      select 1 from matches m where m.brand_id=c.brand_id and m.code=c.code
    )
  ), ranked as (
    select m.brand_id, m.code, m.historical,
      row_number() over(partition by m.historical,m.brand_id order by m.code collate "C") sample_rank
    from classified_matches m
    join public.brands b on b.id=m.brand_id and b.organization_id=v_release.organization_id
  ), grouped as (
    select x.brand_id, x.historical, count(*) matching_codes,
      jsonb_agg(x.code order by x.code collate "C") filter(where x.sample_rank<=10) sample_codes
    from ranked x group by x.historical,x.brand_id
  ), counts as (select count(*) n from incoming), evidence as (
    select g.*, b.name brand_name, round(100.0*g.matching_codes/nullif(c.n,0),2) incoming_percent
    from grouped g join public.brands b on b.id=g.brand_id cross join counts c
    order by g.matching_codes desc, g.brand_id
  )
  select jsonb_build_object('policy','cross-brand-v3','checked',true,'checked_at',clock_timestamp(),
    'selected_brand_id',v_release.brand_id,'selected_brand_name',(select b.name from public.brands b where b.id=v_release.brand_id),
    'ratio_threshold_percent',5,'ratio_comparison','strictly_greater',
    'distinct_incoming_codes',(select n from counts),
    'review_required',(select n=0 from counts) or coalesce((select bool_or(matching_codes::numeric*100 > (select n from counts)*5) from evidence where not historical),false),
    'matching_brand_count',(select count(*) from evidence where not historical),
    'brands',coalesce((select jsonb_agg(to_jsonb(e)-'historical') from (select * from evidence where not historical limit 10) e),'[]'::jsonb),
    'shared_dimension_matches',coalesce((select jsonb_agg(x) from (select b.name brand_name,count(*) matching_codes from dimension_matches d join public.brands b on b.id=d.brand_id group by b.name order by b.name) x),'[]'::jsonb),
    'historical_matching_brand_count',(select count(*) from evidence where historical),
    'historical_brands',coalesce((select jsonb_agg(to_jsonb(e)-'historical') from (select * from evidence where historical limit 10) e),'[]'::jsonb))
  into v_result;
  return v_result;
end;
$function$;

REVOKE ALL ON FUNCTION supplier_price_validation_internal.cross_brand_audit(uuid) FROM PUBLIC, anon, authenticated, service_role;


