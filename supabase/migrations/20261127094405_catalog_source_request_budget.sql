create table public.catalog_source_request_budgets (
  source_group text primary key check (source_group ~ '^[a-z][a-z0-9_]{0,62}$'),
  min_spacing_ms integer not null check (min_spacing_ms between 100 and 60000),
  hourly_limit integer not null check (hourly_limit between 1 and 36000),
  window_start timestamptz not null default date_trunc('hour', now(), 'UTC'),
  requests_used integer not null default 0 check (requests_used >= 0),
  next_request_at timestamptz not null default now(),
  cooldown_until timestamptz not null default now()
);
alter table public.catalog_source_request_budgets enable row level security;
revoke all on public.catalog_source_request_budgets from public, anon, authenticated;
grant select, update on public.catalog_source_request_budgets to service_role;

-- Group by upstream quota, across brands, jobs and organizations.
insert into public.catalog_source_request_budgets(source_group,min_spacing_ms,hourly_limit)
values ('tecalliance',2000,180), ('spareto',2000,60);

create function public.acquire_catalog_source_request(input_group text)
returns jsonb language plpgsql security invoker set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
declare
  budget public.catalog_source_request_budgets%rowtype;
  current_time_value timestamptz;
  hour_start timestamptz;
  retry_at timestamptz;
  used integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select * into strict budget from public.catalog_source_request_budgets
    where source_group=input_group for update;
  current_time_value:=clock_timestamp();
  hour_start:=date_trunc('hour',current_time_value,'UTC');
  used:=case when budget.window_start=hour_start then budget.requests_used else 0 end;
  retry_at:=greatest(budget.next_request_at,budget.cooldown_until,
    case when used>=budget.hourly_limit then hour_start+interval '1 hour' end);
  if retry_at>current_time_value then
    return jsonb_build_object('granted',false,'retryAt',retry_at,
      'retryAfterMs',ceil(extract(epoch from (retry_at-current_time_value))*1000)::bigint);
  end if;
  update public.catalog_source_request_budgets set
    window_start=hour_start, requests_used=used+1,
    next_request_at=current_time_value+budget.min_spacing_ms*interval '1 millisecond'
    where source_group=input_group;
  return jsonb_build_object('granted',true);
end $$;

create function public.cooldown_catalog_source_requests(input_group text,input_seconds integer)
returns jsonb language plpgsql security invoker set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
declare
  current_time_value timestamptz:=clock_timestamp();
  retry_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_seconds is null or input_seconds not between 30 and 604800 then
    raise exception 'Invalid source cooldown';
  end if;
  update public.catalog_source_request_budgets set cooldown_until=greatest(cooldown_until,current_time_value+make_interval(secs=>input_seconds))
    where source_group=input_group returning cooldown_until into strict retry_at;
  return jsonb_build_object('retryAt',retry_at);
end $$;

create function public.defer_catalog_brand_source_request(input_org uuid,input_job uuid,input_token uuid,input_retry_at timestamptz)
returns void language plpgsql security invoker set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_retry_at is null or input_retry_at>now()+interval '8 days' then raise exception 'Invalid source retry time'; end if;
  -- Keep the existing item and its cursor intact, with no transport retry spent.
  update public.catalog_brand_jobs set status='paused', retry_after=greatest(now()+interval '1 second',input_retry_at),
    lease_expires_at=now(), updated_at=now(), error_message='CATALOG_SOURCE_BUDGET_WAIT'
    where id=input_job and organization_id=input_org and status='running' and mode='stage'
      and lease_token=input_token and lease_expires_at>now();
  if not found then raise exception 'Brand worker lease lost'; end if;
end $$;

revoke all on function public.acquire_catalog_source_request(text),public.cooldown_catalog_source_requests(text,integer),
  public.defer_catalog_brand_source_request(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.acquire_catalog_source_request(text),public.cooldown_catalog_source_requests(text,integer),
  public.defer_catalog_brand_source_request(uuid,uuid,uuid,timestamptz) to service_role;
notify pgrst,'reload schema';
