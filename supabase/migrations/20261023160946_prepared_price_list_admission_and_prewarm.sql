-- Serialize admission by exact tenant/profile/version. An access receipt may
-- expire; the immutable private workbook does not expire merely with time.
set local lock_timeout='5s';
set local statement_timeout='60s';
create function public.admit_prepared_price_list_export(
  input_organization_id uuid,input_requested_by uuid,input_audience text,
  input_export_type text,input_scope jsonb,input_cache_key text,input_data_version text
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
  if found then
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
      if artifact.expires_at>n then return pg_catalog.jsonb_build_object('job',pg_catalog.to_jsonb(artifact),'cached',true); end if;
      -- Fresh access receipt, same already-verified bytes. Preserve the old
      -- receipt and short-lived signed-link expiry; never make the bucket public.
      insert into public.app_export_jobs(organization_id,requested_by,audience,export_type,status,scope,cache_key,data_version,
        file_name,content_type,storage_bucket,storage_path,row_count,byte_size,progress_total,progress_done,progress_message,finalized_at,expires_at)
      values(input_organization_id,input_requested_by,input_audience,input_export_type,'finalized',artifact.scope,input_cache_key,input_data_version,
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
revoke all on function public.admit_prepared_price_list_export(uuid,uuid,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.admit_prepared_price_list_export(uuid,uuid,text,text,jsonb,text,text) to service_role;

-- Persist the profiles users actually request, not every possible margin.
-- All worker starts still resolve current actor/invite/pricing authority.
create table public.prepared_price_export_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_key text not null,
  brand_id uuid not null references public.brands(id) on delete cascade,
  seed_job_id uuid not null references public.app_export_jobs(id) on delete cascade,
  next_check_at timestamptz not null default now(),
  revision bigint not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_checked_at timestamptz,
  last_error_code text,
  unique(organization_id,profile_key)
);
create index idx_prepared_price_profiles_due on public.prepared_price_export_profiles(next_check_at);
create index idx_prepared_price_profiles_brand on public.prepared_price_export_profiles(organization_id,brand_id);
alter table public.prepared_price_export_profiles enable row level security;
revoke all on public.prepared_price_export_profiles from public,anon,authenticated,service_role;
grant select on public.prepared_price_export_profiles to service_role;

create function public.prepared_price_profile_key(j public.app_export_jobs)
returns text language sql immutable set search_path='' as $fn$
select pg_catalog.md5(pg_catalog.jsonb_build_array(j.audience,j.scope->>'brandId',
  case when j.audience='portal' then j.scope->>'inviteId' else j.requested_by::text end,
  case when j.audience='admin' then j.scope->>'priceListType' end,
  case when j.audience='admin' then j.scope->>'marginPercent' end)::text);
$fn$;
revoke all on function public.prepared_price_profile_key(public.app_export_jobs) from public,anon,authenticated,service_role;

create function public.register_prepared_price_profile()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if new.export_type not in('admin_price_list','portal_price_list') or new.scope->>'schemaVersion' is distinct from '4'
    or coalesce(new.scope->>'priceListType','') not in('A','B','Other') then return null; end if;
  insert into public.prepared_price_export_profiles(organization_id,profile_key,brand_id,seed_job_id,next_check_at)
  values(new.organization_id,public.prepared_price_profile_key(new),(new.scope->>'brandId')::uuid,new.id,pg_catalog.clock_timestamp()+interval '15 minutes')
  on conflict(organization_id,profile_key) do update set seed_job_id=excluded.seed_job_id;
  return null;
end;
$fn$;
revoke all on function public.register_prepared_price_profile() from public,anon,authenticated,service_role;
create trigger register_prepared_price_profile after insert on public.app_export_jobs
for each row execute function public.register_prepared_price_profile();

-- Bootstrap current, previously requested profiles. No publication or file is
-- changed here; background admission is bounded to one cold job at a time.
insert into public.prepared_price_export_profiles(organization_id,profile_key,brand_id,seed_job_id)
select distinct on(j.organization_id,public.prepared_price_profile_key(j))
  j.organization_id,public.prepared_price_profile_key(j),(j.scope->>'brandId')::uuid,j.id
from public.app_export_jobs j join public.brands b on b.id::text=j.scope->>'brandId' and b.organization_id=j.organization_id
where j.export_type in('admin_price_list','portal_price_list') and j.scope->>'schemaVersion'='4'
  and j.scope->>'priceListType' in('A','B','Other') and j.created_at>now()-interval '30 days'
order by j.organization_id,public.prepared_price_profile_key(j),j.created_at desc;

create function public.queue_prepared_price_profiles()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare org uuid; brand uuid;
begin
  if tg_op='DELETE' then org:=old.organization_id; else org:=new.organization_id; end if;
  if tg_table_name='supplier_current_price_pointers' then
    if tg_op='DELETE' then brand:=old.brand_id; else brand:=new.brand_id; end if;
  end if;
  update public.prepared_price_export_profiles set next_check_at='epoch',revision=revision+1
  where organization_id=org and (brand is null or brand_id=brand);
  return null;
end;
$fn$;
revoke all on function public.queue_prepared_price_profiles() from public,anon,authenticated,service_role;
create trigger queue_prepared_price_publication after insert or update or delete on public.supplier_current_price_pointers
for each row execute function public.queue_prepared_price_profiles();
create trigger queue_prepared_customer_pricing after update of price_list_type,price_list_margin_percent,currency,custom_fields on public.customers
for each row execute function public.queue_prepared_price_profiles();
create trigger queue_prepared_list_pricing after insert or update or delete on public.customer_price_lists
for each row execute function public.queue_prepared_price_profiles();
create trigger queue_prepared_invite_scope after update of status,customer_id,access_can_view_orders,allowed_brand_ids,expires_at,seller_company_profile_id on public.portal_invites
for each row execute function public.queue_prepared_price_profiles();

create function public.claim_prepared_price_profile()
returns setof public.prepared_price_export_profiles language plpgsql security definer set search_path='' as $fn$
declare p public.prepared_price_export_profiles%rowtype;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('prepared-price-prewarm',0)) then return; end if;
  if exists(select 1 from public.prepared_price_export_profiles where lease_expires_at>pg_catalog.clock_timestamp()) then return; end if;
  -- Never compete with a user's active generation or fan out a cold cache.
  if exists(select 1 from public.app_export_jobs where export_type in('admin_price_list','portal_price_list')
    and status in('queued','running') and expires_at>pg_catalog.clock_timestamp()) then return; end if;
  select * into p from public.prepared_price_export_profiles
  where next_check_at<=pg_catalog.clock_timestamp()
    and (lease_expires_at is null or lease_expires_at<=pg_catalog.clock_timestamp())
  order by next_check_at,id for update skip locked limit 1;
  if not found then return; end if;
  update public.prepared_price_export_profiles set lease_token=gen_random_uuid(),lease_expires_at=pg_catalog.clock_timestamp()+interval '5 minutes'
  where id=p.id returning * into p;
  return next p;
end;
$fn$;
create function public.finish_prepared_price_profile(input_id uuid,input_lease_token uuid,input_revision bigint,input_error_code text default null)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
  update public.prepared_price_export_profiles set
    next_check_at=case when revision<>input_revision then 'epoch'::timestamptz
      else pg_catalog.clock_timestamp()+interval '15 minutes' end,
    last_checked_at=pg_catalog.clock_timestamp(),last_error_code=input_error_code,lease_token=null,lease_expires_at=null
  where id=input_id and lease_token=input_lease_token;
  return found;
end;
$fn$;
revoke all on function public.claim_prepared_price_profile(),public.finish_prepared_price_profile(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.claim_prepared_price_profile(),public.finish_prepared_price_profile(uuid,uuid,bigint,text) to service_role;
