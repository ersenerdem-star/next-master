-- A workbook contains no customer fields; the portal pricing page is scoped by
-- tenant, brand, list type, margin and currency. Issue a separate receipt for
-- each invite, never return another customer's job or change existing bytes.
create function public.adopt_shared_portal_price_artifact(
  input_organization_id uuid,input_scope jsonb,input_cache_key text,input_data_version text
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare a public.app_export_jobs%rowtype; j public.app_export_jobs%rowtype;
  parts jsonb; part jsonb; valid boolean; n timestamptz:=pg_catalog.clock_timestamp();
begin
  if input_scope->>'versionContract'<>'publication-v1' or input_scope->>'schemaVersion'<>'4'
     or coalesce(input_scope->>'inviteId','')='' or coalesce(input_scope->>'customerId','')=''
     or coalesce(input_scope->>'brandId','')='' or coalesce(input_scope->>'sourceVersion','')=''
     or coalesce(input_cache_key,'')='' or coalesce(input_data_version,'')=''
     or input_scope->>'priceListType' not in ('A','B','Other') or input_scope->>'currency'<>'EUR'
     or pg_catalog.jsonb_typeof(input_scope->'marginPercent')<>'number' then
    raise exception 'SHARED_PRICE_SCOPE_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(input_organization_id::text||':portal_price_list:'||input_cache_key,0));
  if public.get_prepared_price_list_export_version(input_organization_id,(input_scope->>'brandId')::uuid)
    is distinct from input_scope->>'sourceVersion' then raise exception 'PREPARED_PRICE_SOURCE_CHANGED'; end if;
  -- Never create a competing receipt while this customer's own job exists.
  if exists(select 1 from public.app_export_jobs x where x.organization_id=input_organization_id
    and x.audience='portal' and x.export_type='portal_price_list' and x.cache_key=input_cache_key
    and x.data_version=input_data_version and x.status in ('queued','running','finalized') and x.expires_at>n) then return null; end if;
  select * into a from public.app_export_jobs x where x.organization_id=input_organization_id
    and x.audience='portal' and x.export_type='portal_price_list' and x.status='finalized'
    and x.scope->>'versionContract'='publication-v1' and x.scope->>'schemaVersion'='4'
    and x.scope->>'brandId'=input_scope->>'brandId' and x.scope->>'brandName'=input_scope->>'brandName'
    and x.scope->>'sourceVersion'=input_scope->>'sourceVersion'
    and x.scope->>'priceListType'=input_scope->>'priceListType' and x.scope->>'currency'=input_scope->>'currency'
    and x.scope->'marginPercent'=input_scope->'marginPercent' and x.scope->>'format'='xlsx'
    and x.row_count>0 and x.progress_total=x.row_count and x.progress_done=x.row_count and x.byte_size>0
    and x.storage_bucket='app-exports' and x.file_name is not null and x.content_type is not null
    and x.storage_path like input_organization_id::text||'/%'
    and coalesce(x.progress_message,'') not ilike '%limited to%'
    order by x.finalized_at desc nulls last,x.created_at desc limit 1;
  if a.id is null then return null; end if;
  parts:=coalesce(a.scope->'artifactParts',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('path',a.storage_path,'byteSize',a.byte_size)));
  valid:=coalesce(pg_catalog.jsonb_typeof(parts)='array',false);
  if valid then
    if pg_catalog.jsonb_array_length(parts)=0 or parts->0->>'path' is distinct from a.storage_path then valid:=false; end if;
    for part in select value from pg_catalog.jsonb_array_elements(parts) loop
      if pg_catalog.jsonb_typeof(part->'byteSize') is distinct from 'number'
        or coalesce(part->>'byteSize','') !~ '^[1-9][0-9]*$'
        or coalesce(part->>'path','') not like input_organization_id::text||'/%'
        or not exists(select 1 from storage.objects o where o.bucket_id=a.storage_bucket and o.name=part->>'path' and o.metadata->>'size'=part->>'byteSize') then valid:=false; exit; end if;
    end loop;
    if (select count(distinct value->>'path') from pg_catalog.jsonb_array_elements(parts))<>pg_catalog.jsonb_array_length(parts)
      or (select sum((value->>'byteSize')::numeric) from pg_catalog.jsonb_array_elements(parts)) is distinct from a.byte_size::numeric then valid:=false; end if;
  end if;
  if not valid then return null; end if;
  insert into public.app_export_jobs(organization_id,requested_by,audience,export_type,status,scope,cache_key,data_version,
    file_name,content_type,storage_bucket,storage_path,row_count,byte_size,progress_total,progress_done,progress_message,finalized_at,expires_at)
  values(input_organization_id,null,'portal','portal_price_list','finalized',input_scope||case when a.scope?'artifactParts' then pg_catalog.jsonb_build_object('artifactParts',a.scope->'artifactParts') else '{}'::jsonb end,input_cache_key,input_data_version,
    a.file_name,a.content_type,a.storage_bucket,a.storage_path,a.row_count,a.byte_size,a.row_count,a.row_count,'Prepared price file shared.',n,n+interval '7 days') returning * into j;
  return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(j),'cached',true);
end;
$fn$;
revoke all on function public.adopt_shared_portal_price_artifact(uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.adopt_shared_portal_price_artifact(uuid,jsonb,text,text) to service_role;
