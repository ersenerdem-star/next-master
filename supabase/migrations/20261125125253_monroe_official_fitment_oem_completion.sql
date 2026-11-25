-- Authorize only missing OEM and vehicle fields from registered Monroe evidence.
update public.catalog_external_sources
set metadata=metadata||'{"monroe_background_fitment_only":true}'::jsonb
where organization_id='1e4c5e99-e387-41aa-a6d3-cbe74558f766' and source_key='tecalliance_monroe';

create or replace function public.apply_catalog_monroe_job_item(
  input_org uuid, input_job uuid, input_token uuid, input_index integer
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare
  observation jsonb;
  automatic_image_only boolean;
  fitment_only boolean;
  result_value jsonb;
  product public.catalog_products%rowtype;
  image_candidate text;
  outcome text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select i.observation, coalesce(j.manifest->>'monroe_policy'='monroe-image-fill.v1',false) , coalesce(j.manifest->>'monroe_policy'='monroe-fitment-fill.v1',false) into observation, automatic_image_only, fitment_only
  from public.catalog_brand_jobs j
  join public.catalog_brand_job_items i on i.job_id=j.id and i.organization_id=j.organization_id
  where j.id=input_job and j.organization_id=input_org and j.next_index=input_index
    and j.mode='publish' and j.status='running' and j.lease_token=input_token and j.lease_expires_at>now()
    and j.manifest->>'brand'='Monroe' and j.manifest->>'source_key'='tecalliance_monroe'
    and i.item_index=input_index
  for update of j;
  if not found or observation is null then raise exception 'Monroe review scope mismatch'; end if;
  if fitment_only then
    if jsonb_typeof(observation->'fields') is distinct from 'object'
      or (observation->'fields') - array['oem_no','vehicle','vehicle_model'] <> '{}'::jsonb
      or exists (
        select 1 from jsonb_object_keys(observation->'fields') k(field)
        where nullif(trim(observation->'before'->>k.field),'') is not null
      )
      or ((observation->'fields') ?| array['vehicle','vehicle_model']
        and (observation->'fitmentEvidence'->>'status' is distinct from 'verified'
          or coalesce(observation->'fitmentEvidence'->>'fingerprint','') !~ '^[a-f0-9]{64}$'))
      or not exists (
        select 1 from public.catalog_external_sources s
        where s.organization_id=input_org and s.source_key='tecalliance_monroe'
          and s.is_active and s.metadata->>'monroe_background_fitment_only'='true'
      )
      then raise exception 'Monroe automatic fitment scope unavailable'; end if;
    return public.apply_catalog_brand_job_item(input_org,input_job,input_token,input_index);
  end if;

  if jsonb_typeof(observation->'fields') is distinct from 'object'
     or (observation->'fields') - 'weight_kg'::text <> '{}'::jsonb then
    raise exception 'Monroe write field outside scope';
  end if;

  if automatic_image_only and (
    observation->'fields' <> '{}'::jsonb or not exists (
      select 1 from public.catalog_external_sources s
      where s.organization_id=input_org and s.source_key='tecalliance_monroe'
        and s.is_active and s.metadata->>'monroe_background_image_only'='true'
    )
  ) then raise exception 'Monroe automatic image-only scope unavailable'; end if;

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

create function public.admit_catalog_monroe_fitment_application()
returns jsonb language plpgsql security invoker set search_path=''
set statement_timeout='3s' set lock_timeout='250ms' as $$
declare
  chosen public.catalog_brand_jobs%rowtype;
  scheduled jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select j.* into chosen
  from public.catalog_brand_jobs j
  join public.catalog_external_sources s
    on s.organization_id=j.organization_id and s.source_key='tecalliance_monroe'
  where j.status='reviewed' and j.mode='stage' and j.next_index=j.total_items
    and j.total_items between 1 and 20
    and j.manifest->>'adapter'='brand-exact.v1'
    and j.manifest->>'brand'='Monroe' and j.manifest->>'source_key'=s.source_key
    and j.manifest->>'monroe_policy'='monroe-fitment-fill.v1'
    and s.is_active and s.license_posture in ('allowed','internal_review_required')
    and s.credential_boundary='none' and s.rate_limit_posture='bounded'
    and s.metadata->'allowed_brands' ? 'Monroe'
    and s.metadata->>'brand_engine_enrichment_allowed'='true'
    and s.metadata->>'monroe_background_fitment_only'='true'
    and exists (
      select 1 from public.profiles p where p.id=j.created_by and p.organization_id=j.organization_id
        and p.role='superadmin' and p.is_active
    )
    and (select count(*) from public.catalog_brand_job_items i where i.job_id=j.id)=j.total_items
    and not exists (
      select 1 from public.catalog_brand_job_items i where i.job_id=j.id
        and (i.state<>'reviewed' or i.observation->>'brand' is distinct from 'Monroe'
          or i.observation->>'sourceKey' is distinct from s.source_key
          or jsonb_typeof(i.observation->'fields') is distinct from 'object'
          or (i.observation->'fields') - array['oem_no','vehicle','vehicle_model'] <> '{}'::jsonb)
    )
    and exists (
      select 1 from public.catalog_brand_job_items i where i.job_id=j.id
        and i.observation->'fields' <> '{}'::jsonb
        and not coalesce(i.observation->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb,false)
    )
  order by j.created_at,j.id limit 1 for update of j skip locked;
  if not found then return null; end if;
  scheduled := public.schedule_catalog_brand_job(chosen.organization_id,chosen.id,true);
  return jsonb_build_object('id',chosen.id,'organization_id',chosen.organization_id,'status',scheduled->>'status');
end $$;

revoke all on function public.admit_catalog_monroe_fitment_application() from public,anon,authenticated;
grant execute on function public.admit_catalog_monroe_fitment_application() to service_role;
notify pgrst,'reload schema';
