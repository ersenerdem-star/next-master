create table public.catalog_monroe_discovery_cursor (
  organization_id uuid primary key references public.organizations(id),
  created_by uuid not null references public.profiles(id),
  enabled boolean not null default false,
  prefix_index integer not null default 1 check (prefix_index between 1 and 36),
  page integer not null default 1 check (page between 1 and 200),
  next_at timestamptz not null default now(),
  job_id uuid,
  foreign key (job_id, organization_id) references public.catalog_brand_jobs(id, organization_id)
);
alter table public.catalog_monroe_discovery_cursor enable row level security;
revoke all on public.catalog_monroe_discovery_cursor from public, anon, authenticated;
grant select, insert, update on public.catalog_monroe_discovery_cursor to service_role;

create index catalog_monroe_discovery_review_jobs
  on public.catalog_brand_jobs (organization_id)
  where manifest->>'adapter' = 'monroe-discovered-products.v1';

create function public.admit_catalog_monroe_discovery()
returns uuid language plpgsql security invoker set search_path = ''
set lock_timeout = '250ms' set statement_timeout = '3s' as $$
declare
  cursor_row public.catalog_monroe_discovery_cursor%rowtype;
  new_job uuid;
  prefix text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select c.* into cursor_row
  from public.catalog_monroe_discovery_cursor c
  join public.catalog_external_sources s on s.organization_id=c.organization_id and s.source_key='tecalliance_monroe'
  join public.profiles p on p.id=c.created_by and p.organization_id=c.organization_id
  where c.enabled and c.next_at<=now() and p.is_active and p.role='superadmin'
    and s.is_active and s.license_posture in ('allowed','internal_review_required')
    and s.credential_boundary='none' and s.rate_limit_posture='bounded' and s.robots_posture='allowed'
    and s.metadata->>'brand_engine_read_allowed'='true' and s.metadata->'allowed_brands' ? 'Monroe'
    and exists(select 1 from public.brands b where b.organization_id=c.organization_id and b.name='Monroe')
    and (c.job_id is null or exists (
      select 1 from public.catalog_brand_jobs j where j.id=c.job_id and j.status='failed'
    ))
  order by c.next_at, c.organization_id limit 1 for update of c skip locked;
  if not found then return null; end if;
  prefix:=substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',cursor_row.prefix_index,1);
  insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items)
  values (cursor_row.organization_id,cursor_row.created_by,gen_random_uuid(),jsonb_build_object(
    'adapter','monroe-official-discovery.v1','brand','Monroe','source_key','tecalliance_monroe',
    'prefix',prefix,'page',cursor_row.page),1) returning id into new_job;
  insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)
  values (new_job,cursor_row.organization_id,0,'MONROE-PAGE-'||prefix||'-'||cursor_row.page);
  update public.catalog_monroe_discovery_cursor set job_id=new_job,next_at=now()+interval '24 hours'
  where organization_id=cursor_row.organization_id;
  return new_job;
end $$;

create function public.complete_catalog_monroe_discovery(input_org uuid,input_job uuid,input_token uuid,input_page jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
set lock_timeout = '250ms' set statement_timeout = '5s' as $$
declare
  cursor_row public.catalog_monroe_discovery_cursor%rowtype;
  scan_job public.catalog_brand_jobs%rowtype;
  brand_id_value uuid;
  prefix text;
  last_page integer;
  codes jsonb;
  review_job jsonb;
  receipt jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select c.* into cursor_row from public.catalog_monroe_discovery_cursor c
  where c.organization_id=input_org and c.job_id=input_job and c.enabled for update;
  if not found then raise exception 'MONROE_DISCOVERY_CURSOR_CHANGED'; end if;
  select j.* into scan_job from public.catalog_brand_jobs j
  where j.id=input_job and j.organization_id=input_org and j.lease_token=input_token and j.lease_expires_at>now()
    and j.mode='stage' and j.status='running' and j.next_index=0 and j.total_items=1
    and j.manifest->>'adapter'='monroe-official-discovery.v1' and j.manifest->>'brand'='Monroe'
    and j.manifest->>'source_key'='tecalliance_monroe' for update;
  if not found then raise exception 'MONROE_DISCOVERY_LEASE_CHANGED'; end if;
  select b.id into strict brand_id_value from public.brands b where b.organization_id=input_org and b.name='Monroe';
  prefix:=substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',cursor_row.prefix_index,1);
  if input_page->>'prefix' is distinct from prefix or scan_job.manifest->>'prefix' is distinct from prefix
    or input_page->>'page' is distinct from cursor_row.page::text
    or scan_job.manifest->>'page' is distinct from cursor_row.page::text
    or coalesce(input_page->>'lastPage','') !~ '^[0-9]{1,3}$'
    or coalesce(input_page->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(input_page->'codes') is distinct from 'array' then
    raise exception 'MONROE_DISCOVERY_RECEIPT_INVALID';
  end if;
  last_page:=(input_page->>'lastPage')::integer;
  if last_page>200 or jsonb_array_length(input_page->'codes')>100 or exists (
    select 1 from jsonb_array_elements(input_page->'codes') source(code)
    where jsonb_typeof(source.code)<>'string' or source.code#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,99}$'
       or upper(left(source.code#>>'{}',1))<>prefix
  ) then raise exception 'MONROE_DISCOVERY_RECEIPT_INVALID'; end if;

  with page_codes as (
    select code,upper(regexp_replace(code,'[^A-Za-z0-9]','','g')) as normalized
    from (select distinct value as code from jsonb_array_elements_text(input_page->'codes')) exact
  ), unique_codes as (
    select min(code) code,normalized from page_codes group by normalized having count(*)=1
  ), queued as (
    select upper(regexp_replace(i.product_code,'[^A-Za-z0-9]','','g')) normalized
    from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id
    where j.organization_id=input_org and j.manifest->>'adapter'='monroe-discovered-products.v1'
  )
  select jsonb_agg(c.code order by c.code) into codes from unique_codes c
  where not exists(select 1 from queued q where q.normalized=c.normalized)
    and not exists(select 1 from public.catalog_products p
      where p.organization_id=input_org and p.brand_id=brand_id_value and p.normalized_code=c.normalized);

  if codes is not null then
    review_job:=public.start_catalog_brand_job(input_org,scan_job.created_by,codes,'Monroe',input_job,'tecalliance_monroe');
    update public.catalog_brand_jobs
      set manifest=manifest||jsonb_build_object('adapter','monroe-discovered-products.v1','discovery_job',input_job)
      where id=(review_job->>'id')::uuid and organization_id=input_org;
  end if;
  receipt:=jsonb_build_object('status','reviewed','discovered',coalesce(jsonb_array_length(codes),0),'articleJob',review_job->>'id',
    'skipped',jsonb_array_length(input_page->'codes')-coalesce(jsonb_array_length(codes),0));
  perform public.checkpoint_catalog_brand_job(input_org,input_job,input_token,0,input_page,receipt,'reviewed',null,true,null);
  update public.catalog_monroe_discovery_cursor
    set job_id=null,
        page=case when cursor_row.page<last_page then cursor_row.page+1 else 1 end,
        prefix_index=case when cursor_row.page<last_page then cursor_row.prefix_index else cursor_row.prefix_index%36+1 end,
        next_at=now()+case when cursor_row.prefix_index=36 and cursor_row.page>=last_page then interval '7 days' else interval '15 minutes' end
    where organization_id=input_org;
  return receipt;
end $$;

revoke all on function public.admit_catalog_monroe_discovery(), public.complete_catalog_monroe_discovery(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.admit_catalog_monroe_discovery(), public.complete_catalog_monroe_discovery(uuid,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
