-- Serialize admission by actual commercial scope, not by customer identity.
-- Each follower remains an independent tenant/invite-scoped job receipt.
create function public.admit_shared_portal_price_work(input_organization_id uuid,input_scope jsonb,input_cache_key text,input_data_version text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare own public.app_export_jobs%rowtype; leader public.app_export_jobs%rowtype; follower public.app_export_jobs%rowtype; shared jsonb;
  n timestamptz:=pg_catalog.clock_timestamp();
begin
  if input_scope->>'versionContract' is distinct from 'publication-v1' or input_scope->>'schemaVersion' is distinct from '4'
    or coalesce(input_scope->>'inviteId','')='' or coalesce(input_scope->>'customerId','')=''
    or coalesce(input_scope->>'brandId','')='' or coalesce(input_scope->>'sourceVersion','')=''
    or coalesce(input_cache_key,'')='' or coalesce(input_data_version,'')=''
    or coalesce(input_scope->>'priceListType','') not in ('A','B','Other') or input_scope->>'currency' is distinct from 'EUR'
    or input_scope->>'format' is distinct from 'xlsx'
    or pg_catalog.jsonb_typeof(input_scope->'marginPercent') is distinct from 'number'
    or input_scope?'sharedLeaderJobId' then raise exception 'SHARED_PRICE_SCOPE_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(input_organization_id,input_scope->>'brandId',input_scope->>'brandName',input_scope->>'sourceVersion',
      input_scope->>'priceListType',input_scope->'marginPercent',input_scope->>'currency',input_scope->>'format',input_scope->>'schemaVersion')::text,0));
  if public.get_prepared_price_list_export_version(input_organization_id,(input_scope->>'brandId')::uuid)
    is distinct from input_scope->>'sourceVersion' then raise exception 'PREPARED_PRICE_SOURCE_CHANGED'; end if;
  select * into own from public.app_export_jobs x where x.organization_id=input_organization_id and x.audience='portal'
    and x.export_type='portal_price_list' and x.cache_key=input_cache_key and x.data_version=input_data_version
    and x.status in ('queued','running','finalized') and x.expires_at>n order by x.created_at desc limit 1;
  if own.id is not null then
    if own.status='finalized' then return public.admit_prepared_price_list_export(input_organization_id,null,'portal','portal_price_list',input_scope,input_cache_key,input_data_version,true); end if;
    return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(own),'cached',false);
  end if;
  shared:=public.adopt_shared_portal_price_artifact(input_organization_id,input_scope,input_cache_key,input_data_version);
  if shared is not null then return shared; end if;
  select * into leader from public.app_export_jobs x where x.organization_id=input_organization_id and x.audience='portal'
    and x.export_type='portal_price_list' and x.status in ('queued','running') and x.expires_at>n
    and not (x.scope?'sharedLeaderJobId') and x.scope->>'versionContract'='publication-v1'
    and x.scope->>'schemaVersion'='4' and x.scope->>'brandId'=input_scope->>'brandId'
    and x.scope->>'brandName'=input_scope->>'brandName' and x.scope->>'sourceVersion'=input_scope->>'sourceVersion'
    and x.scope->>'priceListType'=input_scope->>'priceListType' and x.scope->'marginPercent'=input_scope->'marginPercent'
    and x.scope->>'currency'=input_scope->>'currency' and x.scope->>'format'=input_scope->>'format'
    order by x.created_at,x.id limit 1 for update;
  if leader.id is null then
    -- A worker may have finalized between the first probe and row locking.
    shared:=public.adopt_shared_portal_price_artifact(input_organization_id,input_scope,input_cache_key,input_data_version);
    if shared is not null then return shared; end if;
    insert into public.app_export_jobs(organization_id,requested_by,audience,export_type,scope,cache_key,data_version,expires_at,progress_message)
    values(input_organization_id,null,'portal','portal_price_list',input_scope,input_cache_key,input_data_version,n+interval '7 days','Preparing published price file.') returning * into own;
    return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(own),'cached',false);
  end if;
  insert into public.app_export_jobs(organization_id,requested_by,audience,export_type,scope,cache_key,data_version,expires_at,progress_message)
  values(input_organization_id,null,'portal','portal_price_list',input_scope||pg_catalog.jsonb_build_object('sharedLeaderJobId',leader.id),input_cache_key,input_data_version,n+interval '7 days','Waiting for shared price file.') returning * into follower;
  return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(follower),'cached',false);
end;
$fn$;
revoke all on function public.admit_shared_portal_price_work(uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.admit_shared_portal_price_work(uuid,jsonb,text,text) to service_role;

-- The final worker update and its followers commit together. A failed leader
-- cannot leave followers waiting forever; a changed source cannot be adopted.
create function public.finish_shared_portal_price_followers() returns trigger language plpgsql security definer set search_path='' as $fn$
declare valid_source boolean;
begin
  if new.audience<>'portal' or new.export_type<>'portal_price_list' or new.scope?'sharedLeaderJobId'
    or new.status not in ('finalized','failed','expired') or new.status is not distinct from old.status then return null; end if;
  if not exists(select 1 from public.app_export_jobs f where f.organization_id=new.organization_id
    and f.audience='portal' and f.export_type='portal_price_list' and f.scope->>'sharedLeaderJobId'=new.id::text
    and f.status in ('queued','running')) then return null; end if;
  if new.status='finalized' then
    valid_source:=public.get_prepared_price_list_export_version(new.organization_id,(new.scope->>'brandId')::uuid)=new.scope->>'sourceVersion';
    if coalesce(valid_source,false) and new.row_count>0 and new.progress_done=new.row_count and new.progress_total=new.row_count
      and new.byte_size>0 and new.file_name is not null and new.content_type is not null
      and new.storage_bucket='app-exports' and new.storage_path like new.organization_id::text||'/%' then
      update public.app_export_jobs f set status='finalized',file_name=new.file_name,content_type=new.content_type,
        storage_bucket=new.storage_bucket,storage_path=new.storage_path,row_count=new.row_count,byte_size=new.byte_size,
        progress_done=new.row_count,progress_total=new.row_count,progress_message='Prepared price file shared.',finalized_at=pg_catalog.clock_timestamp(),
        scope=f.scope||case when new.scope?'artifactParts' then pg_catalog.jsonb_build_object('artifactParts',new.scope->'artifactParts') else '{}'::jsonb end
      where f.organization_id=new.organization_id and f.audience='portal' and f.export_type='portal_price_list'
        and f.scope->>'sharedLeaderJobId'=new.id::text and f.status in ('queued','running');
      return null;
    end if;
  end if;
  update public.app_export_jobs f set status='failed',failed_at=pg_catalog.clock_timestamp(),
    error_message='Shared price file could not be prepared. Please retry.',progress_message='Shared price file failed.'
  where f.organization_id=new.organization_id and f.audience='portal' and f.export_type='portal_price_list'
    and f.scope->>'sharedLeaderJobId'=new.id::text and f.status in ('queued','running');
  return null;
end;
$fn$;
revoke all on function public.finish_shared_portal_price_followers() from public,anon,authenticated,service_role;
create trigger finish_shared_portal_price_followers after update of status on public.app_export_jobs
for each row execute function public.finish_shared_portal_price_followers();

-- Resolve expired/deleted/crashed leader cases without stranding a customer
-- behind a queued follower for the full seven-day receipt lifetime.
create function public.fail_orphan_shared_portal_follower(input_organization_id uuid,input_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare j public.app_export_jobs%rowtype;
begin
  update public.app_export_jobs f set status='failed',failed_at=pg_catalog.clock_timestamp(),
    error_message='Shared price file could not be prepared. Please retry.',progress_message='Shared price file failed.'
  where f.id=input_job_id and f.organization_id=input_organization_id and f.audience='portal' and f.export_type='portal_price_list'
    and f.status in ('queued','running') and f.scope?'sharedLeaderJobId'
    and not exists(select 1 from public.app_export_jobs p where p.id::text=f.scope->>'sharedLeaderJobId'
      and p.organization_id=f.organization_id and p.status in ('queued','running') and p.expires_at>pg_catalog.clock_timestamp())
  returning * into j;
  if j.id is null then return null; end if;
  return pg_catalog.to_jsonb(j);
end;
$fn$;
revoke all on function public.fail_orphan_shared_portal_follower(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fail_orphan_shared_portal_follower(uuid,uuid) to service_role;
