alter table public.catalog_brand_jobs add column retry_attempts integer not null default 0 check(retry_attempts between 0 and 5),add column retry_after timestamptz;
create or replace function public.schedule_catalog_brand_job(input_org uuid,input_job uuid,input_publish boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org for update;
 if j.id is null then raise exception 'Brand job not found'; end if;
 if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key=j.manifest->>'source_key' and is_active and metadata->'allowed_brands' ? (j.manifest->>'brand')) then raise exception 'Brand source unavailable'; end if;
 if j.status='running' and j.lease_expires_at>now() then return to_jsonb(j)-'lease_token'; end if;
 if input_publish then
  if j.status<>'reviewed' then raise exception 'Review collection must complete before publication'; end if;
  if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key=j.manifest->>'source_key'
   and is_active and license_posture in ('allowed','internal_review_required') and metadata->>'brand_engine_enrichment_allowed'='true'
   and nullif(metadata->>'approval_actor','') is not null and nullif(metadata->>'publication_approval_reference','') is not null) then
   raise exception 'Brand publication authorization missing'; end if;
  update public.catalog_brand_jobs set mode='publish',next_index=0,status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 elsif j.status not in ('reviewed','completed') then
  update public.catalog_brand_jobs set status='queued',retry_attempts=case when status='failed' then 0 else retry_attempts end,retry_after=null,error_message=null,updated_at=now() where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'lease_token';
end $$;

create or replace function public.claim_catalog_brand_job(input_org uuid,input_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-brand:'||input_org::text,0));
 if exists(select 1 from public.catalog_brand_jobs where organization_id=input_org and status='running' and lease_expires_at>now()) then return null; end if;
 update public.catalog_brand_jobs set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and (retry_after is null or retry_after<=now()) and (status='queued' or (status='running' and lease_expires_at<=now())) returning * into j;
 if j.id is null then return null; end if;
 return to_jsonb(j);
end $$;

create or replace function public.checkpoint_catalog_brand_job(input_org uuid,input_job uuid,input_token uuid,input_index integer,
 input_observation jsonb,input_checkpoint jsonb,input_state text,input_error text default null,input_advance boolean default false,input_end_status text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org and lease_token=input_token
  and status='running' and lease_expires_at>now() for update;
 if j.id is null then raise exception 'Brand worker lease lost'; end if;
 if input_index is distinct from j.next_index or input_checkpoint is null or jsonb_typeof(input_checkpoint)<>'object'
  or (input_end_status is not null and input_end_status not in ('paused','failed')) then raise exception 'Invalid Brand checkpoint'; end if;
 if input_advance and (input_state is distinct from case when j.mode='stage' then 'reviewed' else 'completed' end) then raise exception 'Brand package is not complete'; end if;
 if exists(select 1 from public.catalog_brand_job_items where job_id=j.id and item_index=input_index and observation is not null and observation is distinct from input_observation) then raise exception 'Brand observation is immutable'; end if;
 if input_observation is not null and octet_length(input_observation::text)>5*1024*1024 then raise exception 'Brand observation too large'; end if;
 if input_advance and input_observation is null then raise exception 'Brand source receipt required'; end if;
 update public.catalog_brand_job_items set observation=input_observation,checkpoint=input_checkpoint,state=input_state,
  error_message=input_error,updated_at=now() where job_id=j.id and organization_id=input_org and item_index=input_index;
 if not found then raise exception 'Brand item not found'; end if;
 update public.catalog_brand_jobs set next_index=case when input_advance then next_index+1 else next_index end,
  status=case when input_advance and next_index+1=total_items then case when mode='stage' then 'reviewed' else 'completed' end
   else coalesce(input_end_status,'running') end,error_message=input_error,
  lease_expires_at=case when input_end_status is not null or (input_advance and next_index+1=total_items) then now() else now()+interval '5 minutes' end,
  retry_attempts=case when input_advance then 0 when input_end_status='paused' and input_error is not null then retry_attempts+1 else retry_attempts end,
  retry_after=case when input_end_status='paused' and input_error is not null then now()+make_interval(secs=>least(900,30*power(2,retry_attempts)::integer)) else null end,
  updated_at=now() where id=j.id;
 return true;
end $$;

select pg_notify('pgrst','reload schema');
