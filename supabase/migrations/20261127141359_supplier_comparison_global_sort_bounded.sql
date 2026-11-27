-- Exact global sorting over bounded brands.  Do not change the fast default
-- page reader: this query must read every eligible offer in the chosen brand.
-- Larger scopes fail explicitly until a resumable, indexed snapshot exists.
create or replace function public.report_supplier_comparison_sorted(
  input_brand_id uuid,
  input_search text default '',
  input_sort text default 'bestPrice',
  input_direction text default 'asc',
  input_page integer default 1,
  input_page_size integer default 50,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15,
  input_expected_version text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_org uuid := public.current_profile_org_id();
  v_brand text;
  v_exact text := nullif(public.normalize_catalog_product_code(input_search),'');
  v_estimate bigint;
  v_legacy bigint;
  v_manual bigint;
  v_version text;
  v_result jsonb;
begin
  if auth.uid() is null or v_org is null
    or not coalesce(public.is_superadmin() or public.profile_has_permission('reports.view'),false) then
    raise exception 'SUPPLIER_COMPARISON_ACCESS_DENIED' using errcode='42501';
  end if;
  if input_brand_id is null or coalesce(input_sort,'') not in ('product','decision','bestPrice','second','gap')
    or coalesce(input_direction,'') not in ('asc','desc') or input_page is null or input_page not between 1 and 2000
    or input_page_size is null or input_page_size not between 1 and 50 or length(coalesce(input_search,''))>256
    or input_margin_a is null or input_margin_a not between -1 and 10 or input_margin_b is null or input_margin_b not between -1 and 10
    or (input_expected_version is not null and length(input_expected_version)>128) then
    raise exception 'SUPPLIER_COMPARISON_SORT_INPUT_INVALID' using errcode='22023';
  end if;
  select b.name into v_brand from public.brands b where b.id=input_brand_id and b.organization_id=v_org;
  if v_brand is null then raise exception 'SUPPLIER_COMPARISON_BRAND_INVALID' using errcode='22023'; end if;
  v_version:=public.get_catalog_master_export_version(v_org,input_brand_id,'priced');
  if input_expected_version is not null and input_expected_version<>v_version
  then return jsonb_build_object('stale',true,'rows','[]'::jsonb); end if;
  -- The legacy-only reader supports substring/OEM/description search while
  -- published/manual scope is exact SKU. Never silently narrow that legacy
  -- result set to an exact code when global sorting is requested.
  if v_exact is not null
    and not exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=v_org and p.brand_id=input_brand_id)
    and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_org and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date)
  then return jsonb_build_object('search_not_supported',true,'rows','[]'::jsonb); end if;
  if v_exact is null then
    select coalesce(sum(coalesce(r.accepted_rows,100001)),0) into v_estimate
      from public.supplier_current_price_pointers p
      join public.supplier_price_publications pub on pub.id=p.publication_id and pub.release_id=p.release_id
        and pub.organization_id=p.organization_id and pub.brand_id=p.brand_id and pub.supplier_id=p.supplier_id
        and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
      left join public.supplier_price_releases r on r.id=p.release_id
      where p.organization_id=v_org and p.brand_id=input_brand_id;
    if v_estimate>100000 then return jsonb_build_object('scope_too_large',true,'rows','[]'::jsonb); end if;
    select count(*) into v_legacy from (select 1 from public.supplier_prices s
      join public.suppliers u on u.id=s.supplier_id and u.organization_id=v_org and u.price_usage_enabled
      where s.organization_id=v_org and s.brand_id=input_brand_id and s.is_active
        and not exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=v_org
          and p.brand_id=input_brand_id and p.supplier_id=s.supplier_id) limit 100001) x;
    select count(*) into v_manual from (select 1 from supplier_manual_price_internal.entries m
      join public.suppliers u on u.id=m.supplier_id and u.organization_id=v_org and u.price_usage_enabled
      where m.organization_id=v_org and m.brand_id=input_brand_id and m.active limit 100001) x;
    if v_estimate+v_legacy+v_manual>100000 then return jsonb_build_object('scope_too_large',true,'rows','[]'::jsonb); end if;
  end if;

  with pointers as materialized (
    select p.supplier_id,p.release_id,p.publication_id from public.supplier_current_price_pointers p
    where p.organization_id=v_org and p.brand_id=input_brand_id
  ), published as (
    select r.normalized_code exact_code,r.product_code,r.description,r.buy_price,r.valid_from,r.notes,
      p.supplier_id,s.name supplier_name,r.id::text source_id,r.id source_seq
    from pointers p
    join public.supplier_price_publications pub on pub.id=p.publication_id and pub.release_id=p.release_id
      and pub.organization_id=v_org and pub.brand_id=input_brand_id and pub.supplier_id=p.supplier_id
      and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
    join public.supplier_price_release_rows r on r.release_id=p.release_id
    join public.suppliers s on s.id=p.supplier_id and s.organization_id=v_org
    where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
      and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
      and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
      and r.normalized_code ~ '[A-Z0-9]' and (v_exact is null or r.normalized_code=v_exact)
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_org
        and m.brand_id=input_brand_id and m.supplier_id=p.supplier_id and m.exact_code=r.normalized_code
        and m.active and m.valid_from<=current_date)
  ), legacy as (
    select public.normalize_catalog_product_code(sp.product_code) exact_code,sp.product_code,sp.description,
      sp.buy_price,sp.valid_from,sp.notes,sp.supplier_id,s.name supplier_name,sp.id::text source_id,null::bigint source_seq
    from public.supplier_prices sp join public.suppliers s on s.id=sp.supplier_id and s.organization_id=v_org and s.price_usage_enabled
    where sp.organization_id=v_org and sp.brand_id=input_brand_id and sp.is_active and sp.buy_price>0
      and sp.currency='EUR' and sp.valid_from<=current_date and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and (v_exact is null or (sp.normalized_code=public.normalize_part_code(input_search)
        and public.normalize_catalog_product_code(sp.product_code)=v_exact))
      and not exists(select 1 from pointers p where p.supplier_id=sp.supplier_id)
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_org
        and m.brand_id=input_brand_id and m.supplier_id=sp.supplier_id
        and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
  ), manual as (
    select m.exact_code,m.product_code,m.description,m.buy_price,m.valid_from,m.notes,
      m.supplier_id,s.name supplier_name,m.id::text source_id,null::bigint source_seq
    from supplier_manual_price_internal.entries m
    join public.suppliers s on s.id=m.supplier_id and s.organization_id=v_org and s.price_usage_enabled
    where m.organization_id=v_org and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
      and (v_exact is null or m.exact_code=v_exact)
  ), candidates as (select * from published union all select * from legacy union all select * from manual),
  latest as (select c.*,row_number() over(partition by c.exact_code,c.supplier_id order by c.valid_from desc,c.source_seq desc nulls last,c.source_id desc) supplier_rank from candidates c),
  ranked as (select c.*,row_number() over(partition by c.exact_code order by c.buy_price,c.valid_from desc,c.supplier_id) price_rank
    from latest c where c.supplier_rank=1),
  summary as (
    select exact_code,max(product_code) filter(where price_rank=1) product_code,
      max(description) filter(where price_rank=1) description,max(supplier_name) filter(where price_rank=1) cheapest_supplier,
      max(buy_price) filter(where price_rank=1) cheapest_price,max(supplier_name) filter(where price_rank=2) second_supplier_name,
      max(buy_price) filter(where price_rank=2) second_price,max(valid_from) filter(where price_rank=1) price_date,
      max(notes) filter(where price_rank=1) notes,bool_or(nullif(btrim(coalesce(notes,'')),'') is not null) has_notes,
      count(*)::bigint supplier_count from ranked group by exact_code
  ), scores as (
    select s.*,case when second_price is null then null else second_price-cheapest_price end price_gap,
      case when second_price is null then null else round((second_price-cheapest_price)*100/cheapest_price,2) end price_gap_percent,
      count(*) over() total_count from summary s
  ), sorted as materialized (
    select s.*,row_number() over (order by
      case when input_sort='product' and input_direction='asc' then s.exact_code end asc nulls last,
      case when input_sort='product' and input_direction='desc' then s.exact_code end desc nulls last,
      case when input_sort='decision' and input_direction='asc' then lower(s.cheapest_supplier) end asc nulls last,
      case when input_sort='decision' and input_direction='desc' then lower(s.cheapest_supplier) end desc nulls last,
      case when input_sort='bestPrice' and input_direction='asc' then s.cheapest_price end asc nulls last,
      case when input_sort='bestPrice' and input_direction='desc' then s.cheapest_price end desc nulls last,
      case when input_sort='second' and input_direction='asc' then s.second_price end asc nulls last,
      case when input_sort='second' and input_direction='desc' then s.second_price end desc nulls last,
      case when input_sort='gap' and input_direction='asc' then s.price_gap_percent end asc nulls last,
      case when input_sort='gap' and input_direction='desc' then s.price_gap_percent end desc nulls last,
      s.exact_code collate "C" asc) ordinal
    from scores s
  ), paged as (
    select * from sorted s order by ordinal
    limit input_page_size offset ((input_page-1)*input_page_size)
  )
  select jsonb_build_object('source_version',v_version,'rows',coalesce(jsonb_agg(jsonb_build_object(
    'total_count',p.total_count,'product_id',null,'product_code',p.product_code,'brand',v_brand,
    'description',p.description,'oem_no',null,'hs_code',null,'origin',null,'weight_kg',null,
    'cheapest_supplier',p.cheapest_supplier,'cheapest_price',p.cheapest_price,'second_supplier_name',p.second_supplier_name,
    'second_price',p.second_price,'price_gap',p.price_gap,'price_gap_percent',p.price_gap_percent,'price_date',p.price_date,
    'sales_a',round(p.cheapest_price*(1+input_margin_a),2),'sales_b',round(p.cheapest_price*(1+input_margin_b),2),
    'supplier_count',p.supplier_count,'catalog_status','Supplier Price Only','notes',p.notes,'has_notes',p.has_notes) order by p.ordinal), '[]'::jsonb))
  into v_result from paged p;
  return v_result;
end;
$function$;
revoke all on function public.report_supplier_comparison_sorted(uuid,text,text,text,integer,integer,numeric,numeric,text) from public,anon,authenticated,service_role;
grant execute on function public.report_supplier_comparison_sorted(uuid,text,text,text,integer,integer,numeric,numeric,text) to authenticated;
notify pgrst, 'reload schema';
