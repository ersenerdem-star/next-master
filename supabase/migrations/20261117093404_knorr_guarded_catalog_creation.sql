-- Only a sealed official Knorr observation may create a missing catalog row.
-- The unique catalog key arbitrates races with imports and manual edits.
create function public.apply_catalog_knorr_create_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='8s' as $$
declare j public.catalog_brand_jobs%rowtype; it public.catalog_brand_job_items%rowtype; src public.catalog_external_sources%rowtype;
 b uuid; p public.catalog_products%rowtype; obs jsonb; f jsonb; result_value jsonb; code text; source_code text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required';end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org and mode='publish' and status='running' and lease_token=input_token and lease_expires_at>now() for update;
 if j.id is null or j.next_index is distinct from input_index or j.manifest->>'brand' is distinct from 'Knorr-Bremse' or j.manifest->>'source_key' is distinct from 'knorr_bremse_aftermarket' then raise exception 'Knorr worker lease or scope invalid';end if;
 select result into result_value from public.catalog_brand_item_applications where job_id=input_job and item_index=input_index;
 if found then return result_value;end if;
 select * into src from public.catalog_external_sources where organization_id=input_org and source_key='knorr_bremse_aftermarket';
 if src.id is null or not src.is_active or src.license_posture not in('allowed','internal_review_required') or src.credential_boundary<>'none' or src.rate_limit_posture<>'bounded'
  or src.metadata->>'brand_engine_read_allowed' is distinct from 'true' or src.metadata->>'brand_engine_enrichment_allowed' is distinct from 'true'
  or (src.metadata->'allowed_brands' ? 'Knorr-Bremse') is distinct from true or nullif(src.metadata->>'approval_actor','') is null or nullif(src.metadata->>'publication_approval_reference','') is null then raise exception 'Knorr source authorization unavailable';end if;
 select * into it from public.catalog_brand_job_items where job_id=input_job and organization_id=input_org and item_index=input_index;
 obs:=it.observation;f:=obs->'fields';source_code:=upper(regexp_replace(it.product_code,'\s','','g'));code:=regexp_replace(source_code,'[^A-Z0-9]','','g');
 if source_code !~ '^[A-Z0-9][A-Z0-9.-]{0,99}$' or code !~ '^[A-Z0-9]{1,80}$' or obs->>'code' is distinct from source_code or obs->>'brand' is distinct from 'Knorr-Bremse'
  or obs->>'sourceKey' is distinct from 'knorr_bremse_aftermarket' or obs->'missingCatalogProduct' is distinct from 'true'::jsonb
  or (source_code<>code and (obs->'identity'->>'sourceCode' is distinct from source_code or obs->'identity'->>'canonicalCode' is distinct from code or obs->'identity'->>'status' is distinct from 'search_consistent' or coalesce(obs->'identity'->>'searchFingerprint','') !~ '^[a-f0-9]{64}$'))
  or obs->'before' is distinct from '{}'::jsonb or (obs->'lifecycle'->'evidence'->>'salesStatusCode') is null or (obs->'lifecycle'->'evidence'->>'salesStatusCode') not in ('CODE30','CODE40') or obs->>'sourceUrl' is distinct from 'https://mytruckservices.knorr-bremse.com/p/'||source_code
  or coalesce(obs->>'fingerprint','') !~ '^[a-f0-9]{64}$' or obs->>'unavailable' is not null or jsonb_typeof(f) is distinct from 'object'
  or jsonb_typeof(obs->'sourceFields') is distinct from 'object' or f is distinct from obs->'sourceFields'
  or exists(select 1 from jsonb_object_keys(f) k where k not in('description','ean','origin','hs_code','weight_kg','dimensions'))
  then raise exception 'Knorr sealed observation invalid';end if;
 if f ? 'description' and (jsonb_typeof(f->'description')<>'string' or length(f->>'description')>12000) then raise exception 'Knorr description invalid';end if;
 if f ? 'ean' and coalesce(f->>'ean','') !~ '^[0-9]{8,14}$' then raise exception 'Knorr EAN invalid';end if;
 if f ? 'origin' and coalesce(f->>'origin','') !~ '^[A-Z]{2}$' then raise exception 'Knorr origin invalid';end if;
 if f ? 'hs_code' and coalesce(f->>'hs_code','') !~ '^[0-9]{6,12}$' then raise exception 'Knorr tariff invalid';end if;
 if f ? 'weight_kg' and (jsonb_typeof(f->'weight_kg')<>'number' or (f->>'weight_kg')::numeric<=0 or (f->>'weight_kg')::numeric>100000) then raise exception 'Knorr weight invalid';end if;
 if f ? 'dimensions' and jsonb_typeof(f->'dimensions')<>'object' then raise exception 'Knorr dimensions invalid';end if;
 select id into b from public.brands where organization_id=input_org and name='Knorr-Bremse';if b is null then raise exception 'Knorr brand unavailable';end if;
 insert into public.catalog_products(organization_id,brand_id,product_code,description,ean,origin,hs_code,weight_kg,dimensions)
 values(input_org,b,code,f->>'description',f->>'ean',f->>'origin',f->>'hs_code',nullif(f->>'weight_kg','')::numeric,f->'dimensions')
 on conflict(organization_id,brand_id,normalized_code) do nothing returning * into p;
 if p.id is null then
  result_value:=jsonb_build_object('status','held','reason','CATALOG_IDENTITY_CREATED_CONCURRENTLY');
 else
  insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
  values(input_org,p.id,src.source_key,obs->>'sourceUrl',source_code,'knorr-official-v1',obs->>'fingerprint') on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
  result_value:=jsonb_build_object('status','created','catalog_product_id',p.id,'sourceUrl',obs->>'sourceUrl');
 end if;
 insert into public.catalog_brand_item_applications(job_id,item_index,organization_id,catalog_product_id,result) values(input_job,input_index,input_org,p.id,result_value);
 return result_value;
end$$;
revoke all on function public.apply_catalog_knorr_create_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_knorr_create_item(uuid,uuid,uuid,integer) to service_role;
