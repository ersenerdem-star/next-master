create function public.apply_catalog_knorr_canonical_existing_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare j public.catalog_brand_jobs%rowtype; it public.catalog_brand_job_items%rowtype; p public.catalog_products%rowtype;
 src public.catalog_external_sources%rowtype; obs jsonb; vals jsonb; before_values jsonb;
 outcomes jsonb:='{}'; changes jsonb:='{}'; result_value jsonb; prior jsonb; field text; value jsonb; live jsonb;
 brand_value uuid; n integer; host text; ean_conflict boolean; assignments text[]:=array[]::text[];
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required';end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org and mode='publish' and status='running' and lease_token=input_token and lease_expires_at>now() for update;
 if j.id is null or j.next_index is distinct from input_index then raise exception 'Brand worker lease or cursor lost';end if;
 select result into prior from public.catalog_brand_item_applications where job_id=j.id and item_index=input_index;if found then return prior;end if;
 select * into src from public.catalog_external_sources where organization_id=input_org and source_key=j.manifest->>'source_key';
 if src.id is null or not src.is_active or src.license_posture not in ('allowed','internal_review_required') or src.credential_boundary is distinct from 'none'
 or src.rate_limit_posture<>'bounded' or src.metadata->>'brand_engine_read_allowed' is distinct from 'true' or src.metadata->>'brand_engine_enrichment_allowed' is distinct from 'true'
 or not(src.metadata->'allowed_brands' ? (j.manifest->>'brand')) or nullif(src.metadata->>'approval_actor','') is null or nullif(src.metadata->>'publication_approval_reference','') is null then raise exception 'Brand source authorization unavailable';end if;
 select * into it from public.catalog_brand_job_items where job_id=j.id and organization_id=input_org and item_index=input_index;
 obs:=it.observation;vals:=obs->'fields';before_values:=obs->'before';
 if obs->>'unavailable' is not null then result_value:=jsonb_build_object('status','source_unavailable','reason',obs->>'unavailable');
 else
 host:=(regexp_match(obs->>'sourceUrl','^https://([a-zA-Z0-9.-]+)(?:/|$)'))[1];
 if obs is null or obs->>'brand' is distinct from j.manifest->>'brand' or obs->>'sourceKey' is distinct from j.manifest->>'source_key'
 or upper(regexp_replace(obs->>'code','\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
 or host is null or not(src.metadata->'allowed_evidence_hosts' ? lower(host)) then raise exception 'Brand exact source identity mismatch';end if;
 if j.manifest->>'brand' is distinct from 'Knorr-Bremse' or j.manifest->>'source_key' is distinct from 'knorr_bremse_aftermarket'
 or it.product_code !~ '^[A-Z0-9][A-Z0-9.-]*$' or obs->'identity'->>'status' is distinct from 'search_consistent'
 or obs->'identity'->>'sourceCode' is distinct from it.product_code
 or obs->'identity'->>'canonicalCode' is distinct from regexp_replace(it.product_code,'[^A-Z0-9]','','g')
 or coalesce(obs->'identity'->>'searchFingerprint','') !~ '^[a-f0-9]{64}$'
 or obs->>'sourceUrl' is distinct from 'https://mytruckservices.knorr-bremse.com/p/'||it.product_code
 or coalesce(obs->>'fingerprint','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(vals) is distinct from 'object'
 or jsonb_typeof(obs->'sourceFields') is distinct from 'object'
 or exists(select 1 from jsonb_each(vals) v where v.key not in ('description','ean','origin','hs_code','weight_kg','dimensions') or v.value is distinct from obs->'sourceFields'->v.key)
 then raise exception 'Knorr canonical observation invalid';end if;
 select id into brand_value from public.brands where organization_id=input_org and name=j.manifest->>'brand';
 select count(*) into n from public.catalog_products where organization_id=input_org and brand_id=brand_value and normalized_code=public.normalize_part_code(it.product_code);
 if n<>1 then raise exception 'Brand catalog identity missing or ambiguous';end if;
 select * into p from public.catalog_products where organization_id=input_org and brand_id=brand_value and normalized_code=public.normalize_part_code(it.product_code) for update;
 if before_values->>'id' is distinct from p.id::text or public.normalize_part_code(p.product_code) is distinct from public.normalize_part_code(it.product_code) then raise exception 'Brand catalog identity changed';end if;
 if exists(select 1 from public.catalog_product_source_records r where r.organization_id=input_org and r.catalog_product_id=p.id and r.source_key='knorr_bremse_aftermarket' and (r.source_product_id is distinct from it.product_code or coalesce(r.payload_fingerprint,'') !~ '^[a-f0-9]{64}$')) then
  return jsonb_build_object('status','held','reason','KNORR_RECORDED_SOURCE_COLLISION');end if;
 ean_conflict:=nullif(trim(p.ean),'') is not null and nullif(trim(coalesce(obs->'sourceFields'->>'ean',vals->>'ean')),'') is not null
  and regexp_replace(p.ean,'\s','','g')<>regexp_replace(coalesce(obs->'sourceFields'->>'ean',vals->>'ean'),'\s','','g');
 if ean_conflict then return jsonb_build_object('status','held','reason','EAN_IDENTITY_CONFLICT');end if;
 foreach field in array array['description','description_tr','ean','weight_kg','origin','hs_code','oem_no','vehicle','vehicle_model','market_segment','dimensions'] loop
 value:=vals->field;live:=to_jsonb(p)->field;
 if value is null or value in ('null'::jsonb,'""'::jsonb) then outcomes:=outcomes||jsonb_build_object(field,'source_missing');continue;end if;
 if ean_conflict then outcomes:=outcomes||jsonb_build_object(field,'ean_identity_conflict');continue;end if;
 if live is distinct from before_values->field then outcomes:=outcomes||jsonb_build_object(field,'changed_since_review');continue;end if;
 if live=value then outcomes:=outcomes||jsonb_build_object(field,'unchanged');continue;end if;
 if live is not null and live not in ('null'::jsonb,'""'::jsonb) and field not in ('oem_no','vehicle','vehicle_model') then outcomes:=outcomes||jsonb_build_object(field,'existing_value_preserved');continue;end if;
 if field='weight_kg' and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<=0 or (value#>>'{}')::numeric>100000) then raise exception 'Invalid official weight';end if;
 if field not in ('weight_kg','dimensions') and (jsonb_typeof(value)<>'string' or length(value#>>'{}')>12000) then raise exception 'Invalid official text field';end if;
 if field='dimensions' and jsonb_typeof(value)<>'object' then raise exception 'Invalid official dimensions';end if;
 if field='origin' and value#>>'{}' !~ '^[A-Z]{2}$' then raise exception 'Invalid official origin';end if;
 if field='hs_code' and value#>>'{}' !~ '^\d[\d.\s-]{1,30}\d$' then raise exception 'Invalid official tariff';end if;
 if field='ean' and value#>>'{}' !~ '^[0-9]{8,14}$' then raise exception 'Invalid official EAN';end if;
 changes:=changes||jsonb_build_object(field,value);outcomes:=outcomes||jsonb_build_object(field,'applied');
 end loop;
 for field,value in select key,v.value from jsonb_each(changes)v loop
 if field='weight_kg' then assignments:=array_append(assignments,format('%I=($1->>%L)::numeric',field,field));
 elsif field='dimensions' then assignments:=array_append(assignments,'dimensions=$1->''dimensions''');
 else assignments:=array_append(assignments,format('%I=$1->>%L',field,field));end if;
 end loop;
 if cardinality(assignments)>0 then execute 'update public.catalog_products set '||array_to_string(assignments,',')||',updated_at=now() where id=$2' using changes,p.id;end if;
 insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
 values(input_org,p.id,src.source_key,obs->>'sourceUrl',it.product_code,'knorr-official-v1',obs->>'fingerprint') on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
 result_value:=jsonb_build_object('status','completed','fields',outcomes,'changes',changes,'before',before_values,'sourceUrl',obs->>'sourceUrl','source_fingerprint',obs->>'fingerprint');
 end if;
 insert into public.catalog_brand_item_applications(job_id,item_index,organization_id,catalog_product_id,result)values(j.id,input_index,input_org,p.id,result_value);
 return result_value;
end$$;
revoke all on function public.apply_catalog_knorr_canonical_existing_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_knorr_canonical_existing_item(uuid,uuid,uuid,integer) to service_role;

create or replace function public.apply_catalog_knorr_owned_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare product_id uuid; source_code text; existing_code text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'KNORR_SERVICE_REQUIRED';end if;
 select (i.observation->'before'->>'id')::uuid,upper(regexp_replace(i.product_code,'\s','','g')) into product_id,source_code
 from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id and i.organization_id=j.organization_id and i.item_index=input_index
 where j.id=input_job and j.organization_id=input_org and j.status='running' and j.mode='publish' and j.lease_token=input_token and j.lease_expires_at>now() and j.next_index=input_index and j.manifest->>'brand'='Knorr-Bremse' and j.manifest->>'source_key'='knorr_bremse_aftermarket';
 if not found or product_id is null then raise exception 'KNORR_CATALOG_IDENTITY_INVALID';end if;
 select p.product_code into existing_code from public.catalog_products p where p.id=product_id and p.organization_id=input_org for update;
 if not found then return jsonb_build_object('status','held','reason','CATALOG_IDENTITY_CHANGED');end if;
 if exists(select 1 from public.catalog_product_source_records r where r.organization_id=input_org and r.catalog_product_id=product_id and r.source_key='knorr_bremse_aftermarket' and (r.source_product_id is distinct from source_code or coalesce(r.payload_fingerprint,'') !~ '^[a-f0-9]{64}$')) then return jsonb_build_object('status','held','reason','KNORR_RECORDED_SOURCE_COLLISION');end if;
 if upper(regexp_replace(existing_code,'\s','','g'))=source_code then return public.apply_catalog_brand_job_item(input_org,input_job,input_token,input_index);end if;
 return public.apply_catalog_knorr_canonical_existing_item(input_org,input_job,input_token,input_index);
end$$;
