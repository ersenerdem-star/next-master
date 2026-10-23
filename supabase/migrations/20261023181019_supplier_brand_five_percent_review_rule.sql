-- Separate unsupported historical catalogue membership from brand identity evidence.
-- Canonical source records, active legacy prices and current publications remain
-- blocking evidence. Collector availability does not invalidate canonical provenance.
-- No catalogue, source, archived price or publication data is rewritten.
-- User rule: only supported overlap strictly above 5% requires brand review.
-- Exactly 5% is normal, with no absolute-count override or minimum row count.
-- Bounded small/large lookup strategies and all publication gates remain.
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
     or pg_catalog.to_regclass('public.supplier_prices') is null
     or pg_catalog.to_regclass('public.catalog_product_source_records') is null then
    return jsonb_build_object('policy','cross-brand-v3','checked',false,'review_required',true,
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
  ), catalog_matches as materialized (
    select c.brand_id, i.code, exists (
      select 1 from public.catalog_product_source_records sr
      where sr.organization_id=v_release.organization_id and sr.catalog_product_id=c.id
    ) has_provenance
    from incoming i join public.catalog_products c on c.normalized_code=i.code
      and c.organization_id=v_release.organization_id and c.brand_id<>v_release.brand_id
  ), matches as materialized (
    select c.brand_id,c.code from catalog_matches c where c.has_provenance
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
    'historical_matching_brand_count',(select count(*) from evidence where historical),
    'historical_brands',coalesce((select jsonb_agg(to_jsonb(e)-'historical') from (select * from evidence where historical limit 10) e),'[]'::jsonb))
  into v_result;
  return v_result;
end;
$function$;

REVOKE ALL ON FUNCTION supplier_price_validation_internal.cross_brand_audit(uuid) FROM PUBLIC, anon, authenticated, service_role;


-- Publication and reversal refresh the audit inside their locked transactions,
-- but previously hard-coded v1 afterward. Accept known contracts while keeping
-- freshness, checked/review flags, scope, source, ACLs and fencing unchanged.
DO $policy_contract$
declare
  signature text;
  definition text;
  old_check text := 'v_identity->>''policy'' is distinct from ''cross-brand-v1''';
  new_check text := 'coalesce(v_identity->>''policy'','''') not in (''cross-brand-v1'',''cross-brand-v2'',''cross-brand-v3'')';
begin
  foreach signature in array array[
    'public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)',
    'public.reverse_supplier_price_publication_production(text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)',
    'supplier_price_ingestion_internal.admin_publish_staging(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'SUPPLIER_PUBLICATION_POLICY_ADAPTER_MISSING: %',signature;
    end if;
    select pg_get_functiondef(to_regprocedure(signature)) into definition;
    if position(old_check in definition)=0 then
      raise exception 'SUPPLIER_PUBLICATION_POLICY_ADAPTER_DRIFT: %',signature;
    end if;
    execute replace(definition,old_check,new_check);
  end loop;
end;
$policy_contract$;
