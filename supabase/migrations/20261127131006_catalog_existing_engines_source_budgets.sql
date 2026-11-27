-- Conservative local caps for the existing manufacturer and distributor readers.
-- These are scheduling settings, not assumed upstream entitlements.
insert into public.catalog_source_request_budgets(source_group,min_spacing_ms,hourly_limit)
values ('bosch',2000,60),('delphi',2000,60),('denso',2000,60),
       ('knorr_bremse',2000,60),('mann',2000,60),('schaeffler',2000,60),
       ('skf',2000,60),('wilmink',2000,60),('zf',2000,60)
on conflict (source_group) do nothing;

create or replace function public.defer_catalog_brand_source_request(input_org uuid,input_job uuid,input_token uuid,input_retry_at timestamptz)
returns void language plpgsql security invoker set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_retry_at is null or input_retry_at>now()+interval '8 days' then raise exception 'Invalid source retry time'; end if;
  update public.catalog_brand_jobs set status='paused',retry_after=greatest(now()+interval '1 second',input_retry_at),
    lease_expires_at=now(),updated_at=now(),error_message='CATALOG_SOURCE_BUDGET_WAIT'
    where id=input_job and organization_id=input_org and status='running'
      and (mode='stage' or (mode='publish' and manifest->>'adapter'='spareto-reviewed-correction.v1'))
      and lease_token=input_token and lease_expires_at>now();
  if not found then raise exception 'Brand worker lease lost'; end if;
end $$;

alter table public.catalog_zf_jobs add column source_retry_after timestamptz;

do $migration$
declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('public.claim_catalog_zf_job(uuid,uuid)'::regprocedure);
  anchor:='where organization_id=input_org and id=input_job and (status=';
  if strpos(definition,anchor)=0 then raise exception 'ZF claim guard anchor missing'; end if;
  execute replace(definition,anchor,
    'where organization_id=input_org and id=input_job and (source_retry_after is null or source_retry_after<=now()) and (status=');
end $migration$;

create function public.defer_catalog_zf_source_request(input_org uuid,input_job uuid,input_token uuid,input_retry_at timestamptz)
returns void language plpgsql security invoker set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_retry_at is null or input_retry_at>now()+interval '8 days' then raise exception 'Invalid source retry time'; end if;
  update public.catalog_zf_jobs set status='paused',source_retry_after=greatest(now()+interval '1 second',input_retry_at),
    lease_expires_at=now(),updated_at=now(),error_message='CATALOG_SOURCE_BUDGET_WAIT'
    where id=input_job and organization_id=input_org and status='running' and mode='stage'
      and lease_token=input_token and lease_expires_at>now();
  if not found then raise exception 'ZF worker lease lost'; end if;
end $$;

create function public.defer_supplier_catalog_secondary_source_request(input_id uuid,input_token uuid,input_retry_at timestamptz)
returns void language plpgsql security definer set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_retry_at is null or input_retry_at>now()+interval '8 days' then raise exception 'Invalid source retry time'; end if;
  update supplier_price_ingestion_internal.catalog_secondary_reviews
    set status='retry_wait', next_attempt_at=greatest(clock_timestamp()+interval '1 second',input_retry_at),
        attempts=greatest(attempts-1,0),lease_token=null,lease_until=null,error_code='CATALOG_SOURCE_BUDGET_WAIT',updated_at=now()
    where id=input_id and status='running' and lease_token=input_token and lease_until>clock_timestamp();
  if not found then raise exception 'Supplier secondary worker lease lost'; end if;
end $$;

revoke all on function public.defer_catalog_zf_source_request(uuid,uuid,uuid,timestamptz),
 public.defer_supplier_catalog_secondary_source_request(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.defer_catalog_zf_source_request(uuid,uuid,uuid,timestamptz),
 public.defer_supplier_catalog_secondary_source_request(uuid,uuid,timestamptz) to service_role;
notify pgrst,'reload schema';
