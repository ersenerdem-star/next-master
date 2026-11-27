-- Stable keyset continuation for unfiltered priced reports. Reads only;
-- no price, order, or list rows are changed. Source versions fence each page.
create schema if not exists supplier_comparison_internal;
revoke all on schema supplier_comparison_internal from public,anon,authenticated,service_role;
create or replace function supplier_comparison_internal.cursor_page(
 input_organization_id uuid,input_brand_id uuid,input_after_code text default '',input_expected_version text default null,
 input_page_size integer default 50,input_margin_a numeric default 0.10,input_margin_b numeric default 0.15
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
 v_organization_id uuid:=input_organization_id;
 v_brand_name text;
 v_page_size integer:=input_page_size;
 v_scan_limit integer:=input_page_size;
 v_after text:=public.normalize_catalog_product_code(input_after_code);
 v_exact_code text:=null;
 v_version text;
 v_result jsonb;
begin
 if v_organization_id is null or input_brand_id is null or input_after_code is null or length(input_after_code)>256 or input_page_size is null
  or input_page_size not between 1 and 1000 or input_margin_a is null or input_margin_a not between -1 and 10
  or input_margin_b is null or input_margin_b not between -1 and 10
  or (input_expected_version is not null and length(input_expected_version)>128)
 then raise exception 'SUPPLIER_COMPARISON_CURSOR_INVALID' using errcode='22023'; end if;
 select b.name into v_brand_name from public.brands b where b.id=input_brand_id and b.organization_id=v_organization_id;
 if v_brand_name is null then raise exception 'SUPPLIER_COMPARISON_BRAND_INVALID' using errcode='22023'; end if;
 v_version:=public.get_catalog_master_export_version(v_organization_id,input_brand_id,'priced') || '|date:' || to_char(current_date, 'YYYY-MM-DD');
 if input_expected_version is not null and input_expected_version<>v_version
 then return jsonb_build_object('stale',true,'rows','[]'::jsonb); end if;
  with pointer_scope as materialized (
    select ptr.*
    from public.supplier_current_price_pointers ptr
    where ptr.organization_id = v_organization_id
      and ptr.brand_id = input_brand_id
  ),
  legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp
    where sp.organization_id=v_organization_id and sp.brand_id=input_brand_id and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=sp.organization_id and m.supplier_id=sp.supplier_id and m.brand_id=sp.brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
  ),
  current_releases as materialized (
    select ptr.release_id, ptr.supplier_id, s.name as supplier_name,
      rel.accepted_rows
    from pointer_scope ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id and pub.release_id = ptr.release_id
     and pub.organization_id = ptr.organization_id
     and pub.supplier_id = ptr.supplier_id and pub.brand_id = ptr.brand_id
     and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
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
        and r.normalized_code collate "C">v_after collate "C"
        and r.row_status = 'accepted' and r.buy_price > 0
        and r.currency = 'EUR' and r.valid_from <= current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code = pg_catalog.upper(
          pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
      order by r.normalized_code
      limit v_scan_limit
    ) candidate
  ),
  legacy_codes as materialized (
    select distinct l.exact_code normalized_code from legacy l
    where l.exact_code collate "C">v_after collate "C"
    order by l.exact_code limit v_scan_limit
  ),
  manual_codes as materialized (
    select distinct m.exact_code collate "C" normalized_code from supplier_manual_price_internal.entries m
    join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
    where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
      and m.exact_code collate "C">v_after collate "C"
    order by m.exact_code collate "C" limit v_scan_limit
  ),
  candidate_codes as materialized (
    select rc.normalized_code collate "C" normalized_code from release_codes rc
    union select lc.normalized_code from legacy_codes lc
    union select mc.normalized_code from manual_codes mc
  ),
  page_codes as materialized (
    select normalized_code
    from candidate_codes
    order by normalized_code collate "C"
    limit v_page_size
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
      and r.currency = 'EUR' and r.valid_from <= current_date and (r.valid_to is null or r.valid_to>=current_date)
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.supplier_id=cr.supplier_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
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
    union all select m.exact_code,m.product_code,m.description,m.buy_price,m.valid_from,m.notes,m.supplier_id,su.name,1::bigint
    from supplier_manual_price_internal.entries m join page_codes pc on pc.normalized_code=m.exact_code
    join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
    where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
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
      bool_or(nullif(pg_catalog.btrim(coalesce(notes,'')), '') is not null) as has_notes,
      count(*)::bigint as supplier_count
    from ranked
    group by normalized_code
  )
  select jsonb_build_object('source_version',v_version,'rows',coalesce((
   select jsonb_agg(jsonb_build_object(
    'total_count',null,'product_id',null,'product_code',sm.product_code,'cursor_code',sm.normalized_code,'brand',v_brand_name,
    'description',sm.description,'oem_no',null,'hs_code',null,'origin',null,'weight_kg',null,
    'cheapest_supplier',sm.cheapest_supplier,'cheapest_price',sm.cheapest_price,'second_supplier_name',sm.second_supplier_name,
    'second_price',sm.second_price,'price_gap',case when sm.second_price is null then null else sm.second_price-sm.cheapest_price end,
    'price_gap_percent',case when sm.second_price is null then null else round((sm.second_price-sm.cheapest_price)*100/sm.cheapest_price,2) end,
    'price_date',sm.price_date,'sales_a',round(sm.cheapest_price*(1+input_margin_a),2),'sales_b',round(sm.cheapest_price*(1+input_margin_b),2),
    'supplier_count',sm.supplier_count,'catalog_status','Supplier Price Only','notes',sm.notes,'has_notes',sm.has_notes
   ) order by sm.normalized_code collate "C") from summary sm),'[]'::jsonb)) into v_result;
 return v_result;
end;
$function$;
revoke all on function supplier_comparison_internal.cursor_page(uuid,uuid,text,text,integer,numeric,numeric) from public,anon,authenticated,service_role;

create or replace function public.report_supplier_comparison_cursor(
 input_brand_id uuid,input_after_code text default '',input_expected_version text default null,
 input_page_size integer default 50,input_margin_a numeric default 0.10,input_margin_b numeric default 0.15
) returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_organization_id uuid:=public.current_profile_org_id();
begin
 if auth.uid() is null or v_organization_id is null or not coalesce(public.is_superadmin() or public.profile_has_permission('reports.view'),false)
 then raise exception 'SUPPLIER_COMPARISON_ACCESS_DENIED' using errcode='42501'; end if;
 if input_page_size is null or input_page_size not between 1 and 50
 then raise exception 'SUPPLIER_COMPARISON_CURSOR_INVALID' using errcode='22023'; end if;
 return supplier_comparison_internal.cursor_page(v_organization_id,input_brand_id,input_after_code,input_expected_version,input_page_size,input_margin_a,input_margin_b);
end;
$function$;
revoke all on function public.report_supplier_comparison_cursor(uuid,text,text,integer,numeric,numeric) from public,anon,authenticated,service_role;
grant execute on function public.report_supplier_comparison_cursor(uuid,text,text,integer,numeric,numeric) to authenticated;

create or replace function public.report_supplier_comparison_cursor_service(
 input_organization_id uuid,input_brand_id uuid,input_after_code text default '',input_expected_version text default null,
 input_page_size integer default 1000,input_margin_a numeric default 0.10,input_margin_b numeric default 0.15
) returns jsonb language sql stable security definer set search_path='' as $function$
 select supplier_comparison_internal.cursor_page(input_organization_id,input_brand_id,input_after_code,input_expected_version,input_page_size,input_margin_a,input_margin_b);
$function$;
revoke all on function public.report_supplier_comparison_cursor_service(uuid,uuid,text,text,integer,numeric,numeric) from public,anon,authenticated,service_role;
grant execute on function public.report_supplier_comparison_cursor_service(uuid,uuid,text,text,integer,numeric,numeric) to service_role;
notify pgrst,'reload schema';
