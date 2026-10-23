-- Reuse current schema-v4 files during the version-contract transition as well.
-- Existing queued/running jobs retain their old reader and source fingerprint.
set local lock_timeout='5s';
set local statement_timeout='60s';
drop function public.admit_prepared_price_list_export(uuid,uuid,text,text,jsonb,text,text);

create function public.admit_prepared_price_list_export(
  input_organization_id uuid,input_requested_by uuid,input_audience text,
  input_export_type text,input_scope jsonb,input_cache_key text,input_data_version text,
  input_probe_only boolean default false,input_legacy_cache_key text default null,input_legacy_data_version text default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  j public.app_export_jobs%rowtype;
  artifact public.app_export_jobs%rowtype;
  p jsonb;
  parts jsonb;
  complete boolean;
  n timestamptz:=pg_catalog.clock_timestamp();
begin
  if input_scope->>'versionContract' is distinct from 'publication-v1'
    or input_scope->>'schemaVersion' is distinct from '4'
    or not ((input_audience='admin' and input_export_type='admin_price_list' and input_requested_by is not null)
      or (input_audience='portal' and input_export_type='portal_price_list' and input_requested_by is null))
    or coalesce(input_cache_key,'')='' or coalesce(input_data_version,'')='' then
    raise exception 'PREPARED_PRICE_ADMISSION_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(input_organization_id::text||':'||input_export_type||':'||input_cache_key,0));
  select * into j from public.app_export_jobs
  where organization_id=input_organization_id and export_type=input_export_type and audience=input_audience
    and cache_key=input_cache_key and data_version=input_data_version
    and scope->>'versionContract'='publication-v1' and status in('queued','running') and expires_at>n
  order by created_at desc limit 1;
  if found then return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(j),'cached',false); end if;

  select * into artifact from public.app_export_jobs
  where organization_id=input_organization_id and export_type=input_export_type and audience=input_audience
    and cache_key=input_cache_key and data_version=input_data_version
    and scope->>'versionContract'='publication-v1' and status='finalized'
  order by finalized_at desc limit 1;
  if artifact.id is null and input_probe_only then
    return pg_catalog.jsonb_build_object('needsLegacyProbe',true);
  end if;
  if artifact.id is null and input_legacy_cache_key is not null and input_legacy_data_version is not null then
    -- Adopt only an artifact whose old complete-source fingerprint still
    -- equals the current source. Never relabel an old or unverified workbook.
    if public.get_prepared_price_list_export_version(input_organization_id,(input_scope->>'brandId')::uuid)
      is distinct from input_scope->>'sourceVersion' then raise exception 'PREPARED_PRICE_SOURCE_CHANGED'; end if;
    select * into artifact from public.app_export_jobs
    where organization_id=input_organization_id and export_type=input_export_type and audience=input_audience
      and cache_key=input_legacy_cache_key and data_version=input_legacy_data_version
      and scope->>'schemaVersion'='4' and scope->>'versionContract' is null and status='finalized'
    order by finalized_at desc limit 1;
  end if;
  if artifact.id is not null then
    complete:=artifact.row_count>0 and artifact.progress_total=artifact.row_count
      and artifact.progress_done=artifact.row_count and artifact.byte_size>0
      and artifact.storage_bucket='app-exports' and artifact.file_name is not null and artifact.content_type is not null
      and artifact.storage_path like input_organization_id::text||'/%'
      and coalesce(artifact.progress_message,'') not ilike '%limited to%';
    parts:=coalesce(artifact.scope->'artifactParts',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('path',artifact.storage_path,'byteSize',artifact.byte_size)));
    if pg_catalog.jsonb_typeof(parts) is distinct from 'array' then complete:=false;
    elsif complete then
      for p in select value from pg_catalog.jsonb_array_elements(parts) loop
        if pg_catalog.jsonb_typeof(p->'byteSize') is distinct from 'number'
          or coalesce(p->>'byteSize','') !~ '^[1-9][0-9]*$'
          or coalesce(p->>'path','') not like input_organization_id::text||'/%'
          or not exists(select 1 from storage.objects o where o.bucket_id=artifact.storage_bucket
            and o.name=p->>'path' and o.metadata->>'size'=p->>'byteSize') then
          complete:=false; exit;
        end if;
      end loop;
      if parts->0->>'path' is distinct from artifact.storage_path
        or (select count(distinct value->>'path') from pg_catalog.jsonb_array_elements(parts))<>pg_catalog.jsonb_array_length(parts)
        then complete:=false; end if;
      if complete and (select sum((value->>'byteSize')::bigint) from pg_catalog.jsonb_array_elements(parts)) is distinct from artifact.byte_size::bigint
        or pg_catalog.jsonb_array_length(parts)=0 then complete:=false; end if;
    end if;
    if complete then
      if artifact.expires_at>n and artifact.scope->>'versionContract'='publication-v1' then return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(artifact),'cached',true); end if;
      -- Fresh access receipt, same already-verified bytes. Preserve the old
      -- receipt and short-lived signed-link expiry; never make the bucket public.
      insert into public.app_export_jobs(organization_id,requested_by,audience,export_type,status,scope,cache_key,data_version,
        file_name,content_type,storage_bucket,storage_path,row_count,byte_size,progress_total,progress_done,progress_message,finalized_at,expires_at)
      values(input_organization_id,input_requested_by,input_audience,input_export_type,'finalized',input_scope||case when artifact.scope?'artifactParts' then pg_catalog.jsonb_build_object('artifactParts',artifact.scope->'artifactParts') else '{}'::jsonb end,input_cache_key,input_data_version,
        artifact.file_name,artifact.content_type,artifact.storage_bucket,artifact.storage_path,artifact.row_count,artifact.byte_size,
        artifact.row_count,artifact.row_count,'Prepared price file reused.',n,n+interval '7 days') returning * into j;
      return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(j),'cached',true);
    end if;
  end if;
  insert into public.app_export_jobs(organization_id,requested_by,audience,export_type,scope,cache_key,data_version,expires_at,progress_message)
  values(input_organization_id,input_requested_by,input_audience,input_export_type,input_scope,input_cache_key,input_data_version,n+interval '7 days','Preparing published price file.') returning * into j;
  return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(j),'cached',false);
end;
$fn$;
revoke all on function public.admit_prepared_price_list_export(uuid,uuid,text,text,jsonb,text,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.admit_prepared_price_list_export(uuid,uuid,text,text,jsonb,text,text,boolean,text,text) to service_role;


-- Queue the same durable profiles when legacy prices, identity/lifecycle or
-- replacement references change. No HTTP or file generation in a DB trigger.
create or replace function public.queue_prepared_price_profiles()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare org uuid; brand uuid;
begin
  if tg_op='DELETE' then org:=old.organization_id; else org:=new.organization_id; end if;
  if tg_table_name in('supplier_current_price_pointers','supplier_price_source_versions',
    'prepared_price_catalog_versions','item_code_references','supplier_price_publications') then
    if tg_op='DELETE' then brand:=old.brand_id; else brand:=new.brand_id; end if;
  end if;
  update public.prepared_price_export_profiles set next_check_at='epoch',revision=revision+1
  where organization_id=org and (brand is null or brand_id=brand);
  return null;
end;
$fn$;
create trigger queue_prepared_legacy_price after insert or update on public.supplier_price_source_versions
for each row execute function public.queue_prepared_price_profiles();
create trigger queue_prepared_catalog_identity after insert or update on public.prepared_price_catalog_versions
for each row execute function public.queue_prepared_price_profiles();
create trigger queue_prepared_replacement after insert or update or delete on public.item_code_references
for each row execute function public.queue_prepared_price_profiles();
create trigger queue_prepared_publication_status after update of status on public.supplier_price_publications
for each row execute function public.queue_prepared_price_profiles();
