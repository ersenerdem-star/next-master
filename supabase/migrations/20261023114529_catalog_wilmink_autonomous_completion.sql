set local lock_timeout='2s';
set local statement_timeout='10s';

-- Only previously owner-authorized Wilmink sources receive this new policy.
-- Discovery receipts stay immutable. Existing guarded application RPCs own
-- every canonical write; this function only admits sealed review packages.
update public.catalog_external_sources
set metadata=metadata||jsonb_build_object('automatic_apply',true,
 'automatic_application_policy','wilmink-missing-only.v1',
 'automatic_application_approval_reference','user-enable-autonomous-catalog-completion-2026-10-23')
where (source_key,metadata->>'approval_reference') in (
 ('wilmink_kolbenschmidt_v1','user-kolbenschmidt-engine-from-wilmink-2026-10-21'),
 ('wilmink_elring_support_v1','user-wilmink-support-elring-ina-continue-2026-10-22'),
 ('wilmink_ina_support_v1','user-wilmink-support-elring-ina-continue-2026-10-22'))
and is_active and metadata->'brand_engine_enrichment_allowed'='true'::jsonb;

create function public.admit_catalog_wilmink_application()
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='3s' as $$
declare candidate public.catalog_brand_jobs%rowtype; result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'BRAND_DISPATCH_SERVICE_REQUIRED';end if;
 select j.* into candidate
 from public.catalog_brand_jobs j
 join public.catalog_brand_jobs parent on parent.id::text=j.manifest->>'discovery_job'
  and parent.organization_id=j.organization_id and parent.status='reviewed'
  and parent.manifest->>'source_key'=j.manifest->>'source_key'
  and parent.manifest->>'brand'=j.manifest->>'brand'
  and parent.manifest->>'scan_id'=j.manifest->>'scan_id'
 join public.catalog_external_sources s on s.organization_id=j.organization_id and s.source_key=j.manifest->>'source_key'
 where j.status='reviewed' and j.mode='stage' and j.next_index=j.total_items and j.total_items between 1 and 48
 and j.manifest->>'adapter'='brand-exact.v1'
 and (j.manifest->>'brand',s.source_key,parent.manifest->>'adapter') in (
 ('Kolbenschmidt','wilmink_kolbenschmidt_v1','wilmink-kolbenschmidt-discovery.v1'),
 ('Elring','wilmink_elring_support_v1','wilmink-support-discovery.v1'),
 ('INA','wilmink_ina_support_v1','wilmink-support-discovery.v1'))
 and s.is_active and s.license_posture in('allowed','internal_review_required') and s.credential_boundary='none' and s.rate_limit_posture='bounded'
 and s.metadata->'automatic_apply'='true'::jsonb and s.metadata->>'automatic_application_policy'='wilmink-missing-only.v1'
 and nullif(s.metadata->>'automatic_application_approval_reference','') is not null
 and s.metadata->'brand_engine_read_allowed'='true'::jsonb and s.metadata->'brand_engine_enrichment_allowed'='true'::jsonb
 and s.metadata->'allowed_brands' ? (j.manifest->>'brand')
 and nullif(s.metadata->>'approval_actor','') is not null and nullif(s.metadata->>'publication_approval_reference','') is not null
 and exists(select 1 from public.profiles p where p.id=j.created_by and p.organization_id=j.organization_id and p.role='superadmin' and p.is_active)
 and (select count(*) from public.catalog_brand_job_items i where i.job_id=j.id and i.organization_id=j.organization_id)=j.total_items
 and not exists(select 1 from public.catalog_brand_job_items i where i.job_id=j.id and (
  i.state<>'reviewed' or i.observation is null
  or i.observation->>'brand' is distinct from j.manifest->>'brand'
  or i.observation->>'sourceKey' is distinct from s.source_key
  or i.observation->>'authority' is distinct from 'distributor'
  or i.observation->'exactIdentity' is distinct from 'true'::jsonb
  or coalesce(i.observation->>'sourceUrl','')!~'^https://www[.]wilminkengineparts[.]com/en/[a-z0-9-]+/wg[0-9]+$'
  or coalesce(i.observation->>'fingerprint','')!~'^[a-f0-9]{64}$'
  or coalesce(i.observation->'sourceFields'->>'ean','')!~'^[0-9]{8,14}$'
  or jsonb_typeof(i.observation->'fields') is distinct from 'object'
  or exists(select 1 from jsonb_object_keys(case when jsonb_typeof(i.observation->'fields')='object' then i.observation->'fields' else '{}'::jsonb end) k where k not in('description','description_tr','ean','weight_kg','origin','hs_code','oem_no','vehicle','vehicle_model','market_segment','dimensions'))
  or coalesce(jsonb_typeof(i.observation->'issues'),'array')<>'array'
  or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(i.observation->'issues')='array' then i.observation->'issues' else '[]'::jsonb end) issue where issue->>'code' is distinct from 'EAN_IDENTITY_CONFLICT')
 ))
 order by j.created_at,j.id limit 1 for update of j skip locked;
 if candidate.id is null then return null;end if;
 result_value:=public.schedule_catalog_brand_job(candidate.organization_id,candidate.id,true);
 update public.catalog_brand_jobs set manifest=manifest||jsonb_build_object('automatic_application',jsonb_build_object(
  'policy','wilmink-missing-only.v1','approval_reference','user-enable-autonomous-catalog-completion-2026-10-23','admitted_at',clock_timestamp()))
 where id=candidate.id;
 return jsonb_build_object('id',candidate.id,'organization_id',candidate.organization_id,'status',result_value->>'status');
end$$;
revoke all on function public.admit_catalog_wilmink_application() from public,anon,authenticated;
grant execute on function public.admit_catalog_wilmink_application() to service_role;

-- Recheck the live automatic grant for each write, including jobs admitted
-- before a source was disabled. The established application RPC still owns
-- source/identity, concurrent-edit, scalar and publication boundaries.
create function public.apply_catalog_wilmink_automatic_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='4s' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'BRAND_DISPATCH_SERVICE_REQUIRED';end if;
 if not exists(select 1 from public.catalog_brand_jobs j join public.catalog_external_sources s
  on s.organization_id=j.organization_id and s.source_key=j.manifest->>'source_key'
  where j.id=input_job and j.organization_id=input_org and j.mode='publish' and j.status='running'
  and j.lease_token=input_token and j.lease_expires_at>now() and j.next_index=input_index
  and j.manifest->'automatic_application'->>'policy'='wilmink-missing-only.v1'
  and s.source_key in('wilmink_kolbenschmidt_v1','wilmink_elring_support_v1','wilmink_ina_support_v1')
  and s.is_active and s.metadata->'automatic_apply'='true'::jsonb
  and s.metadata->>'automatic_application_policy'='wilmink-missing-only.v1'
  and nullif(s.metadata->>'automatic_application_approval_reference','') is not null)
 then raise exception 'WILMINK_AUTOMATIC_APPLICATION_REVOKED';end if;
 return public.apply_catalog_brand_job_item(input_org,input_job,input_token,input_index);
end$$;
revoke all on function public.apply_catalog_wilmink_automatic_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_wilmink_automatic_item(uuid,uuid,uuid,integer) to service_role;

-- Transient source failures can recover after a cooldown. Authorization,
-- malformed receipts and other failed adapters remain outside auto-recovery.
create or replace function public.next_catalog_brand_dispatch()
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='3s' as $$
declare result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'BRAND_DISPATCH_SERVICE_REQUIRED';end if;
 with lanes as (
  select organization_id,manifest->>'source_key' source_key,manifest->>'brand' brand,max(updated_at) last_activity
  from public.catalog_brand_jobs group by organization_id,manifest->>'source_key',manifest->>'brand'
 )
 select jsonb_build_object('id',j.id,'organization_id',j.organization_id,'status',j.status) into result_value
 from public.catalog_brand_jobs j
 join lanes l on l.organization_id=j.organization_id and l.source_key=j.manifest->>'source_key' and l.brand=j.manifest->>'brand'
 join public.catalog_external_sources s on s.organization_id=j.organization_id and s.source_key=l.source_key
 where s.is_active and s.metadata->'allowed_brands' ? l.brand
 and (j.status='queued' or (j.status='paused' and(j.retry_after is null or j.retry_after<=now()))
  or(j.status='running' and j.lease_expires_at<=now())
  or(j.status='failed' and j.manifest->>'adapter' in('wilmink-kolbenschmidt-discovery.v1','wilmink-support-discovery.v1')
   and s.metadata->'automatic_apply'='true'::jsonb and j.updated_at<now()-interval '15 minutes'
   and j.error_message~*'fetch failed|timeout|timed out|abort|ECONN|network|HTTP_(429|5[0-9][0-9])'))
 and not exists(select 1 from public.catalog_brand_jobs a where a.organization_id=j.organization_id and a.status='running' and a.lease_expires_at>now())
 order by l.last_activity,j.updated_at,j.created_at,j.id limit 1;
 return result_value;
end$$;
revoke all on function public.next_catalog_brand_dispatch() from public,anon,authenticated;
grant execute on function public.next_catalog_brand_dispatch() to service_role;
create or replace function public.get_catalog_wilmink_status(input_org uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare scan text;result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'WILMINK_SERVICE_REQUIRED';end if;
 select manifest->>'scan_id' into scan from public.catalog_brand_jobs where organization_id=input_org and manifest->>'adapter'='wilmink-kolbenschmidt-discovery.v1' order by created_at desc limit 1;
 if scan is null then return null;end if;
 select jsonb_build_object('pages',count(*)filter(where j.status='reviewed'),'lastPage',max((coalesce(i.observation->'page',i.checkpoint->'page')->>'lastPage')::integer),'observed',coalesce(sum((i.checkpoint->>'observed')::integer),0),
 'matched',coalesce(sum((i.checkpoint->>'matched')::integer),0),
 'held',coalesce(sum((select count(*) from jsonb_array_elements(coalesce(i.observation->'products','[]'::jsonb))v where v->>'unavailable' is not null or v->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb)),0),
 'failed',count(*)filter(where j.status='failed'),'active',count(*)filter(where j.status in('queued','running','paused')))
 into result_value from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id where j.organization_id=input_org and j.manifest->>'adapter'='wilmink-kolbenschmidt-discovery.v1' and j.manifest->>'scan_id'=scan;
 result_value:=result_value||jsonb_build_object('heldItems',coalesce((select jsonb_agg(x) from (
 select v->>'code' as code,v->>'sourceUrl' as "sourceUrl",coalesce(v->>'unavailable','EAN_IDENTITY_CONFLICT') as reason
 from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id
 cross join lateral jsonb_array_elements(coalesce(i.observation->'products',i.checkpoint->'captured','[]'::jsonb)) v
 where j.organization_id=input_org and j.manifest->>'adapter'='wilmink-kolbenschmidt-discovery.v1' and j.manifest->>'scan_id'=scan
 and (v->>'unavailable' is not null or v->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb)
 order by j.created_at desc limit 25)x),'[]'::jsonb));
 return result_value;
end$$;
revoke all on function public.get_catalog_wilmink_status(uuid) from public,anon,authenticated;
grant execute on function public.get_catalog_wilmink_status(uuid) to service_role;

select pg_notify('pgrst','reload schema');
