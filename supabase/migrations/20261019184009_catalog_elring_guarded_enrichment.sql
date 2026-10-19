-- Elring packages enrich only a sealed, fully published provider-stage run.
-- Raw images and extra criteria remain immutable evidence for controlled review.
create or replace function public.enrich_elring_provider_stage_batch(
  input_run_id uuid, input_brand_id uuid, input_offset integer default 0,
  input_batch_size integer default 25
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
set statement_timeout = '30s'
as $function$
declare
  r public.catalog_import_runs%rowtype;
  s public.catalog_external_sources%rowtype;
  staged record;
  p public.catalog_products%rowtype;
  fields jsonb;
  incoming jsonb;
  result jsonb;
  field text;
  current_value text;
  incoming_value text;
  processed integer := 0;
  conflicts integer := 0;
  segment_applied integer := 0;
  results jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service role required'; end if;
  if input_offset is null or input_offset < 0 or input_batch_size is null or input_batch_size not between 1 and 25 then
    raise exception 'Invalid package batch';
  end if;
  select * into r from public.catalog_import_runs where id = input_run_id;
  if r.id is null or r.input_scope->>'source_key' is distinct from 'tecalliance_elring'
    or lower(r.input_scope->>'brand_name') is distinct from 'elring' then raise exception 'Invalid Elring run'; end if;
  select * into s from public.catalog_external_sources where organization_id = r.organization_id and source_key = 'tecalliance_elring';
  if s.id is null or s.is_active is not true or s.license_posture <> 'allowed'
    or s.credential_boundary is distinct from 'none' or s.rate_limit_posture <> 'bounded'
    or s.metadata->>'internal_catalog_persistence_allowed' is distinct from 'true'
    or nullif(s.metadata->>'approval_actor', '') is null
    or nullif(s.metadata->>'publication_approval_reference', '') is null then raise exception 'Elring publication authorization missing'; end if;
  if not exists(select 1 from public.brands where id = input_brand_id and organization_id = r.organization_id and lower(name) = 'elring') then
    raise exception 'Elring brand scope mismatch';
  end if;
  if not exists(select 1 from public.catalog_provider_stage_publications where run_id = r.id and brand_id = input_brand_id
    and source_id = s.id and approval_actor = s.metadata->>'approval_actor'
    and approval_reference = s.metadata->>'publication_approval_reference' and status = 'completed') then
    raise exception 'Elring package publication must complete first';
  end if;
  for staged in select * from public.catalog_import_stage where run_id = r.id and organization_id = r.organization_id
    order by row_index limit input_batch_size offset input_offset
  loop
    fields := staged.source_payload->'fields';
    if jsonb_typeof(fields) is distinct from 'object' then raise exception 'Elring field evidence missing'; end if;
    select * into p from public.catalog_products where organization_id = r.organization_id and brand_id = input_brand_id
      and normalized_code = staged.normalized_code for update;
    if p.id is null then raise exception 'Published Elring product missing'; end if;
    incoming := jsonb_build_object('organization_id', r.organization_id, 'brand_id', input_brand_id,
      'product_code', p.product_code, 'source_reference', staged.source_url)
      || (fields - 'product_code' - 'image_url' - 'market_segment' - 'description_tr');
    -- The legacy scalar guard overwrites OEM/vehicle. Lock and strip populated
    -- values here; report conflicts instead. Images never enter that guard.
    foreach field in array array['oem_no','vehicle','market_segment'] loop
      current_value := nullif(trim(to_jsonb(p)->>field), '');
      incoming_value := nullif(trim(fields->>field), '');
      if current_value is not null then
        incoming := incoming - field;
        if incoming_value is not null and current_value <> incoming_value then
          insert into public.product_attribute_conflicts(organization_id,product_id,brand_id,product_code,field_name,
            existing_value,incoming_value,normalized_incoming_value,source_type,source_reference)
          values(r.organization_id,p.id,input_brand_id,p.product_code,field,current_value,incoming_value,
            public.normalize_product_conflict_value(field,incoming_value),'tecalliance_elring',staged.source_url)
          on conflict (organization_id,product_id,field_name,normalized_incoming_value) where status = 'pending_review'
          do update set last_detected_at = now(), detection_count = public.product_attribute_conflicts.detection_count + 1;
          conflicts := conflicts + 1;
        end if;
      end if;
    end loop;
    -- Explicit allowlist excludes lifecycle, replacement and price fields even
    -- if a malformed observation includes extra keys.
    select coalesce(jsonb_object_agg(key,value), '{}'::jsonb) into incoming from jsonb_each(incoming)
      where key = any(array['organization_id','brand_id','product_code','source_reference','description','weight_kg',
        'hs_code','origin','ean','oem_no','vehicle','vehicle_model','dimensions']);
    result := public.apply_catalog_provider_enrichment_protocol(jsonb_build_array(incoming),'tecalliance_elring',staged.source_url);
    results := results || jsonb_build_array(result);
    if nullif(trim(p.market_segment),'') is null and nullif(trim(fields->>'market_segment'),'') is not null then
      update public.catalog_products set market_segment = public.normalize_catalog_market_segment(fields->>'market_segment'), updated_at = now()
      where id = p.id and nullif(trim(market_segment),'') is null;
      if found then segment_applied := segment_applied + 1; end if;
    end if;
    processed := processed + 1;
  end loop;
  return jsonb_build_object('processed',processed,'next_offset',input_offset+processed,'results',results,
    'additional_conflict_count',conflicts,'market_segment_applied',segment_applied,'image_policy','review_required');
end;
$function$;
revoke all on function public.enrich_elring_provider_stage_batch(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.enrich_elring_provider_stage_batch(uuid,uuid,integer,integer) to service_role;
select pg_notify('pgrst','reload schema');
