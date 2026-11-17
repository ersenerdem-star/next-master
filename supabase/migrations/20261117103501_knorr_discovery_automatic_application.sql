-- Admit only completed official-discovery children under a revocable source grant.
create function public.admit_catalog_knorr_application()
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='3s' as $$
declare j public.catalog_brand_jobs%rowtype; result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'KNORR_SERVICE_REQUIRED';end if;
 select child.* into j from public.catalog_brand_jobs child
 join public.catalog_brand_jobs parent on parent.id::text=child.manifest->>'discovery_job' and parent.organization_id=child.organization_id and parent.status='reviewed' and parent.manifest->>'adapter'='knorr-official-discovery.v1' and parent.manifest->>'scan_id'=child.manifest->>'scan_id'
 join public.catalog_external_sources s on s.organization_id=child.organization_id and s.source_key='knorr_bremse_aftermarket'
 where child.status='reviewed' and child.mode='stage' and child.next_index=child.total_items and child.total_items between 1 and 100
 and child.manifest->>'adapter'='brand-exact.v1' and child.manifest->>'brand'='Knorr-Bremse' and child.manifest->>'source_key'=s.source_key
 and s.is_active and s.license_posture in('allowed','internal_review_required') and s.credential_boundary='none' and s.rate_limit_posture='bounded'
 and s.metadata->>'brand_engine_read_allowed'='true' and s.metadata->>'brand_engine_enrichment_allowed'='true' and s.metadata->>'automatic_application_policy'='knorr-official-missing-only.v1' and s.metadata->>'automatic_apply'='true' and nullif(s.metadata->>'automatic_application_approval_reference','') is not null
 and exists(select 1 from public.profiles p where p.id=child.created_by and p.organization_id=child.organization_id and p.role='superadmin' and p.is_active)
 and (select count(*) from public.catalog_brand_job_items i where i.job_id=child.id and i.organization_id=child.organization_id)=child.total_items
 and not exists(select 1 from public.catalog_brand_job_items i where i.job_id=child.id and (i.state<>'reviewed' or i.observation is null or i.observation->>'brand' is distinct from 'Knorr-Bremse' or i.observation->>'sourceKey' is distinct from s.source_key))
 order by child.created_at,child.id limit 1 for update of child skip locked;
 if j.id is null then return null;end if;
 result_value:=public.schedule_catalog_brand_job(j.organization_id,j.id,true);
 update public.catalog_brand_jobs set manifest=manifest||jsonb_build_object('automatic_application',jsonb_build_object('policy','knorr-official-missing-only.v1','admitted_at',clock_timestamp())) where id=j.id;
 return jsonb_build_object('id',j.id,'organization_id',j.organization_id,'status',result_value->>'status');
end$$;
revoke all on function public.admit_catalog_knorr_application() from public,anon,authenticated;
grant execute on function public.admit_catalog_knorr_application() to service_role;

-- Guard existing products for both manual and automatic publication.
create function public.apply_catalog_knorr_owned_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare product_id uuid; source_code text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'KNORR_SERVICE_REQUIRED';end if;
 select (i.observation->'before'->>'id')::uuid,upper(regexp_replace(i.product_code,'\s','','g')) into product_id,source_code
 from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id and i.organization_id=j.organization_id and i.item_index=input_index
 where j.id=input_job and j.organization_id=input_org and j.status='running' and j.mode='publish' and j.lease_token=input_token and j.lease_expires_at>now() and j.next_index=input_index and j.manifest->>'brand'='Knorr-Bremse' and j.manifest->>'source_key'='knorr_bremse_aftermarket';
 if not found or product_id is null then raise exception 'KNORR_CATALOG_IDENTITY_INVALID';end if;
 perform 1 from public.catalog_products p where p.id=product_id and p.organization_id=input_org for update;
 if not found then return jsonb_build_object('status','held','reason','CATALOG_IDENTITY_CHANGED');end if;
 if exists(select 1 from public.catalog_product_source_records r where r.organization_id=input_org and r.catalog_product_id=product_id and r.source_key='knorr_bremse_aftermarket' and (r.source_product_id is distinct from source_code or coalesce(r.payload_fingerprint,'') !~ '^[a-f0-9]{64}$')) then
  return jsonb_build_object('status','held','reason','KNORR_RECORDED_SOURCE_COLLISION');
 end if;
 return public.apply_catalog_brand_job_item(input_org,input_job,input_token,input_index);
end$$;
revoke all on function public.apply_catalog_knorr_owned_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_knorr_owned_item(uuid,uuid,uuid,integer) to service_role;

-- Recheck the grant on every write, including jobs queued before revocation.
create function public.apply_catalog_knorr_auto_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare create_missing boolean;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'KNORR_SERVICE_REQUIRED';end if;
 select i.observation->'missingCatalogProduct'='true'::jsonb into create_missing
 from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id and i.organization_id=j.organization_id and i.item_index=input_index
 join public.catalog_external_sources s on s.organization_id=j.organization_id and s.source_key=j.manifest->>'source_key'
 where j.id=input_job and j.organization_id=input_org and j.status='running' and j.mode='publish' and j.lease_token=input_token and j.lease_expires_at>now() and j.next_index=input_index
 and j.manifest->'automatic_application'->>'policy'='knorr-official-missing-only.v1' and s.source_key='knorr_bremse_aftermarket' and s.is_active
 and s.metadata->>'automatic_apply'='true' and s.metadata->>'automatic_application_policy'='knorr-official-missing-only.v1' and nullif(s.metadata->>'automatic_application_approval_reference','') is not null;
 if not found then raise exception 'KNORR_AUTOMATIC_APPLICATION_REVOKED';end if;
 if create_missing then return public.apply_catalog_knorr_create_item(input_org,input_job,input_token,input_index);end if;
 return public.apply_catalog_knorr_owned_item(input_org,input_job,input_token,input_index);
end$$;
revoke all on function public.apply_catalog_knorr_auto_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_knorr_auto_item(uuid,uuid,uuid,integer) to service_role;
