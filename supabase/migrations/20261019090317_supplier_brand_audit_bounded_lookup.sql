-- Preserve the cross-brand-v1 thresholds, source coverage and publication gates.
-- Select indexed probes for small sources and retain single-pass comparison for large sources.
CREATE OR REPLACE FUNCTION supplier_price_validation_internal.cross_brand_audit(input_release_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_result jsonb;
begin
  select r.* into strict v_release from public.supplier_price_releases r where r.id=input_release_id;
  if not exists(select 1 from public.brands b where b.id=v_release.brand_id and b.organization_id=v_release.organization_id)
     or not exists(select 1 from public.suppliers s where s.id=v_release.supplier_id and s.organization_id=v_release.organization_id) then
    raise exception 'BRAND_IDENTITY_SCOPE_INVALID';
  end if;
  if pg_catalog.to_regclass('public.catalog_products') is null
     or pg_catalog.to_regclass('public.supplier_prices') is null then
    return jsonb_build_object('policy','cross-brand-v1','checked',false,'review_required',true,
      'reason','BRAND_IDENTITY_COMPARISON_UNAVAILABLE');
  end if;
  -- Keep normalization byte-for-byte equivalent to normalize_part_code(text),
  -- but calculate it once per source row. The old function wrapper has its own
  -- search_path setting, so it cannot be inlined and caused repeated heap reads
  -- through the expression index for million-row imports.
  with normalized_incoming as materialized (
    select regexp_replace(upper(coalesce(rr.product_code, '')), '[^A-Z0-9]', '', 'g') code
    from public.supplier_price_release_rows rr where rr.release_id=input_release_id
  ), incoming as materialized (
    select distinct code from normalized_incoming where code <> ''
  ), published_scopes as materialized (
    select r.id release_id,r.brand_id
    from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
    join public.supplier_price_releases r on r.id=ptr.release_id
      and r.organization_id=ptr.organization_id and r.supplier_id=ptr.supplier_id
      and r.brand_id=ptr.brand_id and r.status='published'
    where ptr.organization_id=v_release.organization_id and ptr.brand_id<>v_release.brand_id
  ), matches as (
    select c.brand_id, i.code
    from incoming i join public.catalog_products c on c.normalized_code=i.code
      and c.organization_id=v_release.organization_id and c.brand_id<>v_release.brand_id
    union
    select p.brand_id, i.code
    from incoming i join public.supplier_prices p on p.normalized_code=i.code
      and p.organization_id=v_release.organization_id and p.brand_id<>v_release.brand_id and p.is_active=true
    union
    -- Small uploads probe the existing compact-code index. They must not
    -- normalize every row of unrelated million-row published lists.
    select rel.brand_id,i.code from published_scopes rel cross join incoming i
    cross join lateral (
      select 1 from public.supplier_price_release_rows rr
      where rr.release_id=rel.release_id and rr.row_status='accepted'
        and public.normalize_part_code(rr.product_code)=i.code limit 1
    ) hit
    where coalesce(v_release.total_rows,0)<50000
    union
    -- Large uploads retain the single-pass hash comparison, avoiding millions
    -- of random index probes. Both paths implement the same compact identity.
    select rel.brand_id,i.code from published_scopes rel
    join public.supplier_price_release_rows rr on rr.release_id=rel.release_id and rr.row_status='accepted'
    join incoming i on i.code=regexp_replace(upper(coalesce(rr.product_code,'')), '[^A-Z0-9]', '', 'g')
    where coalesce(v_release.total_rows,0)>=50000
  ), ranked as (
    select m.brand_id, m.code, row_number() over(partition by m.brand_id order by m.code collate "C") sample_rank
    from matches m
    join public.brands b on b.id=m.brand_id and b.organization_id=v_release.organization_id
  ), grouped as (
    select x.brand_id, count(*) matching_codes,
      jsonb_agg(x.code order by x.code collate "C") filter(where x.sample_rank<=10) sample_codes
    from ranked x group by x.brand_id
  ), counts as (select count(*) n from incoming), evidence as (
    select g.*, b.name brand_name, round(100.0*g.matching_codes/nullif(c.n,0),2) incoming_percent
    from grouped g join public.brands b on b.id=g.brand_id cross join counts c
    order by g.matching_codes desc, g.brand_id
  )
  select jsonb_build_object('policy','cross-brand-v1','checked',true,'checked_at',clock_timestamp(),
    'selected_brand_id',v_release.brand_id,'selected_brand_name',(select b.name from public.brands b where b.id=v_release.brand_id),
    'threshold_codes',5000,'ratio_min_codes',100,'ratio_threshold_percent',80,
    'distinct_incoming_codes',(select n from counts),
    'review_required',(select n=0 from counts) or coalesce((select bool_or(matching_codes>=5000
      or (matching_codes>=100 and matching_codes::numeric*100 >= (select n from counts)*80)) from evidence),false),
    'matching_brand_count',(select count(*) from evidence),
    'brands',coalesce((select jsonb_agg(to_jsonb(e)) from (select * from evidence limit 10) e),'[]'::jsonb))
  into v_result;
  return v_result;
end;
$function$;

REVOKE ALL ON FUNCTION supplier_price_validation_internal.cross_brand_audit(uuid) FROM PUBLIC, anon, authenticated, service_role;

