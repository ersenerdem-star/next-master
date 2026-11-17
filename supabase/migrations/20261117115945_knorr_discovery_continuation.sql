-- Seal page, admit exact-product review and queue the next page atomically.
-- Product review is never auto-published by this function.
create function public.complete_catalog_knorr_discovery(input_org uuid,input_job uuid,input_token uuid,input_page jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='8s' as $$
declare j public.catalog_brand_jobs%rowtype; src public.catalog_external_sources%rowtype; n integer; next_page integer; total integer; pages integer; scan_id text; c jsonb; codes jsonb:='[]'; child jsonb; nj public.catalog_brand_jobs%rowtype; cfg jsonb; next_key uuid; child_key uuid; result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'KNORR_SERVICE_REQUIRED';end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org and mode='stage' and status='running' and lease_token=input_token and lease_expires_at>now() for update;
 if j.id is null or j.next_index<>0 or j.total_items<>1 or j.manifest->>'adapter' is distinct from 'knorr-official-discovery.v1' or j.manifest->>'brand' is distinct from 'Knorr-Bremse' or j.manifest->>'source_key' is distinct from 'knorr_bremse_aftermarket' then raise exception 'KNORR_DISCOVERY_LEASE_INVALID';end if;
 select * into src from public.catalog_external_sources where organization_id=input_org and source_key='knorr_bremse_aftermarket';
 if src.id is null or not src.is_active or src.license_posture not in('allowed','internal_review_required') or src.credential_boundary<>'none' or src.rate_limit_posture<>'bounded' or src.metadata->>'brand_engine_read_allowed' is distinct from 'true' or (src.metadata->'allowed_brands' ? 'Knorr-Bremse') is distinct from true then raise exception 'KNORR_SOURCE_UNAVAILABLE';end if;
 if not exists(select 1 from public.profiles where id=j.created_by and organization_id=input_org and role='superadmin' and is_active) then raise exception 'KNORR_ADMIN_UNAVAILABLE';end if;
 if jsonb_typeof(input_page) is distinct from 'object' or input_page->'canonicalWrite' is distinct from 'false'::jsonb or input_page->'complete' is distinct from 'false'::jsonb or input_page->>'coverage' is distinct from 'best_effort_live_pagination' or coalesce(input_page->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(input_page->'candidates') is distinct from 'array' or jsonb_array_length(input_page->'candidates')>100 or coalesce(input_page->>'page','') !~ '^\d{1,6}$' or coalesce(input_page->>'totalResults','') !~ '^\d{1,7}$' or coalesce(input_page->>'totalPages','') !~ '^\d{1,6}$' then raise exception 'KNORR_DISCOVERY_RECEIPT_INVALID';end if;
 n:=(input_page->>'page')::integer;total:=(input_page->>'totalResults')::integer;pages:=(input_page->>'totalPages')::integer;
 if n<>(j.manifest->>'page')::integer or pages<>ceil(total/100.0)::integer or jsonb_array_length(input_page->'candidates')<>least(100,greatest(0,total-n*100)) then raise exception 'KNORR_DISCOVERY_PAGE_INVALID';end if;
 if j.manifest ? 'previous' and (j.manifest->'previous'->>'nextPage' is distinct from n::text or j.manifest->'previous'->>'totalResults' is distinct from total::text or j.manifest->'previous'->>'totalPages' is distinct from pages::text) then raise exception 'KNORR_DISCOVERY_SNAPSHOT_CHANGED';end if;
 next_page:=case when n+1<pages then n+1 else null end;
 if input_page->>'nextPage' is distinct from next_page::text then raise exception 'KNORR_DISCOVERY_NEXT_PAGE_INVALID';end if;
 for c in select value from jsonb_array_elements(input_page->'candidates') loop
  if jsonb_typeof(c)<>'object' or coalesce(c->>'sourceCode','')='' or length(c->>'sourceCode')>100 then raise exception 'KNORR_DISCOVERY_CANDIDATE_INVALID';end if;
  if c->'eligible'='true'::jsonb then
   if c->>'sourceCode' !~ '^[A-Z0-9][A-Z0-9.-]{0,99}$' or c->>'canonicalCode' is distinct from regexp_replace(c->>'sourceCode','[^A-Z0-9]','','g') or length(c->>'canonicalCode') not between 1 and 80 or (c->'requiresCollisionReview') is distinct from to_jsonb((c->>'sourceCode')<>(c->>'canonicalCode')) then raise exception 'KNORR_DISCOVERY_CANDIDATE_INVALID';end if;
   codes:=codes||jsonb_build_array(c->>'sourceCode');
  end if;
 end loop;
 if (select count(distinct v) from jsonb_array_elements_text(codes) v)<>jsonb_array_length(codes) then raise exception 'KNORR_DISCOVERY_DUPLICATE_CODE';end if;
 scan_id:=coalesce(j.manifest->>'scan_id',j.idempotency_key::text);
 if jsonb_array_length(codes)>0 then
  child_key:=md5('knorr-articles:'||scan_id||':'||n)::uuid;
  child:=public.start_catalog_brand_job(input_org,j.created_by,codes,'Knorr-Bremse',child_key,'knorr_bremse_aftermarket');
  update public.catalog_brand_jobs set manifest=manifest||jsonb_build_object('discovery_job',j.id,'scan_id',scan_id) where id=(child->>'id')::uuid and organization_id=input_org;
 end if;
 if next_page is not null then
  next_key:=md5('knorr-discovery:'||scan_id||':'||next_page)::uuid;
  cfg:=jsonb_build_object('adapter','knorr-official-discovery.v1','brand','Knorr-Bremse','source_key','knorr_bremse_aftermarket','page',next_page,'scan_id',scan_id,'previous',jsonb_build_object('nextPage',next_page,'totalResults',total,'totalPages',pages));
  insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items) values(input_org,j.created_by,next_key,cfg,1) on conflict(organization_id,idempotency_key) do nothing;
  select * into nj from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=next_key;
  if nj.manifest is distinct from cfg then raise exception 'KNORR_DISCOVERY_REQUEST_KEY_CONFLICT';end if;
  insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code) values(nj.id,input_org,0,'KNORR-PAGE-'||next_page::text) on conflict do nothing;
 end if;
 result_value:=jsonb_build_object('status','review_required','nextPage',next_page,'nextJob',nj.id,'articleJob',child->>'id','eligible',jsonb_array_length(codes),'held',jsonb_array_length(input_page->'candidates')-jsonb_array_length(codes));
 perform public.checkpoint_catalog_brand_job(input_org,input_job,input_token,0,input_page,result_value,'reviewed',null,true,null);
 return result_value;
end$$;
revoke all on function public.complete_catalog_knorr_discovery(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_catalog_knorr_discovery(uuid,uuid,uuid,jsonb) to service_role;
