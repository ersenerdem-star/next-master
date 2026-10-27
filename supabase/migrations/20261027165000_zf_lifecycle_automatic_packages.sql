-- Keep the four explicitly seeded ZF brands moving in bounded, serial packages.
-- Source receipts still require the normal administrator review before publish.
create table public.catalog_zf_lifecycle_completed (
 organization_id uuid not null references public.organizations(id),
 brand text not null check (brand in ('Sachs','Boge','Lemforder','TRW')),
 completed_at timestamptz not null default now(),
 primary key (organization_id,brand)
);
alter table public.catalog_zf_lifecycle_completed enable row level security;
revoke all on public.catalog_zf_lifecycle_completed from public,anon,authenticated;
grant select,insert,update,delete on public.catalog_zf_lifecycle_completed to service_role;

create function public.enqueue_next_catalog_zf_lifecycle_job(input_org uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='15s' as $$
declare seed record; codes jsonb; queued jsonb; actor_id uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-zf-lifecycle-queue:'||input_org::text,0));
 if exists(select 1 from public.catalog_zf_jobs j where j.organization_id=input_org
   and j.manifest->>'scope'='lifecycle' and j.mode='stage'
   and j.status in ('queued','running','paused','failed')) then return null; end if;

 -- The oldest last-reviewed brand is chosen first, so every seeded brand advances.
 for seed in
  select recent.brand,recent.created_by,recent.created_at from (
   select distinct on (j.manifest->>'brand') j.manifest->>'brand' as brand,j.created_by,j.created_at
   from public.catalog_zf_jobs j
   where j.organization_id=input_org and j.manifest->>'scope'='lifecycle'
    and j.manifest->>'brand' in ('Sachs','Boge','Lemforder','TRW')
    and not exists(select 1 from public.catalog_zf_lifecycle_completed c
     where c.organization_id=input_org and c.brand=j.manifest->>'brand')
   order by j.manifest->>'brand',j.created_at desc
  ) recent order by recent.created_at,recent.brand
 loop
  codes:=public.next_catalog_zf_lifecycle_codes(input_org,seed.brand,100);
  if jsonb_array_length(codes)=0 then
   insert into public.catalog_zf_lifecycle_completed(organization_id,brand) values(input_org,seed.brand)
    on conflict do nothing;
   continue;
  end if;
  select p.id into actor_id from public.profiles p where p.id=seed.created_by
   and p.organization_id=input_org and p.role='superadmin' and p.is_active;
  if actor_id is null then raise exception 'ZF lifecycle seed administrator unavailable for %',seed.brand; end if;
  queued:=public.start_catalog_zf_job(input_org,actor_id,codes,seed.brand,gen_random_uuid());
  update public.catalog_zf_jobs as j set manifest=j.manifest||jsonb_build_object('scope','lifecycle','auto_queued',true)
   where j.id=(queued->>'id')::uuid and j.organization_id=input_org and j.status='queued' and j.next_index=0
   returning to_jsonb(j)-'lease_token' into queued;
  if queued is null then raise exception 'ZF lifecycle package creation lost'; end if;
  return queued;
 end loop;
 return null;
end $$;
revoke all on function public.enqueue_next_catalog_zf_lifecycle_job(uuid) from public,anon,authenticated;
grant execute on function public.enqueue_next_catalog_zf_lifecycle_job(uuid) to service_role;
select pg_notify('pgrst','reload schema');
