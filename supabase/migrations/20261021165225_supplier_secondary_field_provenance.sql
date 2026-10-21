set local lock_timeout='2s';
set local statement_timeout='30s';
-- Keep secondary provenance compatible with the existing future-file guards.
create or replace function supplier_price_ingestion_internal.apply_secondary_review_one(input_org uuid,input_actor uuid,input_id uuid,input_automatic boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare org uuid:=input_org;actor uuid:=input_actor;v_id uuid:=input_id;q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;p public.catalog_products%rowtype;
 item record;patch jsonb;outcomes jsonb;before_row jsonb;
begin
  select * into q from supplier_price_ingestion_internal.catalog_secondary_reviews where catalog_secondary_reviews.id=v_id and organization_id=org for update;
  if not found then raise exception 'SECONDARY_REVIEW_SCOPE_MISMATCH';end if;
  if q.status='applied' then return jsonb_build_object('id',v_id,'status','applied');end if;
  if q.status<>'reviewed' or not supplier_price_ingestion_internal.secondary_source_allowed(org,q.brand_id,true) then raise exception 'SECONDARY_REVIEW_NOT_READY';end if;
  -- Secondary source reads may proceed separately, but canonical writes share
  -- the primary scheduler's gate and never overlap an active primary turn.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-enrichment-consumer-v1',0))
   or exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and lease_until>clock_timestamp()) then
   return jsonb_build_object('id',v_id,'status','deferred','reason','PRIMARY_CATALOG_TURN_ACTIVE');
  end if;
  select * into p from public.catalog_products where catalog_products.id=q.product_id and organization_id=org and brand_id=q.brand_id for update;
  if not found or public.normalize_catalog_product_code(p.product_code)<>public.normalize_catalog_product_code(q.product_code) then raise exception 'SECONDARY_CATALOG_IDENTITY_CHANGED';end if;
  before_row:=to_jsonb(p);patch:='{}';outcomes:='{}';
  if nullif(btrim(p.ean),'') is not null and nullif(btrim(q.observation->'fields'->>'ean'),'') is not null
   and regexp_replace(p.ean,'\s','','g')<>regexp_replace(q.observation->'fields'->>'ean','\s','','g') then
   update supplier_price_ingestion_internal.catalog_secondary_reviews set status='held',application=jsonb_build_object('actor',actor,'reason','EAN_IDENTITY_CONFLICT','before',before_row),updated_at=now() where catalog_secondary_reviews.id=v_id;
   return jsonb_build_object('id',v_id,'status','held');
  end if;
  if coalesce(q.proposal->>'status','')<>'staged_candidate' then raise exception 'SECONDARY_IDENTITY_REVIEW_REQUIRED';end if;
  for item in select key,value from jsonb_each(q.proposal->'fields') loop
   if nullif(btrim(before_row->>item.key),'') is not null then outcomes:=outcomes||jsonb_build_object(item.key,'existing_value_preserved');
   elsif before_row->item.key is distinct from q.before_values->item.key then outcomes:=outcomes||jsonb_build_object(item.key,'changed_since_review');
   else patch:=patch||jsonb_build_object(item.key,item.value);outcomes:=outcomes||jsonb_build_object(item.key,'applied');end if;
  end loop;
  if patch<>'{}' then
   update public.catalog_products cp set
    description=case when patch?'description' then patch->>'description' else cp.description end,
    description_tr=case when patch?'description_tr' then patch->>'description_tr' else cp.description_tr end,
    oem_no=case when patch?'oem_no' then patch->>'oem_no' else cp.oem_no end,
    vehicle=case when patch?'vehicle' then patch->>'vehicle' else cp.vehicle end,
    vehicle_model=case when patch?'vehicle_model' then patch->>'vehicle_model' else cp.vehicle_model end,
    ean=case when patch?'ean' then patch->>'ean' else cp.ean end,
    market_segment=case when patch?'market_segment' then patch->>'market_segment' else cp.market_segment end,
    weight_kg=case when patch?'weight_kg' then (patch->>'weight_kg')::numeric else cp.weight_kg end,
    dimensions=case when patch?'dimensions' then patch->'dimensions' else cp.dimensions end,
    origin=case when patch?'origin' then patch->>'origin' else cp.origin end,
    hs_code=case when patch?'hs_code' then patch->>'hs_code' else cp.hs_code end,updated_at=now()
   where cp.id=p.id returning cp.* into p;
   select jsonb_object_agg(k,to_jsonb(p)->k) into patch from jsonb_object_keys(patch) k;
   for item in select key,value from jsonb_each(patch) loop
    insert into supplier_price_ingestion_internal.catalog_enrichment_fields(product_id,field,applied_value,source_date,job_id)
    values(p.id,item.key,item.value,(select source_date from supplier_price_ingestion_internal.catalog_enrichment_jobs where id=q.job_id),q.job_id)
    on conflict(product_id,field)do update set applied_value=excluded.applied_value,source_date=excluded.source_date,job_id=excluded.job_id;
   end loop;
  end if;
  insert into supplier_price_ingestion_internal.catalog_secondary_applications(review_id,organization_id,product_id,official_evidence,secondary_evidence,application)
  values(v_id,org,p.id,q.official_evidence,q.observation,jsonb_build_object('actor',actor,'automatic',input_automatic,'before',before_row,'patch',patch,'fields',outcomes,'sourceUrl',q.observation->>'sourceUrl','fingerprint',q.observation->>'fingerprint')) on conflict(review_id)do nothing;
  update supplier_price_ingestion_internal.catalog_secondary_reviews set status='applied',application=jsonb_build_object('actor',actor,'automatic',input_automatic,'before',before_row,'patch',patch,'fields',outcomes,'sourceUrl',q.observation->>'sourceUrl','fingerprint',q.observation->>'fingerprint'),updated_at=now() where catalog_secondary_reviews.id=v_id;
  return jsonb_build_object('id',v_id,'status','applied','fields',outcomes);
end$$;
create or replace function public.apply_supplier_catalog_secondary_approved(input_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='15s' as $$
declare q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;actor uuid;source_metadata jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SECONDARY_SERVICE_REQUIRED';end if;
 select candidate.* into q from supplier_price_ingestion_internal.catalog_secondary_reviews candidate
 join public.catalog_external_sources src on src.organization_id=candidate.organization_id and src.source_key='spareto_secondary_exact_v1'
 where candidate.status='reviewed' and (input_id is null or candidate.id=input_id)
  and src.metadata->'secondary_review_automatic_apply_allowed'='true'::jsonb
  and exists(select 1 from public.profiles approver where approver.organization_id=candidate.organization_id and approver.is_active and approver.role in ('admin','superadmin')
   and approver.id=case when coalesce(src.metadata->>'approval_actor','')~'^[a-f0-9-]{36}$' then (src.metadata->>'approval_actor')::uuid else null end)
  and not exists(select 1 from jsonb_object_keys(candidate.proposal->'fields') k where not(src.metadata->'automatic_fields' ? k))
  and supplier_price_ingestion_internal.secondary_source_allowed(candidate.organization_id,candidate.brand_id,true)
 order by candidate.updated_at,candidate.id limit 1 for update of candidate skip locked;
 if not found then return null;end if;
 select metadata into source_metadata from public.catalog_external_sources where organization_id=q.organization_id and source_key='spareto_secondary_exact_v1';
 if coalesce(source_metadata->>'approval_actor','')!~'^[a-f0-9-]{36}$' then raise exception 'SECONDARY_AUTOMATIC_APPROVAL_REQUIRED';end if;
 actor:=(source_metadata->>'approval_actor')::uuid;
 if not exists(select 1 from public.profiles where profiles.id=actor and organization_id=q.organization_id and is_active and role in ('admin','superadmin'))
  or coalesce(q.proposal->>'status','')<>'staged_candidate' then raise exception 'SECONDARY_AUTOMATIC_APPROVAL_REQUIRED';end if;
 if exists(select 1 from jsonb_object_keys(q.proposal->'fields') k where not(source_metadata->'automatic_fields' ? k)) then raise exception 'SECONDARY_AUTOMATIC_FIELD_NOT_APPROVED';end if;
 begin
  return supplier_price_ingestion_internal.apply_secondary_review_one(q.organization_id,actor,q.id,true);
 exception when lock_not_available or query_canceled or serialization_failure or deadlock_detected then
  return jsonb_build_object('id',q.id,'status','deferred','reason','SECONDARY_DATABASE_BUSY');
 when others then
  update supplier_price_ingestion_internal.catalog_secondary_reviews set status='held',error_code=case when sqlerrm~'^SECONDARY_[A-Z_]+$' then sqlerrm else 'SECONDARY_APPLICATION_REVIEW_REQUIRED' end,updated_at=now() where id=q.id;
  return jsonb_build_object('id',q.id,'status','held','reason','SECONDARY_APPLICATION_REVIEW_REQUIRED');
 end;
end$$;
