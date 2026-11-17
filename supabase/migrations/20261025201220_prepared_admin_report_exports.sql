-- Keep the large admin comparison and supplier-buy-price workbooks warm after
-- they have been requested once. The first request still owns the immediate
-- generation; later refreshes are serialized by the scheduled worker.
create table public.prepared_admin_export_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_key text not null,
  export_type text not null check (export_type in ('catalog_master','supplier_price_list')),
  brand_id uuid not null references public.brands(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete cascade,
  seed_job_id uuid not null references public.app_export_jobs(id) on delete cascade,
  next_check_at timestamptz not null default now(),
  revision bigint not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_checked_at timestamptz,
  last_error_code text,
  unique (organization_id, profile_key)
);
create index idx_prepared_admin_exports_due on public.prepared_admin_export_profiles(next_check_at);
create index idx_prepared_admin_exports_brand on public.prepared_admin_export_profiles(organization_id,brand_id);
alter table public.prepared_admin_export_profiles enable row level security;
revoke all on public.prepared_admin_export_profiles from public,anon,authenticated,service_role;
grant select on public.prepared_admin_export_profiles to service_role;

create function public.prepared_admin_export_profile_key(j public.app_export_jobs)
returns text language sql immutable set search_path='' as $fn$
select pg_catalog.md5(pg_catalog.jsonb_build_array(
  j.export_type, j.organization_id::text, j.scope->>'brandId',
  j.scope->>'supplierId', j.scope->>'search', j.scope->>'freshness',
  j.scope->>'scope', j.scope->>'marginA', j.scope->>'marginB', j.scope->>'marketSegment', j.scope->>'format'
)::text);
$fn$;
revoke all on function public.prepared_admin_export_profile_key(public.app_export_jobs) from public,anon,authenticated,service_role;

create function public.register_prepared_admin_export_profile()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if new.audience <> 'admin' or new.export_type not in ('catalog_master','supplier_price_list')
    or coalesce(new.scope->>'brandId','')='' then return null; end if;
  insert into public.prepared_admin_export_profiles(
    organization_id,profile_key,export_type,brand_id,supplier_id,seed_job_id,next_check_at
  ) values (
    new.organization_id,public.prepared_admin_export_profile_key(new),new.export_type,
    (new.scope->>'brandId')::uuid,nullif(new.scope->>'supplierId','')::uuid,new.id,
    pg_catalog.clock_timestamp()+interval '15 minutes'
  ) on conflict(organization_id,profile_key) do update set seed_job_id=excluded.seed_job_id;
  return null;
end;
$fn$;
revoke all on function public.register_prepared_admin_export_profile() from public,anon,authenticated,service_role;
create trigger register_prepared_admin_export_profile after insert on public.app_export_jobs
for each row execute function public.register_prepared_admin_export_profile();

insert into public.prepared_admin_export_profiles(
  organization_id,profile_key,export_type,brand_id,supplier_id,seed_job_id
)
select distinct on (j.organization_id,public.prepared_admin_export_profile_key(j))
  j.organization_id,public.prepared_admin_export_profile_key(j),j.export_type,
  (j.scope->>'brandId')::uuid,nullif(j.scope->>'supplierId','')::uuid,j.id
from public.app_export_jobs j
join public.brands b on b.id::text=j.scope->>'brandId' and b.organization_id=j.organization_id
where j.audience='admin' and j.export_type in ('catalog_master','supplier_price_list')
  and j.created_at>now()-interval '30 days'
order by j.organization_id,public.prepared_admin_export_profile_key(j),j.created_at desc;

create function public.queue_prepared_admin_export_profiles()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare org uuid; brand uuid;
begin
  if tg_op='DELETE' then org:=old.organization_id; else org:=new.organization_id; end if;
  if tg_table_name in ('supplier_current_price_pointers','supplier_price_source_versions',
    'prepared_price_catalog_versions','item_code_references','supplier_price_publications') then
    if tg_op='DELETE' then brand:=old.brand_id; else brand:=new.brand_id; end if;
  end if;
  update public.prepared_admin_export_profiles set next_check_at='epoch',revision=revision+1
  where organization_id=org and (brand is null or brand_id=brand);
  return null;
end;
$fn$;
revoke all on function public.queue_prepared_admin_export_profiles() from public,anon,authenticated,service_role;
create trigger queue_prepared_admin_export_publication after insert or update or delete on public.supplier_current_price_pointers
for each row execute function public.queue_prepared_admin_export_profiles();
create trigger queue_prepared_admin_export_source after insert or update on public.supplier_price_source_versions
for each row execute function public.queue_prepared_admin_export_profiles();
create trigger queue_prepared_admin_export_catalog after insert or update on public.prepared_price_catalog_versions
for each row execute function public.queue_prepared_admin_export_profiles();
create trigger queue_prepared_admin_export_identity after insert or update or delete on public.item_code_references
for each row execute function public.queue_prepared_admin_export_profiles();
create trigger queue_prepared_admin_export_publication_status after update of status on public.supplier_price_publications
for each row execute function public.queue_prepared_admin_export_profiles();

create function public.claim_prepared_admin_export_profile()
returns setof public.prepared_admin_export_profiles language plpgsql security definer set search_path='' as $fn$
declare p public.prepared_admin_export_profiles%rowtype;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('prepared-admin-export-prewarm',0)) then return; end if;
  if exists(select 1 from public.prepared_admin_export_profiles where lease_expires_at>pg_catalog.clock_timestamp()) then return; end if;
  if exists(select 1 from public.app_export_jobs where export_type in ('catalog_master','supplier_price_list')
    and status in ('queued','running') and expires_at>pg_catalog.clock_timestamp()) then return; end if;
  select * into p from public.prepared_admin_export_profiles
  where next_check_at<=pg_catalog.clock_timestamp()
    and (lease_expires_at is null or lease_expires_at<=pg_catalog.clock_timestamp())
  order by next_check_at,id for update skip locked limit 1;
  if not found then return; end if;
  update public.prepared_admin_export_profiles
  set lease_token=gen_random_uuid(),lease_expires_at=pg_catalog.clock_timestamp()+interval '10 minutes'
  where id=p.id returning * into p;
  return next p;
end;
$fn$;
create function public.finish_prepared_admin_export_profile(
  input_id uuid,input_lease_token uuid,input_revision bigint,input_error_code text default null
) returns boolean language plpgsql security definer set search_path='' as $fn$
begin
  update public.prepared_admin_export_profiles set
    next_check_at=case when revision<>input_revision then 'epoch'::timestamptz
      else pg_catalog.clock_timestamp()+interval '15 minutes' end,
    last_checked_at=pg_catalog.clock_timestamp(),last_error_code=input_error_code,
    lease_token=null,lease_expires_at=null
  where id=input_id and lease_token=input_lease_token;
  return found;
end;
$fn$;
revoke all on function public.claim_prepared_admin_export_profile(),public.finish_prepared_admin_export_profile(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.claim_prepared_admin_export_profile(),public.finish_prepared_admin_export_profile(uuid,uuid,bigint,text) to service_role;
