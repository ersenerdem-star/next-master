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
      select 1 from source_matches m where m.brand_id=c.brand_id and m.code=c.code
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

  if v_result->>'checked' = 'true' and v_result->>'review_required' = 'true'
     and v_release.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
     and v_release.supplier_id = 'bb8aa954-5c9c-4edb-8c25-37e170253a1b'::uuid
     and v_release.status in ('validated','review_required')
     and v_release.source_verification_required is true
     and v_release.accepted_rows = v_release.total_rows
     and v_release.rejected_rows = 0 and v_release.conflict_rows = 0
     and exists (
       select 1 from (values
         ('f4ab679d-fbd7-4b05-8483-23362727f3c6'::uuid,'6a667fc1-3785-4f02-88fd-031b02cc9d50'::uuid,'28404f30319ef59d83bea72f9e7a9c5b60f2c5988a866d5e1640046369d7b02d',492::bigint,'e7d121f2b5b2dd2b460ad1f894c6bf66'),
         ('3242b9b7-d4d4-461e-a152-fd446851b571'::uuid,'de39a284-7a8b-4c55-a58c-84b390ae19fc'::uuid,'b887af330dfc5383220046285918a6f8e2ce33f194e45df05e34cb50ac189832',1916::bigint,'7d153519ea914710fa4e9a33734f89ac'),
         ('8bcc1c47-eac9-488e-92cc-1d9175523d9a'::uuid,'bc9c1aaf-8a74-4add-890d-624580da5df0'::uuid,'0c9c039fb63bbfd93902606a6ee42b72d6825f414254295ea76fdbe3a64a7654',78::bigint,'559efd6adc8dad8c17d051d3bf0d88ca')
       ) approved(release_id,brand_id,sha256,row_count,row_digest)
       where approved.release_id=v_release.id and approved.brand_id=v_release.brand_id
         and approved.sha256=v_release.source_file_sha256 and approved.row_count=v_release.total_rows
         and (select count(*) from public.supplier_price_release_rows rr where rr.release_id=v_release.id and rr.row_status='accepted')=approved.row_count
         and (select md5(string_agg(rr.source_row_number::text||'|'||rr.product_code||'|'||to_char(rr.buy_price,'FM999999999999990.00'), E'\n' order by rr.source_row_number))
              from public.supplier_price_release_rows rr where rr.release_id=v_release.id)=approved.row_digest
     ) then
    v_result := v_result || jsonb_build_object('review_required',false,
      'original_review_required',true,'owner_approved_exception','groupauto-borgwarner-20261120',
      'exception_scope','exact_release_and_file_and_rows');
  end if;
  return v_result;

end;
$function$
