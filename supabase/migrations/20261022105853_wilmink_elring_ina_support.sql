set local lock_timeout='2s';
set local statement_timeout='30s';

-- Additive support only. Existing primary engines and Kolbenschmidt RPCs stay intact.
create function public.start_catalog_wilmink_support(input_org uuid,input_actor uuid,input_key uuid,input_brand text,input_urls jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='8s' as $$
declare s public.catalog_external_sources%rowtype;j public.catalog_brand_jobs%rowtype;cfg jsonb;source_key_value text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'WILMINK_SERVICE_REQUIRED';end if;
 if input_key is null or not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active) then raise exception 'WILMINK_ADMIN_REQUIRED';end if;
 if input_brand is null or input_brand not in('Elring','INA') then raise exception 'WILMINK_BRAND_UNAVAILABLE';end if;
 if jsonb_typeof(input_urls) is distinct from 'array' or jsonb_array_length(input_urls)>12
 or (input_brand='INA' and jsonb_array_length(input_urls)=0)
 or exists(select 1 from jsonb_array_elements(input_urls)v where jsonb_typeof(v)<>'string' or v#>>'{}' !~ '^https://www[.]wilminkengineparts[.]com/en/[a-z0-9-]+/wg[0-9]+$')
 or (select count(distinct value) from jsonb_array_elements_text(input_urls))<>jsonb_array_length(input_urls) then raise exception 'WILMINK_PRODUCT_URL_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended('wilmink-support:'||input_org::text||':'||input_brand,0));
 source_key_value:=case input_brand when 'Elring' then 'wilmink_elring_support_v1' when 'INA' then 'wilmink_ina_support_v1' end;
 select * into s from public.catalog_external_sources where organization_id=input_org and source_key=source_key_value;
 if s.id is null or not s.is_active or s.license_posture not in('allowed','internal_review_required') or s.credential_boundary<>'none' or s.rate_limit_posture<>'bounded'
 or s.metadata->'allowed_brands' is distinct from jsonb_build_array(input_brand) or s.metadata->'brand_engine_read_allowed' is distinct from 'true'::jsonb then raise exception 'WILMINK_SOURCE_UNAVAILABLE';end if;
 cfg:=jsonb_build_object('adapter','wilmink-support-discovery.v1','brand',input_brand,'source_key',s.source_key,'scan_id',input_key);
 if jsonb_array_length(input_urls)>0 then cfg:=cfg||jsonb_build_object('urls',input_urls);
 else cfg:=cfg||jsonb_build_object('page_url','https://www.wilminkengineparts.com/en/brands/elring');end if;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and manifest->>'adapter'='wilmink-support-discovery.v1'
 and manifest->>'brand'=input_brand and manifest->>'source_key'=source_key_value
 and ((input_urls='[]'::jsonb and manifest ? 'page_url') or manifest->'urls'=input_urls)
 and status in('queued','running','paused','failed') order by created_at desc limit 1 for update;
 if j.id is not null then
  if j.status in('paused','failed') then perform public.schedule_catalog_brand_job(input_org,j.id,false);select * into j from public.catalog_brand_jobs where id=j.id;end if;
  return to_jsonb(j)-'lease_token';
 end if;
 insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items)values(input_org,input_actor,input_key,cfg,1)on conflict(organization_id,idempotency_key)do nothing;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest<>cfg then raise exception 'WILMINK_REQUEST_KEY_CONFLICT';end if;
 insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)values(j.id,input_org,0,'WILMINK-SUPPORT')on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end$$;

create function public.complete_catalog_wilmink_support(input_org uuid,input_job uuid,input_token uuid,input_page jsonb,input_products jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='8s' as $$
declare brand_name text;source_key_value text; j public.catalog_brand_jobs%rowtype;it public.catalog_brand_job_items%rowtype;s public.catalog_external_sources%rowtype;
 p public.catalog_products%rowtype;b uuid;v jsonb;eligible jsonb:='[]';codes jsonb:='[]';child public.catalog_brand_jobs%rowtype;next_job public.catalog_brand_jobs%rowtype;cfg jsonb;n integer:=0;page_no integer;next_url text;next_key uuid;result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'WILMINK_SERVICE_REQUIRED';end if;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and id=input_job and status='running' and mode='stage' and lease_token=input_token and lease_expires_at>clock_timestamp() for update;
 if j.id is null or j.next_index<>0 or j.manifest->>'adapter' is distinct from 'wilmink-support-discovery.v1' or coalesce(j.manifest->>'brand','') not in('Elring','INA') then raise exception 'WILMINK_LEASE_INVALID';end if;
 brand_name:=j.manifest->>'brand';source_key_value:=case brand_name when 'Elring' then 'wilmink_elring_support_v1' when 'INA' then 'wilmink_ina_support_v1' end;
 if j.manifest->>'source_key' is distinct from source_key_value then raise exception 'WILMINK_SOURCE_UNAVAILABLE';end if;
 select * into s from public.catalog_external_sources where organization_id=input_org and source_key=source_key_value;
 if s.id is null or not s.is_active or s.license_posture not in('allowed','internal_review_required') or s.credential_boundary<>'none' or s.rate_limit_posture<>'bounded'
  or s.metadata->'brand_engine_read_allowed' is distinct from 'true'::jsonb or s.metadata->'allowed_brands' is distinct from jsonb_build_array(brand_name)
  or not exists(select 1 from public.profiles where id=j.created_by and organization_id=input_org and role='superadmin' and is_active) then raise exception 'WILMINK_SOURCE_UNAVAILABLE';end if;
 select * into it from public.catalog_brand_job_items where job_id=j.id and organization_id=input_org and item_index=0 for update;
 if it.checkpoint->'page' is distinct from input_page or it.checkpoint->'captured' is distinct from input_products or input_page->>'pageUrl' is distinct from j.manifest->>'page_url'
  or coalesce(input_page->>'pageFingerprint','')!~'^[a-f0-9]{64}$' or jsonb_typeof(input_page->'urls') is distinct from 'array'
  or jsonb_typeof(input_products) is distinct from 'array' or jsonb_array_length(input_products)not between 1 and 48 or octet_length(input_products::text)>3*1024*1024
  or jsonb_array_length(input_products)<>jsonb_array_length(input_page->'urls') then raise exception 'WILMINK_PAGE_RECEIPT_INVALID';end if;
 next_url:=input_page->>'nextUrl';
 if j.manifest ? 'urls' then
  if input_page->'urls' is distinct from j.manifest->'urls' or input_page->>'pageUrl' is not null or next_url is not null then raise exception 'WILMINK_PAGE_RECEIPT_INVALID';end if;
 else
  if brand_name<>'Elring' or coalesce(input_page->>'pageUrl','')!~'^https://www[.]wilminkengineparts[.]com/en/brands/elring([?]page=[1-9][0-9]{0,3})?$' then raise exception 'WILMINK_PAGE_RECEIPT_INVALID';end if;
  page_no:=coalesce(nullif(substring(input_page->>'pageUrl' from '[?]page=([0-9]+)$'),''),'1')::integer;
  if next_url is not null and next_url is distinct from 'https://www.wilminkengineparts.com/en/brands/elring?page='||(page_no+1)::text then raise exception 'WILMINK_NEXT_PAGE_INVALID';end if;
 end if;
 select id into b from public.brands where organization_id=input_org and name=brand_name;if b is null then raise exception 'WILMINK_BRAND_UNAVAILABLE';end if;
 for v in select value from jsonb_array_elements(input_products)loop
  if v->>'sourceUrl' is distinct from input_page->'urls'->>n or coalesce(v->>'sourceUrl','')!~'^https://www[.]wilminkengineparts[.]com/en/[a-z0-9-]+/wg[0-9]+$' then raise exception 'WILMINK_PRODUCT_URL_INVALID';end if;n:=n+1;
  if v->>'unavailable' is not null then continue;end if;
  if v->>'brand' is distinct from brand_name or v->>'sourceKey' is distinct from s.source_key or v->>'authority' is distinct from 'distributor' or v->'exactIdentity' is distinct from 'true'::jsonb
   or coalesce(v->>'sourceSku','')!~'^WG[0-9]+$' or right(v->>'sourceUrl',length(v->>'sourceSku')+1) is distinct from '/'||lower(v->>'sourceSku')
   or coalesce(v->>'fingerprint','')!~'^[a-f0-9]{64}$' or jsonb_typeof(v->'fields') is distinct from 'object'
   or jsonb_typeof(v->'sourceFields') is distinct from 'object' or coalesce(v->'sourceFields'->>'ean','')!~'^[0-9]{8,14}$'
   or exists(select 1 from jsonb_object_keys(v->'fields')k where k not in('description','description_tr','ean','oem_no','vehicle','vehicle_model','market_segment','weight_kg','dimensions','origin','hs_code'))
   or jsonb_array_length(coalesce(v->'replacements','[]'))<>0 or v->'lifecycle'->'checks' is distinct from '{"replacement":"unsupported","discontinued":"unsupported"}'::jsonb then raise exception 'WILMINK_PRODUCT_RECEIPT_INVALID';end if;
  select * into p from public.catalog_products where organization_id=input_org and brand_id=b and id=(v->'before'->>'id')::uuid;
  if p.id is null or upper(regexp_replace(p.product_code,'[[:space:]]','','g')) is distinct from v->>'code' then raise exception 'WILMINK_CATALOG_IDENTITY_INVALID';end if;
  eligible:=eligible||jsonb_build_array(v);codes:=codes||jsonb_build_array(p.product_code);
  insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
  values(input_org,p.id,s.source_key,v->>'sourceUrl',v->>'sourceSku','wilmink-reviewed-discovery.v1',v->>'fingerprint')on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint)do nothing;
 end loop;
 if jsonb_array_length(eligible)>0 then
  -- Repeated product codes on a listing page require review, never a merge.
  if(select count(distinct upper(regexp_replace(value,'[[:space:]]','','g')))from jsonb_array_elements_text(codes))<>jsonb_array_length(codes)then raise exception 'WILMINK_DUPLICATE_ARTICLE';end if;
  cfg:=jsonb_build_object('brand',brand_name,'source_key',s.source_key,'adapter','brand-exact.v1','codes',codes,'scan_id',j.manifest->>'scan_id','discovery_job',j.id);
  insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items,next_index,status)
  values(input_org,j.created_by,j.id,cfg,jsonb_array_length(codes),jsonb_array_length(codes),'reviewed')on conflict(organization_id,idempotency_key)do nothing;
  select * into child from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=j.id;
  if child.manifest<>cfg then raise exception 'WILMINK_REQUEST_KEY_CONFLICT';end if;
  insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code,state,observation)
  select child.id,input_org,(x.ordinality-1)::integer,codes->>(x.ordinality-1)::integer,'reviewed',x.value from jsonb_array_elements(eligible)with ordinality x(value,ordinality)on conflict do nothing;
 end if;
 if next_url is not null then
  next_key:=md5((j.manifest->>'scan_id')||next_url)::uuid;
  cfg:=j.manifest||jsonb_build_object('page_url',next_url);
  insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items)values(input_org,j.created_by,next_key,cfg,1)on conflict(organization_id,idempotency_key)do nothing;
  select * into next_job from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=next_key;
  if next_job.manifest<>cfg then raise exception 'WILMINK_REQUEST_KEY_CONFLICT';end if;
  insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)values(next_job.id,input_org,0,'WILMINK-PAGE-'||(page_no+1)::text)on conflict do nothing;
 end if;
 result_value:=jsonb_build_object('page',page_no,'observed',jsonb_array_length(input_products),'matched',jsonb_array_length(eligible),'held',jsonb_array_length(input_products)-jsonb_array_length(eligible),'review_job',child.id,'next_job',next_job.id);
 perform public.checkpoint_catalog_brand_job(input_org,j.id,input_token,0,jsonb_build_object('page',input_page,'products',input_products),result_value,'reviewed',null,true,null);
 insert into public.catalog_observation_audit_ledger(organization_id,actor_id,action,evidence_reference,payload)values(input_org,j.created_by,'wilmink_support_reviewed',coalesce(j.manifest->>'page_url',s.base_url),result_value||jsonb_build_object('source_key',s.source_key,'brand_job_id',j.id));
 return result_value;
end$$;

create function public.get_catalog_wilmink_support_status(input_org uuid,input_brand text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare scan text;result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'WILMINK_SERVICE_REQUIRED';end if;
 if input_brand is null or input_brand not in('Elring','INA') then raise exception 'WILMINK_BRAND_UNAVAILABLE';end if;
 select manifest->>'scan_id' into scan from public.catalog_brand_jobs where organization_id=input_org and manifest->>'adapter'='wilmink-support-discovery.v1' and manifest->>'brand'=input_brand order by created_at desc limit 1;
 if scan is null then return null;end if;
 select jsonb_build_object('pages',count(*)filter(where j.status='reviewed'),'lastPage',max((coalesce(i.observation->'page',i.checkpoint->'page')->>'lastPage')::integer),'observed',coalesce(sum((i.checkpoint->>'observed')::integer),0),
 'matched',coalesce(sum((i.checkpoint->>'matched')::integer),0),
 'held',coalesce(sum((select count(*) from jsonb_array_elements(coalesce(i.observation->'products','[]'::jsonb))v where v->>'unavailable' is not null or v->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb)),0),
 'failed',count(*)filter(where j.status='failed'),'active',count(*)filter(where j.status in('queued','running','paused')))
 into result_value from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id where j.organization_id=input_org and j.manifest->>'adapter'='wilmink-support-discovery.v1' and j.manifest->>'brand'=input_brand and j.manifest->>'scan_id'=scan;
 return result_value;
end$$;
revoke all on function public.start_catalog_wilmink_support(uuid,uuid,uuid,text,jsonb),public.complete_catalog_wilmink_support(uuid,uuid,uuid,jsonb,jsonb),public.get_catalog_wilmink_support_status(uuid,text) from public,anon,authenticated;
grant execute on function public.start_catalog_wilmink_support(uuid,uuid,uuid,text,jsonb),public.complete_catalog_wilmink_support(uuid,uuid,uuid,jsonb,jsonb),public.get_catalog_wilmink_support_status(uuid,text) to service_role;
select pg_notify('pgrst','reload schema');
