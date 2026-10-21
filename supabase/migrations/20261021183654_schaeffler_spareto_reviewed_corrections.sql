set local lock_timeout='2s';
set local statement_timeout='30s';

-- Explicit owner-reviewed correction, separate from official/missing-only jobs.
-- Reuse the existing durable brand manifests, leases, items and applications.
create function supplier_price_ingestion_internal.spareto_correction_job(input_org uuid,input_job uuid,input_token uuid)
returns public.catalog_brand_jobs language plpgsql security invoker set search_path='' as $$
declare j public.catalog_brand_jobs%rowtype;s public.catalog_external_sources%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CORRECTION_SERVICE_REQUIRED';end if;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and id=input_job and mode='publish' and status='running'
  and lease_token=input_token and lease_expires_at>clock_timestamp() for update;
 if j.id is null or j.manifest->>'adapter' is distinct from 'spareto-reviewed-correction.v1' or j.manifest->>'source_key' is distinct from 'spareto_schaeffler_correction_v1'
  or coalesce(j.manifest->>'brand','') not in ('INA','FAG','LUK')
  or j.manifest->'approved_fields' is distinct from '["description","oem_no","market_segment","image_url"]'::jsonb
  or not exists(select 1 from public.brands where organization_id=input_org and id=(j.manifest->>'brand_id')::uuid and name=j.manifest->>'brand') then raise exception 'CORRECTION_LEASE_OR_MANIFEST_INVALID';end if;
 select * into s from public.catalog_external_sources where organization_id=input_org and source_key='spareto_schaeffler_correction_v1';
 if s.id is null or not s.is_active or s.license_posture not in ('allowed','internal_review_required') or s.credential_boundary<>'none' or s.rate_limit_posture<>'bounded'
  or s.metadata->'allowed_brands' ? (j.manifest->>'brand') is not true or s.metadata->'correction_read_allowed' is distinct from 'true'::jsonb
  or s.metadata->'correction_apply_allowed' is distinct from 'true'::jsonb
  or s.metadata->>'approval_actor' is distinct from j.created_by::text
  or s.metadata->>'publication_approval_reference' is distinct from j.manifest->>'approval_reference'
  or nullif(s.metadata->>'approval_expires_at','') is null or (s.metadata->>'approval_expires_at')::timestamptz<=clock_timestamp()
  or not exists(select 1 from public.profiles where id=j.created_by and organization_id=input_org and is_active and role='superadmin')
  or exists(select 1 from jsonb_array_elements_text(j.manifest->'approved_fields') k where k not in ('description','oem_no','market_segment','image_url') or not(s.metadata->'approved_fields' ? k))
 then raise exception 'CORRECTION_SOURCE_APPROVAL_REQUIRED';end if;
 return j;
end$$;
revoke all on function supplier_price_ingestion_internal.spareto_correction_job(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.start_catalog_spareto_correction(input_org uuid,input_actor uuid,input_brand text,input_codes jsonb,input_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.catalog_external_sources%rowtype;j public.catalog_brand_jobs%rowtype;b uuid;config jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CORRECTION_SERVICE_REQUIRED';end if;
 select * into s from public.catalog_external_sources where organization_id=input_org and source_key='spareto_schaeffler_correction_v1';
 if input_brand not in ('INA','FAG','LUK') or s.id is null or not s.is_active or s.license_posture not in ('allowed','internal_review_required') or s.credential_boundary<>'none' or s.rate_limit_posture<>'bounded' or s.metadata->'correction_read_allowed' is distinct from 'true'::jsonb
  or s.metadata->'correction_apply_allowed' is distinct from 'true'::jsonb or s.metadata->'allowed_brands' ? input_brand is not true
  or s.metadata->>'approval_actor' is distinct from input_actor::text or nullif(s.metadata->>'publication_approval_reference','') is null
  or nullif(s.metadata->>'approval_expires_at','') is null or (s.metadata->>'approval_expires_at')::timestamptz<=clock_timestamp()
  or not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and is_active and role='superadmin') then raise exception 'CORRECTION_SOURCE_APPROVAL_REQUIRED';end if;
 if jsonb_typeof(input_codes) is distinct from 'array' or jsonb_array_length(input_codes) not between 1 and 100 or input_key is null
  or exists(select 1 from jsonb_array_elements(input_codes) c where jsonb_typeof(c)<>'string' or c#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,99}$')
  or (select count(distinct public.normalize_catalog_product_code(value)) from jsonb_array_elements_text(input_codes))<>jsonb_array_length(input_codes) then raise exception 'CORRECTION_CODES_INVALID';end if;
 select id into b from public.brands where organization_id=input_org and name=input_brand;
 if b is null or exists(select 1 from jsonb_array_elements_text(input_codes) v where not exists(select 1 from public.catalog_products p where p.organization_id=input_org and p.brand_id=b and p.normalized_code=public.normalize_part_code(v) and public.normalize_catalog_product_code(p.product_code)=public.normalize_catalog_product_code(v))) then raise exception 'CORRECTION_EXISTING_PRODUCT_REQUIRED';end if;
 config:=jsonb_build_object('codes',input_codes,'brand',input_brand,'brand_id',b,'source_key',s.source_key,'adapter','spareto-reviewed-correction.v1',
  'approval_reference',s.metadata->>'publication_approval_reference','approved_fields',jsonb_build_array('description','oem_no','market_segment','image_url'));
 insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items,mode)
 values(input_org,input_actor,input_key,config,jsonb_array_length(input_codes),'publish') on conflict(organization_id,idempotency_key)do nothing;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest<>config then raise exception 'CORRECTION_IDEMPOTENCY_CONFLICT';end if;
 insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)
 select j.id,input_org,(ordinality-1)::integer,value from jsonb_array_elements_text(input_codes)with ordinality on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end$$;

create function public.reserve_catalog_spareto_correction(input_org uuid,input_job uuid,input_token uuid)
returns boolean language plpgsql security definer set search_path='' set lock_timeout='250ms' as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 j:=supplier_price_ingestion_internal.spareto_correction_job(input_org,input_job,input_token);
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-secondary-consumer-v1',0))
  or exists(select 1 from supplier_price_ingestion_internal.catalog_secondary_reviews where status='running' and lease_until>clock_timestamp())
  or exists(select 1 from public.catalog_brand_jobs where id<>j.id and status='running' and lease_expires_at>clock_timestamp()
   and manifest->>'adapter'='spareto-reviewed-correction.v1') then return false;end if;
 return true;
end$$;

create function supplier_price_ingestion_internal.merge_correction_oems(input_old text,input_new text)
returns text language sql immutable security invoker set search_path='' as $$
 with parts as (select btrim(v) v,ord from regexp_split_to_table(coalesce(input_old,'')||';'||coalesce(input_new,''),'[,;|\r\n]+')with ordinality as x(v,ord)),
 numbered as (select v,ord,row_number() over(partition by upper(regexp_replace(v,'[[:space:]]','','g')) order by ord) n from parts where v<>'')
 select string_agg(v,'; ' order by ord) from numbered where n=1;
$$;
revoke all on function supplier_price_ingestion_internal.merge_correction_oems(text,text) from public,anon,authenticated,service_role;

create function public.apply_catalog_spareto_correction_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='250ms' set statement_timeout='4s' as $$
declare j public.catalog_brand_jobs%rowtype;it public.catalog_brand_job_items%rowtype;p public.catalog_products%rowtype;
 obs jsonb;prior jsonb;before_values jsonb;changes jsonb:='{}';outcomes jsonb:='{}';result_value jsonb;proposal jsonb;field text;v jsonb;sid uuid;source_ean text;
begin
 j:=supplier_price_ingestion_internal.spareto_correction_job(input_org,input_job,input_token);
 if j.next_index is distinct from input_index then raise exception 'CORRECTION_CURSOR_CHANGED';end if;
 select result into prior from public.catalog_brand_item_applications where job_id=j.id and item_index=input_index;if found then return prior;end if;
 select * into it from public.catalog_brand_job_items where job_id=j.id and organization_id=input_org and item_index=input_index for update;
 obs:=it.observation;if obs is null then raise exception 'CORRECTION_SEALED_RECEIPT_REQUIRED';end if;
 if obs->>'unavailable' is not null then result_value:=jsonb_build_object('status','held','reason',obs->>'unavailable');
 else
 if obs->>'sourceKey' is distinct from 'spareto_schaeffler_correction_v1' or obs->>'brand' is distinct from j.manifest->>'brand'
  or obs->'exactIdentity' is distinct from 'true'::jsonb
  or lower(regexp_replace(obs->>'sourceBrand','^Schaeffler[[:space:]]+','','i')) is distinct from lower(j.manifest->>'brand')
  or jsonb_typeof(obs->'eanCandidates') is distinct from 'array'
  or public.normalize_catalog_product_code(obs->>'code') is distinct from public.normalize_catalog_product_code(it.product_code)
  or coalesce(obs->>'sourceUrl','')!~'^https://spareto[.]com/products/[a-zA-Z0-9._~%/-]+$'
  or coalesce(obs->>'fingerprint','')!~'^[a-f0-9]{64}$' then raise exception 'CORRECTION_SOURCE_IDENTITY_INVALID';end if;
 select * into p from public.catalog_products where organization_id=input_org and brand_id=(j.manifest->>'brand_id')::uuid and id=(obs->'before'->>'id')::uuid for update;
 if p.id is null or public.normalize_catalog_product_code(p.product_code)<>public.normalize_catalog_product_code(it.product_code) then
  result_value:=jsonb_build_object('status','held','reason','CATALOG_IDENTITY_CHANGED');
 elsif (nullif(btrim(p.ean),'') is not null and not(coalesce(obs->'eanCandidates','[]') ? regexp_replace(p.ean,'[[:space:]]','','g')))
  or (nullif(btrim(p.ean),'') is null and (nullif(obs->'fields'->>'ean','') is null or not(coalesce(obs->'eanCandidates','[]') ? (obs->'fields'->>'ean')))) then
  result_value:=jsonb_build_object('status','held','reason','EAN_IDENTITY_CONFLICT');
 else
  -- A correction for these three brands never waits for another brand's
  -- supplier-file lane, but it cannot overlap its own primary source writer.
  if exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where organization_id=input_org and brand_id=p.brand_id and status='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','deferred','reason','SAME_BRAND_PRIMARY_TURN_ACTIVE');end if;
  before_values:=to_jsonb(p);proposal:=coalesce(obs->'proposal'->'patch','{}');
  if jsonb_typeof(proposal)<>'object' or exists(select 1 from jsonb_object_keys(proposal) k where k not in ('description','oem_no','market_segment','image_url') or not(j.manifest->'approved_fields' ? k)) then raise exception 'CORRECTION_FIELD_NOT_APPROVED';end if;
  for field,v in select key,value from jsonb_each(proposal)loop
   if jsonb_typeof(v)<>'string' or nullif(btrim(v#>>'{}'),'') is null or length(v#>>'{}')>12000 then raise exception 'CORRECTION_FIELD_INVALID';end if;
   if field in ('description','market_segment') and v is distinct from obs->'fields'->field then raise exception 'CORRECTION_FIELD_EVIDENCE_MISMATCH';end if;
   if field='description' and length(v#>>'{}')>500 then raise exception 'CORRECTION_DESCRIPTION_INVALID';end if;
   if field='oem_no' and v#>>'{}' is distinct from supplier_price_ingestion_internal.merge_correction_oems(obs->'before'->>'oem_no',obs->'fields'->>'oem_no') then raise exception 'CORRECTION_OEM_ADDITION_INVALID';end if;
   if field='market_segment' and (v#>>'{}' not in ('pc','cv','lcv','motorcycle','engines','universal','marine','industrial','agriculture','off_highway') or obs->'segmentEvidence'->>'status' is distinct from 'explicit_vehicle_class') then raise exception 'CORRECTION_SEGMENT_UNVERIFIED';end if;
   if field='image_url' and (v is distinct from obs->'imageCandidate' or obs->'imageEvidence'->>'scope' is distinct from 'primary_product_meta'
    or not(coalesce(obs->'imageEvidence'->'candidates','[]') ? (v#>>'{}'))
    or v#>>'{}' !~ '^https://cdn[.]spareto[.]com/variants/images/[A-Za-z0-9/_-]+[.](jpg|jpeg|png|webp)([?][0-9]+)?$'
    or v#>>'{}' ~* '(placeholder|no[-_]?image|default)') then raise exception 'CORRECTION_IMAGE_NOT_APPROVED';end if;
   if before_values->field is distinct from obs->'before'->field then outcomes:=outcomes||jsonb_build_object(field,'changed_since_review');
   elsif before_values->field=v then outcomes:=outcomes||jsonb_build_object(field,'unchanged');
   else changes:=changes||jsonb_build_object(field,v);outcomes:=outcomes||jsonb_build_object(field,'applied');end if;
  end loop;
  if changes<>'{}' then update public.catalog_products cp set
   description=case when changes?'description' then changes->>'description' else cp.description end,
   oem_no=case when changes?'oem_no' then changes->>'oem_no' else cp.oem_no end,
   market_segment=case when changes?'market_segment' then changes->>'market_segment' else cp.market_segment end,
   image_url=case when changes?'image_url' then changes->>'image_url' else cp.image_url end,updated_at=now() where cp.id=p.id returning cp.* into p;end if;
  insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
   values(input_org,p.id,'spareto_schaeffler_correction_v1',obs->>'sourceUrl',obs->>'code','owner-reviewed-correction.v1',obs->>'fingerprint')
   on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint)do nothing returning id into sid;
  result_value:=jsonb_build_object('status','completed','fields',outcomes,'changes',changes,'before',before_values,'after',to_jsonb(p),
   'sourceUrl',obs->>'sourceUrl','source_fingerprint',obs->>'fingerprint','segment_status',coalesce(obs->'segmentEvidence'->>'status','source_missing'),
   'image_approval',j.manifest->>'approval_reference','source_record_id',sid);
 end if;
 end if;
 insert into public.catalog_brand_item_applications(job_id,item_index,organization_id,catalog_product_id,result)values(j.id,input_index,input_org,p.id,result_value);
 insert into public.catalog_observation_audit_ledger(organization_id,actor_id,action,evidence_reference,payload)
 values(input_org,j.created_by,'spareto_owner_reviewed_correction',obs->>'sourceUrl',result_value||jsonb_build_object('brand_job_id',j.id,'item_index',input_index,'source_key','spareto_schaeffler_correction_v1','approval_reference',j.manifest->>'approval_reference','product_code',it.product_code));
 return result_value;
end$$;

create function public.get_catalog_spareto_correction_status(input_org uuid,input_brand text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CORRECTION_SERVICE_REQUIRED';end if;
 select jsonb_build_object('source','Spareto','total',sum(total_items),'processed',sum(next_index),
  'jobs',count(*),'running',count(*)filter(where status='running' and lease_expires_at>now()),'failed',count(*)filter(where status='failed'),
  'completed',count(*)filter(where status='completed'),
  'applied',(select count(*) from public.catalog_brand_item_applications a join public.catalog_brand_jobs b on b.id=a.job_id where b.organization_id=input_org and b.manifest->>'brand'=input_brand and b.manifest->>'adapter'='spareto-reviewed-correction.v1' and a.result->'changes'<>'{}'::jsonb),
  'held',(select count(*) from public.catalog_brand_item_applications a join public.catalog_brand_jobs b on b.id=a.job_id where b.organization_id=input_org and b.manifest->>'brand'=input_brand and b.manifest->>'adapter'='spareto-reviewed-correction.v1' and a.result->>'status'='held'))
 into result_value from public.catalog_brand_jobs where organization_id=input_org and manifest->>'brand'=input_brand and manifest->>'adapter'='spareto-reviewed-correction.v1' having count(*)>0;
 return result_value;
end$$;

-- Share the existing globally serialized Spareto reader; no parallel crawler.
create or replace function public.claim_supplier_catalog_secondary_review() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;token uuid:=gen_random_uuid();p jsonb;brand text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SECONDARY_SERVICE_REQUIRED';end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-secondary-consumer-v1',0))
  or exists(select 1 from supplier_price_ingestion_internal.catalog_secondary_reviews where status='running' and lease_until>clock_timestamp())
  or exists(select 1 from public.catalog_brand_jobs where status='running' and lease_expires_at>clock_timestamp() and manifest->>'adapter'='spareto-reviewed-correction.v1') then return null;end if;
 select candidate.* into q from supplier_price_ingestion_internal.catalog_secondary_reviews candidate where candidate.status in ('queued','running','retry_wait')
  and candidate.next_attempt_at<=clock_timestamp() and (candidate.lease_until is null or candidate.lease_until<clock_timestamp())
  and supplier_price_ingestion_internal.secondary_source_allowed(candidate.organization_id,candidate.brand_id)
  order by candidate.next_attempt_at,candidate.created_at,candidate.id limit 1 for update skip locked;
 if not found then return null;end if;
 select to_jsonb(c) into p from public.catalog_products c where c.organization_id=q.organization_id and c.brand_id=q.brand_id and c.id=q.product_id and public.normalize_catalog_product_code(c.product_code)=public.normalize_catalog_product_code(q.product_code);
 if p is null then update supplier_price_ingestion_internal.catalog_secondary_reviews set status='blocked',error_code='SECONDARY_CATALOG_IDENTITY_CHANGED',updated_at=now() where id=q.id;return jsonb_build_object('skipped',true);end if;
 update supplier_price_ingestion_internal.catalog_secondary_reviews set status='running',lease_token=token,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,before_values=p,updated_at=now() where id=q.id;
 select name into brand from public.brands where id=q.brand_id and organization_id=q.organization_id;
 return jsonb_build_object('id',q.id,'token',token,'organizationId',q.organization_id,'brand',brand,'code',q.product_code,'before',p,
  'official',jsonb_build_object('authority','official','brand',brand,'code',public.normalize_catalog_product_code(q.product_code),'sourceUrl',q.official_evidence->>'sourceUrl','fingerprint',q.official_evidence->>'fingerprint',
  'fields',case when nullif(q.official_evidence->>'sourceEan','') is not null then jsonb_build_object('ean',q.official_evidence->>'sourceEan') else '{}'::jsonb end));
end$$;

revoke all on function public.start_catalog_spareto_correction(uuid,uuid,text,jsonb,uuid),public.reserve_catalog_spareto_correction(uuid,uuid,uuid),public.apply_catalog_spareto_correction_item(uuid,uuid,uuid,integer),public.get_catalog_spareto_correction_status(uuid,text) from public,anon,authenticated;
grant execute on function public.start_catalog_spareto_correction(uuid,uuid,text,jsonb,uuid),public.reserve_catalog_spareto_correction(uuid,uuid,uuid),public.apply_catalog_spareto_correction_item(uuid,uuid,uuid,integer),public.get_catalog_spareto_correction_status(uuid,text) to service_role;
select pg_notify('pgrst','reload schema');
