create table public.catalog_brand_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 created_by uuid not null, idempotency_key uuid not null, manifest jsonb not null,
 mode text not null default 'stage' check(mode in ('stage','publish')),
 status text not null default 'queued' check(status in ('queued','running','paused','reviewed','completed','failed')),
 total_items integer not null check(total_items between 1 and 100), next_index integer not null default 0,
 lease_token uuid, lease_expires_at timestamptz, error_message text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,idempotency_key), unique(id,organization_id), check(next_index between 0 and total_items)
);
create index catalog_brand_jobs_org_status on public.catalog_brand_jobs(organization_id,status,updated_at desc);
create table public.catalog_brand_job_items (
 job_id uuid not null references public.catalog_brand_jobs(id) on delete cascade, organization_id uuid not null,
 item_index integer not null check(item_index>=0), product_code text not null,
 state text not null default 'pending' check(state in ('pending','observed','processing','reviewed','completed','failed')),
 observation jsonb, checkpoint jsonb not null default '{}'::jsonb, error_message text,
 updated_at timestamptz not null default now(), primary key(job_id,item_index),
 foreign key(job_id,organization_id) references public.catalog_brand_jobs(id,organization_id) on delete cascade
);
create index catalog_brand_items_org_job on public.catalog_brand_job_items(organization_id,job_id);
alter table public.catalog_brand_jobs enable row level security;
alter table public.catalog_brand_job_items enable row level security;
revoke all on public.catalog_brand_jobs,public.catalog_brand_job_items from public,anon,authenticated;
grant select on public.catalog_brand_jobs,public.catalog_brand_job_items to authenticated;
grant all on public.catalog_brand_jobs,public.catalog_brand_job_items to service_role;
create policy catalog_brand_jobs_admin_read on public.catalog_brand_jobs for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');
create policy catalog_brand_items_admin_read on public.catalog_brand_job_items for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');

create function public.start_catalog_brand_job(input_org uuid,input_actor uuid,input_codes jsonb,input_brand text,input_key uuid,input_source text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype; config jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active) then raise exception 'Catalog administrator required'; end if;
 if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key=input_source
   and is_active and license_posture in ('allowed','internal_review_required') and credential_boundary='none' and rate_limit_posture='bounded'
   and metadata->>'brand_engine_read_allowed'='true' and metadata->'allowed_brands' ? input_brand) then raise exception 'Brand source unavailable'; end if;
 if jsonb_typeof(input_codes) is distinct from 'array' then raise exception 'Product code list required'; end if;
 if jsonb_array_length(input_codes) not between 1 and 100 or input_key is null
  or input_brand is null or input_source is null then raise exception 'Invalid Brand brand or product manifest'; end if;
 if not exists(select 1 from public.brands where organization_id=input_org and name=input_brand) then raise exception 'Brand brand not registered'; end if;
 if exists(select 1 from jsonb_array_elements(input_codes) c where jsonb_typeof(c)<>'string' or c#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,99}$')
  or (select count(distinct upper(regexp_replace(value,'\s','','g'))) from jsonb_array_elements_text(input_codes))<>jsonb_array_length(input_codes) then raise exception 'Invalid or duplicate product codes'; end if;
 config:=jsonb_build_object('codes',input_codes,'brand',input_brand,'adapter','brand-exact.v1','source_key',input_source);
 insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items)
 values(input_org,input_actor,input_key,config,jsonb_array_length(input_codes)) on conflict(organization_id,idempotency_key) do nothing;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest<>config then raise exception 'Brand request key conflict'; end if;
 insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)
 select j.id,input_org,(ordinality-1)::integer,value from jsonb_array_elements_text(input_codes) with ordinality on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end $$;

create function public.schedule_catalog_brand_job(input_org uuid,input_job uuid,input_publish boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org for update;
 if j.id is null then raise exception 'Brand job not found'; end if;
 if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key=j.manifest->>'source_key' and is_active and metadata->'allowed_brands' ? (j.manifest->>'brand')) then raise exception 'Brand source unavailable'; end if;
 if j.status='running' and j.lease_expires_at>now() then return to_jsonb(j)-'lease_token'; end if;
 if input_publish then
  if j.status<>'reviewed' then raise exception 'Review collection must complete before publication'; end if;
  if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key=j.manifest->>'source_key'
   and is_active and license_posture in ('allowed','internal_review_required') and metadata->>'brand_engine_enrichment_allowed'='true'
   and nullif(metadata->>'approval_actor','') is not null and nullif(metadata->>'publication_approval_reference','') is not null) then
   raise exception 'Brand publication authorization missing'; end if;
  update public.catalog_brand_jobs set mode='publish',next_index=0,status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 elsif j.status not in ('reviewed','completed') then
  update public.catalog_brand_jobs set status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'lease_token';
end $$;

create function public.claim_catalog_brand_job(input_org uuid,input_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-brand:'||input_org::text,0));
 if exists(select 1 from public.catalog_brand_jobs where organization_id=input_org and status='running' and lease_expires_at>now()) then return null; end if;
 update public.catalog_brand_jobs set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and (status='queued' or (status='running' and lease_expires_at<=now())) returning * into j;
 if j.id is null then return null; end if;
 return to_jsonb(j);
end $$;

create function public.heartbeat_catalog_brand_job(input_org uuid,input_job uuid,input_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 update public.catalog_brand_jobs set lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and lease_token=input_token and status='running' and lease_expires_at>now();
 if not found then raise exception 'Brand worker lease lost'; end if;
 return true;
end $$;

create function public.checkpoint_catalog_brand_job(input_org uuid,input_job uuid,input_token uuid,input_index integer,
 input_observation jsonb,input_checkpoint jsonb,input_state text,input_error text default null,input_advance boolean default false,input_end_status text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_brand_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org and lease_token=input_token
  and status='running' and lease_expires_at>now() for update;
 if j.id is null then raise exception 'Brand worker lease lost'; end if;
 if input_index is distinct from j.next_index or input_checkpoint is null or jsonb_typeof(input_checkpoint)<>'object'
  or (input_end_status is not null and input_end_status not in ('paused','failed')) then raise exception 'Invalid Brand checkpoint'; end if;
 if input_advance and (input_state is distinct from case when j.mode='stage' then 'reviewed' else 'completed' end) then raise exception 'Brand package is not complete'; end if;
 if exists(select 1 from public.catalog_brand_job_items where job_id=j.id and item_index=input_index and observation is not null and observation is distinct from input_observation) then raise exception 'Brand observation is immutable'; end if;
 if input_observation is not null and octet_length(input_observation::text)>5*1024*1024 then raise exception 'Brand observation too large'; end if;
 if input_advance and input_observation is null then raise exception 'Brand source receipt required'; end if;
 update public.catalog_brand_job_items set observation=input_observation,checkpoint=input_checkpoint,state=input_state,
  error_message=input_error,updated_at=now() where job_id=j.id and organization_id=input_org and item_index=input_index;
 if not found then raise exception 'Brand item not found'; end if;
 update public.catalog_brand_jobs set next_index=case when input_advance then next_index+1 else next_index end,
  status=case when input_advance and next_index+1=total_items then case when mode='stage' then 'reviewed' else 'completed' end
   else coalesce(input_end_status,'running') end,error_message=input_error,
  lease_expires_at=case when input_end_status is not null or (input_advance and next_index+1=total_items) then now() else now()+interval '5 minutes' end,
  updated_at=now() where id=j.id;
 return true;
end $$;

revoke all on function public.start_catalog_brand_job(uuid,uuid,jsonb,text,uuid,text),public.schedule_catalog_brand_job(uuid,uuid,boolean),
 public.claim_catalog_brand_job(uuid,uuid),public.heartbeat_catalog_brand_job(uuid,uuid,uuid),
 public.checkpoint_catalog_brand_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.start_catalog_brand_job(uuid,uuid,jsonb,text,uuid,text),public.schedule_catalog_brand_job(uuid,uuid,boolean),
 public.claim_catalog_brand_job(uuid,uuid),public.heartbeat_catalog_brand_job(uuid,uuid,uuid),
 public.checkpoint_catalog_brand_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) to service_role;
select pg_notify('pgrst','reload schema');

-- Every application keeps the reviewed before/after receipt. No supplier prices are written here.
create table public.catalog_brand_item_applications(
 job_id uuid not null, item_index integer not null, organization_id uuid not null,
 catalog_product_id uuid references public.catalog_products(id), result jsonb not null,
 applied_at timestamptz not null default now(), primary key(job_id,item_index),
 foreign key(job_id,item_index) references public.catalog_brand_job_items(job_id,item_index),
 foreign key(job_id,organization_id) references public.catalog_brand_jobs(id,organization_id)
);
create index catalog_brand_applications_product on public.catalog_brand_item_applications(catalog_product_id);
create index catalog_brand_applications_org on public.catalog_brand_item_applications(organization_id,job_id);
alter table public.catalog_brand_item_applications enable row level security;
revoke all on public.catalog_brand_item_applications from public,anon,authenticated;
grant select on public.catalog_brand_item_applications to authenticated;
grant all on public.catalog_brand_item_applications to service_role;
create policy catalog_brand_applications_admin_read on public.catalog_brand_item_applications for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');

-- Generic reviewed completion only; preserves populated scalar facts and manual edits.
create function public.apply_catalog_brand_job_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare j public.catalog_brand_jobs%rowtype; it public.catalog_brand_job_items%rowtype; p public.catalog_products%rowtype;
 src public.catalog_external_sources%rowtype; obs jsonb; vals jsonb; before_values jsonb;
 outcomes jsonb:='{}'; changes jsonb:='{}'; result_value jsonb; prior jsonb; field text; value jsonb; live jsonb;
 brand_value uuid; n integer; host text; ean_conflict boolean; assignments text[]:=array[]::text[];
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required';end if;
 select * into j from public.catalog_brand_jobs where id=input_job and organization_id=input_org and mode='publish' and status='running' and lease_token=input_token and lease_expires_at>now() for update;
 if j.id is null or j.next_index is distinct from input_index then raise exception 'Brand worker lease or cursor lost';end if;
 select result into prior from public.catalog_brand_item_applications where job_id=j.id and item_index=input_index;if found then return prior;end if;
 select * into src from public.catalog_external_sources where organization_id=input_org and source_key=j.manifest->>'source_key';
 if src.id is null or not src.is_active or src.license_posture not in ('allowed','internal_review_required') or src.credential_boundary is distinct from 'none'
 or src.rate_limit_posture<>'bounded' or src.metadata->>'brand_engine_read_allowed' is distinct from 'true' or src.metadata->>'brand_engine_enrichment_allowed' is distinct from 'true'
 or not(src.metadata->'allowed_brands' ? (j.manifest->>'brand')) or nullif(src.metadata->>'approval_actor','') is null or nullif(src.metadata->>'publication_approval_reference','') is null then raise exception 'Brand source authorization unavailable';end if;
 select * into it from public.catalog_brand_job_items where job_id=j.id and organization_id=input_org and item_index=input_index;
 obs:=it.observation;vals:=obs->'fields';before_values:=obs->'before';
 if obs->>'unavailable' is not null then result_value:=jsonb_build_object('status','source_unavailable','reason',obs->>'unavailable');
 else
 host:=(regexp_match(obs->>'sourceUrl','^https://([a-zA-Z0-9.-]+)(?:/|$)'))[1];
 if obs is null or obs->>'brand' is distinct from j.manifest->>'brand' or obs->>'sourceKey' is distinct from j.manifest->>'source_key'
 or upper(regexp_replace(obs->>'code','\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
 or host is null or not(src.metadata->'allowed_evidence_hosts' ? lower(host)) then raise exception 'Brand exact source identity mismatch';end if;
 select id into brand_value from public.brands where organization_id=input_org and name=j.manifest->>'brand';
 select count(*) into n from public.catalog_products where organization_id=input_org and brand_id=brand_value and normalized_code=public.normalize_part_code(it.product_code);
 if n<>1 then raise exception 'Brand catalog identity missing or ambiguous';end if;
 select * into p from public.catalog_products where organization_id=input_org and brand_id=brand_value and normalized_code=public.normalize_part_code(it.product_code) for update;
 if before_values->>'id' is distinct from p.id::text or upper(regexp_replace(p.product_code,'\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g')) then raise exception 'Brand catalog identity changed';end if;
 ean_conflict:=nullif(trim(p.ean),'') is not null and nullif(trim(coalesce(obs->'sourceFields'->>'ean',vals->>'ean')),'') is not null
  and regexp_replace(p.ean,'\s','','g')<>regexp_replace(coalesce(obs->'sourceFields'->>'ean',vals->>'ean'),'\s','','g');
 foreach field in array array['description','description_tr','ean','weight_kg','origin','hs_code','oem_no','vehicle','vehicle_model','market_segment','dimensions'] loop
 value:=vals->field;live:=to_jsonb(p)->field;
 if value is null or value in ('null'::jsonb,'""'::jsonb) then outcomes:=outcomes||jsonb_build_object(field,'source_missing');continue;end if;
 if ean_conflict then outcomes:=outcomes||jsonb_build_object(field,'ean_identity_conflict');continue;end if;
 if live is distinct from before_values->field then outcomes:=outcomes||jsonb_build_object(field,'changed_since_review');continue;end if;
 if live=value then outcomes:=outcomes||jsonb_build_object(field,'unchanged');continue;end if;
 if live is not null and live not in ('null'::jsonb,'""'::jsonb) and field not in ('oem_no','vehicle','vehicle_model') then outcomes:=outcomes||jsonb_build_object(field,'existing_value_preserved');continue;end if;
 if field='weight_kg' and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<=0 or (value#>>'{}')::numeric>100000) then raise exception 'Invalid official weight';end if;
 if field not in ('weight_kg','dimensions') and (jsonb_typeof(value)<>'string' or length(value#>>'{}')>12000) then raise exception 'Invalid official text field';end if;
 if field='dimensions' and jsonb_typeof(value)<>'object' then raise exception 'Invalid official dimensions';end if;
 if field='origin' and value#>>'{}' !~ '^[A-Z]{2}$' then raise exception 'Invalid official origin';end if;
 if field='hs_code' and value#>>'{}' !~ '^\d[\d.\s-]{1,30}\d$' then raise exception 'Invalid official tariff';end if;
 if field='ean' and value#>>'{}' !~ '^[0-9]{8,14}$' then raise exception 'Invalid official EAN';end if;
 changes:=changes||jsonb_build_object(field,value);outcomes:=outcomes||jsonb_build_object(field,'applied');
 end loop;
 for field,value in select key,v.value from jsonb_each(changes)v loop
 if field='weight_kg' then assignments:=array_append(assignments,format('%I=($1->>%L)::numeric',field,field));
 elsif field='dimensions' then assignments:=array_append(assignments,'dimensions=$1->''dimensions''');
 else assignments:=array_append(assignments,format('%I=$1->>%L',field,field));end if;
 end loop;
 if cardinality(assignments)>0 then execute 'update public.catalog_products set '||array_to_string(assignments,',')||',updated_at=now() where id=$2' using changes,p.id;end if;
 result_value:=jsonb_build_object('status','completed','fields',outcomes,'changes',changes,'before',before_values,'sourceUrl',obs->>'sourceUrl','source_fingerprint',obs->>'fingerprint');
 end if;
 insert into public.catalog_brand_item_applications(job_id,item_index,organization_id,catalog_product_id,result)values(j.id,input_index,input_org,p.id,result_value);
 return result_value;
end$$;
revoke all on function public.apply_catalog_brand_job_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_brand_job_item(uuid,uuid,uuid,integer) to service_role;
create view public.catalog_brand_review_items with(security_invoker=true) as select job_id,organization_id,item_index,product_code,state,error_message,checkpoint,
 observation-'raw' as observation from public.catalog_brand_job_items;
revoke all on public.catalog_brand_review_items from public,anon;
grant select on public.catalog_brand_review_items to authenticated,service_role;
select pg_notify('pgrst','reload schema');
