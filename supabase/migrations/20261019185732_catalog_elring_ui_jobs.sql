create table public.catalog_elring_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 created_by uuid not null, idempotency_key uuid not null, manifest jsonb not null,
 mode text not null default 'stage' check(mode in ('stage','publish')),
 status text not null default 'queued' check(status in ('queued','running','paused','reviewed','completed','failed')),
 total_items integer not null check(total_items between 1 and 100), next_index integer not null default 0,
 lease_token uuid, lease_expires_at timestamptz, error_message text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,idempotency_key), unique(id,organization_id), check(next_index between 0 and total_items)
);
create index catalog_elring_jobs_org_status on public.catalog_elring_jobs(organization_id,status,updated_at desc);
create table public.catalog_elring_job_items (
 job_id uuid not null references public.catalog_elring_jobs(id) on delete cascade, organization_id uuid not null,
 item_index integer not null check(item_index>=0), product_code text not null,
 state text not null default 'pending' check(state in ('pending','observed','processing','reviewed','completed','failed')),
 observation jsonb, checkpoint jsonb not null default '{}'::jsonb, error_message text,
 updated_at timestamptz not null default now(), primary key(job_id,item_index),
 foreign key(job_id,organization_id) references public.catalog_elring_jobs(id,organization_id) on delete cascade
);
create index catalog_elring_items_org_job on public.catalog_elring_job_items(organization_id,job_id);
alter table public.catalog_elring_jobs enable row level security;
alter table public.catalog_elring_job_items enable row level security;
revoke all on public.catalog_elring_jobs,public.catalog_elring_job_items from public,anon,authenticated;
grant select on public.catalog_elring_jobs,public.catalog_elring_job_items to authenticated;
grant all on public.catalog_elring_jobs,public.catalog_elring_job_items to service_role;
create policy catalog_elring_jobs_admin_read on public.catalog_elring_jobs for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');
create policy catalog_elring_items_admin_read on public.catalog_elring_job_items for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');

create function public.start_catalog_elring_job(input_org uuid,input_actor uuid,input_codes jsonb,input_segment text,input_key uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_elring_jobs%rowtype; config jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active) then raise exception 'Catalog administrator required'; end if;
 if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key='tecalliance_elring'
   and is_active and license_posture='allowed' and credential_boundary='none' and rate_limit_posture='bounded'
   and metadata->>'internal_observation_allowed'='true' and metadata->>'automated_read_only_approved'='true') then raise exception 'Elring source unavailable'; end if;
 if jsonb_typeof(input_codes) is distinct from 'array' then raise exception 'Product code list required'; end if;
 if jsonb_array_length(input_codes) not between 1 and 100 or input_key is null
  or input_segment is null or input_segment not in ('pc','cv','lcv','motorcycle','engines','universal','marine','industrial','agriculture') then raise exception 'Invalid Elring manifest or market segment'; end if;
 if exists(select 1 from jsonb_array_elements(input_codes) c where jsonb_typeof(c)<>'string' or c#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{1,59}$')
  or (select count(distinct public.normalize_part_code(value)) from jsonb_array_elements_text(input_codes))<>jsonb_array_length(input_codes) then raise exception 'Invalid or duplicate product codes'; end if;
 config:=jsonb_build_object('codes',input_codes,'segment',input_segment,'adapter','elring-official.v2','fitment_max_requests',128);
 insert into public.catalog_elring_jobs(organization_id,created_by,idempotency_key,manifest,total_items)
 values(input_org,input_actor,input_key,config,jsonb_array_length(input_codes)) on conflict(organization_id,idempotency_key) do nothing;
 select * into j from public.catalog_elring_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest<>config then raise exception 'Elring request key conflict'; end if;
 insert into public.catalog_elring_job_items(job_id,organization_id,item_index,product_code)
 select j.id,input_org,(ordinality-1)::integer,value from jsonb_array_elements_text(input_codes) with ordinality on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end $$;

create function public.schedule_catalog_elring_job(input_org uuid,input_job uuid,input_publish boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_elring_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_elring_jobs where id=input_job and organization_id=input_org for update;
 if j.id is null then raise exception 'Elring job not found'; end if;
 if j.status='running' and j.lease_expires_at>now() then return to_jsonb(j)-'lease_token'; end if;
 if input_publish then
  if j.status<>'reviewed' then raise exception 'Review collection must complete before publication'; end if;
  if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key='tecalliance_elring'
   and is_active and license_posture='allowed' and metadata->>'internal_catalog_persistence_allowed'='true'
   and nullif(metadata->>'approval_actor','') is not null and nullif(metadata->>'publication_approval_reference','') is not null) then
   raise exception 'Elring publication authorization missing'; end if;
  update public.catalog_elring_jobs set mode='publish',next_index=0,status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 elsif j.status not in ('reviewed','completed') then
  update public.catalog_elring_jobs set status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'lease_token';
end $$;

create function public.claim_catalog_elring_job(input_org uuid,input_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_elring_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-elring:'||input_org::text,0));
 if exists(select 1 from public.catalog_elring_jobs where organization_id=input_org and status='running' and lease_expires_at>now()) then return null; end if;
 update public.catalog_elring_jobs set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and (status='queued' or (status='running' and lease_expires_at<=now())) returning * into j;
 if j.id is null then return null; end if;
 return to_jsonb(j);
end $$;

create function public.heartbeat_catalog_elring_job(input_org uuid,input_job uuid,input_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 update public.catalog_elring_jobs set lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and lease_token=input_token and status='running' and lease_expires_at>now();
 if not found then raise exception 'Elring worker lease lost'; end if;
 return true;
end $$;

create function public.checkpoint_catalog_elring_job(input_org uuid,input_job uuid,input_token uuid,input_index integer,
 input_observation jsonb,input_checkpoint jsonb,input_state text,input_error text default null,input_advance boolean default false,input_end_status text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_elring_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_elring_jobs where id=input_job and organization_id=input_org and lease_token=input_token
  and status='running' and lease_expires_at>now() for update;
 if j.id is null then raise exception 'Elring worker lease lost'; end if;
 if input_index is distinct from j.next_index or input_checkpoint is null or jsonb_typeof(input_checkpoint)<>'object'
  or (input_end_status is not null and input_end_status not in ('paused','failed')) then raise exception 'Invalid Elring checkpoint'; end if;
 if input_advance and (input_state is distinct from case when j.mode='stage' then 'reviewed' else 'completed' end) then raise exception 'Elring package is not complete'; end if;
 update public.catalog_elring_job_items set observation=input_observation,checkpoint=input_checkpoint,state=input_state,
  error_message=input_error,updated_at=now() where job_id=j.id and organization_id=input_org and item_index=input_index;
 if not found then raise exception 'Elring item not found'; end if;
 update public.catalog_elring_jobs set next_index=case when input_advance then next_index+1 else next_index end,
  status=case when input_advance and next_index+1=total_items then case when mode='stage' then 'reviewed' else 'completed' end
   else coalesce(input_end_status,'running') end,error_message=input_error,
  lease_expires_at=case when input_end_status is not null or (input_advance and next_index+1=total_items) then now() else now()+interval '5 minutes' end,
  updated_at=now() where id=j.id;
 return true;
end $$;

revoke all on function public.start_catalog_elring_job(uuid,uuid,jsonb,text,uuid),public.schedule_catalog_elring_job(uuid,uuid,boolean),
 public.claim_catalog_elring_job(uuid,uuid),public.heartbeat_catalog_elring_job(uuid,uuid,uuid),
 public.checkpoint_catalog_elring_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.start_catalog_elring_job(uuid,uuid,jsonb,text,uuid),public.schedule_catalog_elring_job(uuid,uuid,boolean),
 public.claim_catalog_elring_job(uuid,uuid),public.heartbeat_catalog_elring_job(uuid,uuid,uuid),
 public.checkpoint_catalog_elring_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) to service_role;
select pg_notify('pgrst','reload schema');
