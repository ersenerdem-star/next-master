insert into public.catalog_external_sources (
  organization_id, source_key, display_name, source_owner, source_type, base_url,
  license_posture, robots_posture, rate_limit_posture, credential_boundary, is_active, metadata
)
select distinct
  b.organization_id, 'tecalliance_monroe', 'Monroe · TecAlliance eCatalogue', 'Monroe / DRiV',
  'manufacturer', 'https://web.tecalliance.net/tae/en/home',
  'internal_review_required', 'allowed', 'bounded', 'none', true,
  jsonb_build_object(
    'allowed_brands', jsonb_build_array('Monroe'),
    'allowed_evidence_hosts', jsonb_build_array('web.tecalliance.net'),
    'brand_engine_read_allowed', true,
    'brand_engine_enrichment_allowed', true,
    'secondary_spareto_read_allowed', true,
    'secondary_product_urls', jsonb_build_object(
      '10024', 'https://spareto.com/products/monroe-shock-absorber/10024',
      '10026', 'https://spareto.com/products/monroe-shock-absorber/10026',
      '10027', 'https://spareto.com/products/monroe-shock-absorber/10027',
      '10049', 'https://spareto.com/products/monroe-shock-absorber/10049',
      '10050', 'https://spareto.com/products/monroe-shock-absorber/10050',
      'MK049', 'https://spareto.com/products/monroe-top-strut-mounting/mk049',
      'PK056', 'https://spareto.com/products/monroe-dust-cover-kit-shock-absorber/pk056'
    ),
    'approval_actor', 'Next-Master Product Decision Owner',
    'publication_approval_reference', 'user-monroe-tecalliance-missing-weight-image-2026-11-25',
    'automatic_apply', false
  )
from public.brands b
where b.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid and b.name = 'Monroe'
on conflict (organization_id, source_key) do nothing;

-- Keep image publication on the same reviewed lease and application receipt as weight.
create function public.apply_catalog_monroe_job_item(
  input_org uuid, input_job uuid, input_token uuid, input_index integer
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare
  observation jsonb;
  result_value jsonb;
  product public.catalog_products%rowtype;
  image_candidate text;
  outcome text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select i.observation into observation
  from public.catalog_brand_jobs j
  join public.catalog_brand_job_items i on i.job_id=j.id and i.organization_id=j.organization_id
  where j.id=input_job and j.organization_id=input_org and j.next_index=input_index
    and j.mode='publish' and j.status='running' and j.lease_token=input_token and j.lease_expires_at>now()
    and j.manifest->>'brand'='Monroe' and j.manifest->>'source_key'='tecalliance_monroe'
    and i.item_index=input_index
  for update of j;
  if not found or observation is null then raise exception 'Monroe review scope mismatch'; end if;
  if jsonb_typeof(observation->'fields') is distinct from 'object'
     or (observation->'fields') - 'weight_kg'::text <> '{}'::jsonb then
    raise exception 'Monroe write field outside scope';
  end if;

  result_value := public.apply_catalog_brand_job_item(input_org,input_job,input_token,input_index);
  if result_value->>'status' <> 'completed' or result_value->'fields' ? 'image_url' then return result_value; end if;

  select p.* into strict product
  from public.catalog_products p
  join public.catalog_brand_item_applications a on a.catalog_product_id=p.id and a.organization_id=p.organization_id
  where a.job_id=input_job and a.item_index=input_index and a.organization_id=input_org
  for update of p;
  image_candidate := observation->>'imageCandidate';
  outcome := case
    when image_candidate is null then 'source_missing'
    when image_candidate !~ '^https://digital-assets\.tecalliance\.services/images/(200|400|800|1600)/[a-f0-9]{40}\.(jpg|jpeg|png|webp)$'
      then 'invalid_source_image'
    when nullif(trim(product.ean),'') is not null and nullif(trim(observation->'sourceFields'->>'ean'),'') is not null
      and regexp_replace(product.ean,'\s','','g') <> regexp_replace(observation->'sourceFields'->>'ean','\s','','g')
      then 'ean_identity_conflict'
    when to_jsonb(product)->'image_url' is distinct from observation->'before'->'image_url' then 'changed_since_review'
    when nullif(trim(product.image_url),'') is not null then 'existing_value_preserved'
    else 'applied'
  end;
  if outcome='applied' then
    update public.catalog_products set image_url=image_candidate, updated_at=now() where id=product.id;
    result_value := jsonb_set(result_value, '{changes,image_url}', to_jsonb(image_candidate));
  end if;
  result_value := jsonb_set(result_value, '{fields,image_url}', to_jsonb(outcome));
  update public.catalog_brand_item_applications set result=result_value
    where job_id=input_job and item_index=input_index and organization_id=input_org;
  return result_value;
end $$;

revoke all on function public.apply_catalog_monroe_job_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_monroe_job_item(uuid,uuid,uuid,integer) to service_role;
notify pgrst,'reload schema';
