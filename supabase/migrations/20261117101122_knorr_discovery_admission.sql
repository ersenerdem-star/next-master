-- Admit one bounded official page to the existing signed, fenced brand queue.
-- Discovery receipts are review-only and do not publish catalog products.
create function public.start_catalog_knorr_discovery(input_org uuid,input_actor uuid,input_key uuid,input_page integer default 0)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare j public.catalog_brand_jobs%rowtype; cfg jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'KNORR_SERVICE_REQUIRED';end if;
 if input_key is null or input_page is null or input_page not between 0 and 100000 or not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active) then raise exception 'KNORR_DISCOVERY_ADMISSION_INVALID';end if;
 if not exists(select 1 from public.catalog_external_sources s where s.organization_id=input_org and s.source_key='knorr_bremse_aftermarket' and s.is_active and s.license_posture in('allowed','internal_review_required') and s.credential_boundary='none' and s.rate_limit_posture='bounded' and s.metadata->'allowed_brands' ? 'Knorr-Bremse' and s.metadata->>'brand_engine_read_allowed'='true') then raise exception 'KNORR_SOURCE_UNAVAILABLE';end if;
 cfg:=jsonb_build_object('adapter','knorr-official-discovery.v1','brand','Knorr-Bremse','source_key','knorr_bremse_aftermarket','page',input_page,'scan_id',input_key);
 insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items) values(input_org,input_actor,input_key,cfg,1) on conflict(organization_id,idempotency_key) do nothing;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest is distinct from cfg then raise exception 'KNORR_DISCOVERY_REQUEST_KEY_CONFLICT';end if;
 insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code) values(j.id,input_org,0,'KNORR-PAGE-'||input_page::text) on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end$$;
revoke all on function public.start_catalog_knorr_discovery(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.start_catalog_knorr_discovery(uuid,uuid,uuid,integer) to service_role;
