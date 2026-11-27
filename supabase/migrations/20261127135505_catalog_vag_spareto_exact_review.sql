-- Secondary evidence only. The Partslink24 access policy remains independent.
insert into public.catalog_external_sources
 (organization_id,source_key,display_name,source_owner,source_type,base_url,license_posture,robots_posture,
  rate_limit_posture,credential_boundary,is_active,metadata)
select s.organization_id,'spareto_vag_exact_review_v1','Spareto · Volkswagen AG exact product review','Spareto','open_web',
 'https://spareto.com/','internal_review_required','allowed','bounded','none',true,
 '{"allowed_brands":["VAG"],"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":false,"exact_product_review_only":true,"automatic_apply":false}'::jsonb
from public.catalog_external_sources s
where s.source_key='spareto_secondary_exact_v1' and s.is_active and s.robots_posture='allowed'
 and s.credential_boundary='none' and s.rate_limit_posture='bounded'
 and s.license_posture in ('allowed','internal_review_required')
 and s.metadata->>'secondary_review_read_allowed'='true' and s.metadata->'allowed_brands' ? 'VAG'
on conflict(organization_id,source_key) do nothing;

alter table public.catalog_brand_jobs add constraint catalog_vag_spareto_review_only
check (manifest->>'source_key' is distinct from 'spareto_vag_exact_review_v1' or
 (mode='stage' and total_items<=3 and manifest->>'brand' is not distinct from 'VAG'
  and manifest->>'adapter' is not distinct from 'vag-spareto-exact-review.v1')) not valid;

create schema if not exists catalog_vag_review_internal;
revoke all on schema catalog_vag_review_internal from public,anon,authenticated;
grant usage on schema catalog_vag_review_internal to service_role;

-- Read one canonical code from the published family. The protected price
-- tables retain their privileges and no prices leave this interface.
create function catalog_vag_review_internal.published_article(input_org uuid,input_code text)
returns table (matches int,ean_count int,expected_ean text)
language plpgsql stable security definer set search_path='' set statement_timeout='3s' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  return query
    select count(*)::int,count(distinct ean)::int,min(ean) from (
     select nullif(btrim(r.ean),'') ean
     from public.brands b
     join public.supplier_current_price_pointers p on p.organization_id=b.organization_id and p.brand_id=b.id
     join public.supplier_price_publications pub on pub.id=p.publication_id and pub.organization_id=p.organization_id
      and pub.brand_id=p.brand_id and pub.supplier_id=p.supplier_id and pub.release_id=p.release_id and pub.status='published'
     join public.suppliers s on s.organization_id=p.organization_id and s.id=p.supplier_id and s.price_usage_enabled
     join public.supplier_price_release_rows r on r.release_id=p.release_id and r.normalized_code=input_code
     where b.organization_id=input_org and b.name='VAG' and r.row_status='accepted'
       and r.buy_price>0 and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
       and upper(regexp_replace(r.product_code,'[[:space:]]+','','g'))=input_code
     limit 101
    ) matched;
end $$;
revoke all on function catalog_vag_review_internal.published_article(uuid,text) from public,anon,authenticated;
grant execute on function catalog_vag_review_internal.published_article(uuid,text) to service_role;

create function public.start_catalog_vag_spareto_review(input_org uuid,input_actor uuid,input_key uuid,input_products jsonb)
returns jsonb language plpgsql security invoker set search_path=''
set statement_timeout='3s' set lock_timeout='250ms' as $$
declare
  j public.catalog_brand_jobs%rowtype;
  item jsonb;
  code text;
  url text;
  codes text[]:='{}';
  evidence jsonb:='[]';
  matches int;
  ean_count int;
  expected_ean text;
  config jsonb;
  requests jsonb:='[]';
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if not exists(select 1 from public.profiles where organization_id=input_org and id=input_actor and role='superadmin' and is_active)
    then raise exception 'Catalog administrator required'; end if;
  if not exists(select 1 from public.catalog_external_sources where organization_id=input_org
    and source_key='spareto_vag_exact_review_v1' and is_active and license_posture='internal_review_required'
    and robots_posture='allowed' and rate_limit_posture='bounded' and credential_boundary='none'
    and metadata->>'brand_engine_read_allowed'='true' and metadata->>'exact_product_review_only'='true'
    and metadata->'allowed_brands' ? 'VAG')
    then raise exception 'VAG_SPARETO_SOURCE_UNAVAILABLE'; end if;
  if input_key is null or jsonb_typeof(input_products) is distinct from 'array' then raise exception 'VAG_SPARETO_ITEM_INVALID'; end if;
  if jsonb_array_length(input_products) not between 1 and 3 then raise exception 'VAG_SPARETO_ITEM_INVALID'; end if;
  for item in select value from jsonb_array_elements(input_products) loop
    code:=item->>'code';
    url:=item->>'sourceUrl';
    if code is null or code !~ '^[A-Z0-9]{5,24}$' or code=any(codes) or url is null or length(url)>250
      or url !~ '^https://spareto[.]com/products/volkswagen-ag-[a-z0-9-]+/[a-z0-9-]+$'
      or upper(replace(regexp_replace(url,'^.*/',''),'-','')) is distinct from code then
      raise exception 'VAG_SPARETO_ITEM_INVALID';
    end if;
    codes:=array_append(codes,code);
    requests:=requests||jsonb_build_array(jsonb_build_object('code',code,'sourceUrl',url));
  end loop;
  select * into j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key;
  if j.id is not null then
    if j.manifest->>'adapter' is distinct from 'vag-spareto-exact-review.v1' or j.manifest->'requests' is distinct from requests
      then raise exception 'VAG_SPARETO_REQUEST_KEY_CONFLICT'; end if;
    return to_jsonb(j)-'lease_token';
  end if;
  for item in select value from jsonb_array_elements(requests) loop
    code:=item->>'code';
    select * into strict matches,ean_count,expected_ean
    from catalog_vag_review_internal.published_article(input_org,code);
    if matches=0 then raise exception 'VAG_SPARETO_NOT_IN_PUBLISHED_LIST: %',code; end if;
    if matches>100 or ean_count>1 then raise exception 'VAG_SPARETO_PRICE_IDENTITY_AMBIGUOUS: %',code; end if;
    evidence:=evidence||jsonb_build_array(item||jsonb_build_object('expectedEan',expected_ean));
  end loop;
  config:=jsonb_build_object('codes',to_jsonb(codes),'brand','VAG','adapter','vag-spareto-exact-review.v1',
    'source_key','spareto_vag_exact_review_v1','requests',requests,'products',evidence);
  insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items)
    values(input_org,input_actor,input_key,config,cardinality(codes)) on conflict(organization_id,idempotency_key) do nothing;
  select * into strict j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key;
  if j.manifest->>'adapter' is distinct from 'vag-spareto-exact-review.v1' or j.manifest->'requests' is distinct from requests
    then raise exception 'VAG_SPARETO_REQUEST_KEY_CONFLICT'; end if;
  insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)
    select j.id,input_org,(entry.ordinality-1)::int,entry.product from unnest(codes) with ordinality as entry(product,ordinality) on conflict do nothing;
  return to_jsonb(j)-'lease_token';
end $$;
revoke all on function public.start_catalog_vag_spareto_review(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.start_catalog_vag_spareto_review(uuid,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
