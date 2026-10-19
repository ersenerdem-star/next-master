create table public.catalog_zf_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 created_by uuid not null, idempotency_key uuid not null, manifest jsonb not null,
 mode text not null default 'stage' check(mode in ('stage','publish')),
 status text not null default 'queued' check(status in ('queued','running','paused','reviewed','completed','failed')),
 total_items integer not null check(total_items between 1 and 100), next_index integer not null default 0,
 lease_token uuid, lease_expires_at timestamptz, error_message text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,idempotency_key), unique(id,organization_id), check(next_index between 0 and total_items)
);
create index catalog_zf_jobs_org_status on public.catalog_zf_jobs(organization_id,status,updated_at desc);
create table public.catalog_zf_job_items (
 job_id uuid not null references public.catalog_zf_jobs(id) on delete cascade, organization_id uuid not null,
 item_index integer not null check(item_index>=0), product_code text not null,
 state text not null default 'pending' check(state in ('pending','observed','processing','reviewed','completed','failed')),
 observation jsonb, checkpoint jsonb not null default '{}'::jsonb, error_message text,
 updated_at timestamptz not null default now(), primary key(job_id,item_index),
 foreign key(job_id,organization_id) references public.catalog_zf_jobs(id,organization_id) on delete cascade
);
create index catalog_zf_items_org_job on public.catalog_zf_job_items(organization_id,job_id);
alter table public.catalog_zf_jobs enable row level security;
alter table public.catalog_zf_job_items enable row level security;
revoke all on public.catalog_zf_jobs,public.catalog_zf_job_items from public,anon,authenticated;
grant select on public.catalog_zf_jobs,public.catalog_zf_job_items to authenticated;
grant all on public.catalog_zf_jobs,public.catalog_zf_job_items to service_role;
create policy catalog_zf_jobs_admin_read on public.catalog_zf_jobs for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');
create policy catalog_zf_items_admin_read on public.catalog_zf_job_items for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');

create function public.start_catalog_zf_job(input_org uuid,input_actor uuid,input_codes jsonb,input_brand text,input_key uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_zf_jobs%rowtype; config jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active) then raise exception 'Catalog administrator required'; end if;
 if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key='zf_group_official_v2'
   and is_active and license_posture in ('allowed','internal_review_required') and credential_boundary='none' and rate_limit_posture='bounded'
   and metadata->>'internal_observation_allowed'='true' and metadata->>'automated_read_only_approved'='true' and metadata->'allowed_brands' ? input_brand) then raise exception 'ZF source unavailable'; end if;
 if jsonb_typeof(input_codes) is distinct from 'array' then raise exception 'Product code list required'; end if;
 if jsonb_array_length(input_codes) not between 1 and 100 or input_key is null
  or input_brand is null or input_brand not in ('ZF','Sachs','Boge','TRW','Lemforder','Wabco') then raise exception 'Invalid ZF brand or product manifest'; end if;
 if not exists(select 1 from public.brands where organization_id=input_org and name=input_brand) then raise exception 'ZF brand not registered'; end if;
 if exists(select 1 from jsonb_array_elements(input_codes) c where jsonb_typeof(c)<>'string' or c#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{1,59}$')
  or (select count(distinct upper(regexp_replace(value,'\s','','g'))) from jsonb_array_elements_text(input_codes))<>jsonb_array_length(input_codes) then raise exception 'Invalid or duplicate product codes'; end if;
 config:=jsonb_build_object('codes',input_codes,'brand',input_brand,'adapter','zf-exact.v2');
 insert into public.catalog_zf_jobs(organization_id,created_by,idempotency_key,manifest,total_items)
 values(input_org,input_actor,input_key,config,jsonb_array_length(input_codes)) on conflict(organization_id,idempotency_key) do nothing;
 select * into j from public.catalog_zf_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest<>config then raise exception 'ZF request key conflict'; end if;
 insert into public.catalog_zf_job_items(job_id,organization_id,item_index,product_code)
 select j.id,input_org,(ordinality-1)::integer,value from jsonb_array_elements_text(input_codes) with ordinality on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end $$;

create function public.schedule_catalog_zf_job(input_org uuid,input_job uuid,input_publish boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_zf_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_zf_jobs where id=input_job and organization_id=input_org for update;
 if j.id is null then raise exception 'ZF job not found'; end if;
 if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key='zf_group_official_v2' and is_active and metadata->'allowed_brands' ? (j.manifest->>'brand')) then raise exception 'ZF source unavailable'; end if;
 if j.status='running' and j.lease_expires_at>now() then return to_jsonb(j)-'lease_token'; end if;
 if input_publish then
  if j.status<>'reviewed' then raise exception 'Review collection must complete before publication'; end if;
  if not exists(select 1 from public.catalog_external_sources where organization_id=input_org and source_key='zf_group_official_v2'
   and is_active and license_posture in ('allowed','internal_review_required') and metadata->>'internal_catalog_correction_allowed'='true'
   and nullif(metadata->>'approval_actor','') is not null and nullif(metadata->>'publication_approval_reference','') is not null) then
   raise exception 'ZF publication authorization missing'; end if;
  update public.catalog_zf_jobs set mode='publish',next_index=0,status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 elsif j.status not in ('reviewed','completed') then
  update public.catalog_zf_jobs set status='queued',error_message=null,updated_at=now() where id=j.id returning * into j;
 end if;
 return to_jsonb(j)-'lease_token';
end $$;

create function public.claim_catalog_zf_job(input_org uuid,input_job uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_zf_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-zf:'||input_org::text,0));
 if exists(select 1 from public.catalog_zf_jobs where organization_id=input_org and status='running' and lease_expires_at>now()) then return null; end if;
 update public.catalog_zf_jobs set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and (status='queued' or (status='running' and lease_expires_at<=now())) returning * into j;
 if j.id is null then return null; end if;
 return to_jsonb(j);
end $$;

create function public.heartbeat_catalog_zf_job(input_org uuid,input_job uuid,input_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 update public.catalog_zf_jobs set lease_expires_at=now()+interval '5 minutes',updated_at=now()
 where organization_id=input_org and id=input_job and lease_token=input_token and status='running' and lease_expires_at>now();
 if not found then raise exception 'ZF worker lease lost'; end if;
 return true;
end $$;

create function public.checkpoint_catalog_zf_job(input_org uuid,input_job uuid,input_token uuid,input_index integer,
 input_observation jsonb,input_checkpoint jsonb,input_state text,input_error text default null,input_advance boolean default false,input_end_status text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.catalog_zf_jobs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_zf_jobs where id=input_job and organization_id=input_org and lease_token=input_token
  and status='running' and lease_expires_at>now() for update;
 if j.id is null then raise exception 'ZF worker lease lost'; end if;
 if input_index is distinct from j.next_index or input_checkpoint is null or jsonb_typeof(input_checkpoint)<>'object'
  or (input_end_status is not null and input_end_status not in ('paused','failed')) then raise exception 'Invalid ZF checkpoint'; end if;
 if input_advance and (input_state is distinct from case when j.mode='stage' then 'reviewed' else 'completed' end) then raise exception 'ZF package is not complete'; end if;
 if exists(select 1 from public.catalog_zf_job_items where job_id=j.id and item_index=input_index and observation is not null and observation is distinct from input_observation) then raise exception 'ZF observation is immutable'; end if;
 if input_advance and input_observation is null then raise exception 'ZF source receipt required'; end if;
 update public.catalog_zf_job_items set observation=input_observation,checkpoint=input_checkpoint,state=input_state,
  error_message=input_error,updated_at=now() where job_id=j.id and organization_id=input_org and item_index=input_index;
 if not found then raise exception 'ZF item not found'; end if;
 update public.catalog_zf_jobs set next_index=case when input_advance then next_index+1 else next_index end,
  status=case when input_advance and next_index+1=total_items then case when mode='stage' then 'reviewed' else 'completed' end
   else coalesce(input_end_status,'running') end,error_message=input_error,
  lease_expires_at=case when input_end_status is not null or (input_advance and next_index+1=total_items) then now() else now()+interval '5 minutes' end,
  updated_at=now() where id=j.id;
 return true;
end $$;

revoke all on function public.start_catalog_zf_job(uuid,uuid,jsonb,text,uuid),public.schedule_catalog_zf_job(uuid,uuid,boolean),
 public.claim_catalog_zf_job(uuid,uuid),public.heartbeat_catalog_zf_job(uuid,uuid,uuid),
 public.checkpoint_catalog_zf_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.start_catalog_zf_job(uuid,uuid,jsonb,text,uuid),public.schedule_catalog_zf_job(uuid,uuid,boolean),
 public.claim_catalog_zf_job(uuid,uuid),public.heartbeat_catalog_zf_job(uuid,uuid,uuid),
 public.checkpoint_catalog_zf_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) to service_role;
select pg_notify('pgrst','reload schema');

-- Every application keeps the reviewed before/after receipt. No supplier prices are written here.
create table public.catalog_zf_item_applications(
 job_id uuid not null, item_index integer not null, organization_id uuid not null,
 catalog_product_id uuid references public.catalog_products(id), result jsonb not null,
 applied_at timestamptz not null default now(), primary key(job_id,item_index),
 foreign key(job_id,item_index) references public.catalog_zf_job_items(job_id,item_index),
 foreign key(job_id,organization_id) references public.catalog_zf_jobs(id,organization_id)
);
create index catalog_zf_applications_product on public.catalog_zf_item_applications(catalog_product_id);
create index catalog_zf_applications_org on public.catalog_zf_item_applications(organization_id,job_id);
alter table public.catalog_zf_item_applications enable row level security;
revoke all on public.catalog_zf_item_applications from public,anon,authenticated;
grant select on public.catalog_zf_item_applications to authenticated;
grant all on public.catalog_zf_item_applications to service_role;
create policy catalog_zf_applications_admin_read on public.catalog_zf_item_applications for select to authenticated
 using(organization_id=public.current_profile_org_id() and public.current_profile_role()='superadmin');

create function public.apply_catalog_zf_job_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare
 j public.catalog_zf_jobs%rowtype; it public.catalog_zf_job_items%rowtype;
 p public.catalog_products%rowtype; target public.catalog_products%rowtype; src public.catalog_external_sources%rowtype;
 obs jsonb; before_values jsonb; vals jsonb; changes jsonb:='{}'; outcomes jsonb:='{}'; relations jsonb:='[]';
 field text; value jsonb; live jsonb; old_value jsonb; source_id uuid; brand_id_value uuid; source_hash text;
 edge jsonb; evidence jsonb; v_old_code text; v_new_code text; mapping public.item_code_references%rowtype;
 can_link boolean; cycles boolean; edge_result text; status_text text; result_value jsonb; application jsonb;
 cardinality integer; ean_conflict boolean; raw_article jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_zf_jobs where id=input_job and organization_id=input_org and mode='publish'
  and status='running' and lease_token=input_token and lease_expires_at>now() for update;
 if j.id is null or input_index is distinct from j.next_index then raise exception 'ZF worker lease or cursor lost'; end if;
 select result into application from public.catalog_zf_item_applications where job_id=j.id and item_index=input_index;
 if found then return application; end if;
 select * into src from public.catalog_external_sources where organization_id=input_org and source_key='zf_group_official_v2';
 if src.id is null or not src.is_active or src.license_posture not in ('allowed','internal_review_required')
  or src.credential_boundary is distinct from 'none' or src.rate_limit_posture<>'bounded'
  or src.metadata->>'internal_catalog_correction_allowed' is distinct from 'true'
  or src.metadata->>'automated_read_only_approved' is distinct from 'true'
  or nullif(src.metadata->>'publication_approval_reference','') is null
  or not (src.metadata->'allowed_brands' ? (j.manifest->>'brand')) then raise exception 'ZF correction authorization unavailable'; end if;
 select * into it from public.catalog_zf_job_items where job_id=j.id and organization_id=input_org and item_index=input_index;
 obs:=it.observation; vals:=obs->'fields'; before_values:=obs->'before'; raw_article:=obs->'raw'->'details';
 select id into brand_id_value from public.brands where organization_id=input_org and name=j.manifest->>'brand';
 if obs->>'unavailable' is not null then
  result_value:=jsonb_build_object('status','source_unavailable','reason',obs->>'unavailable');
 else
  if obs is null or obs->>'brand' is distinct from j.manifest->>'brand'
   or upper(regexp_replace(obs->>'code','\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
   or upper(regexp_replace(raw_article->>'number','\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
   or translate(lower(raw_article->>'brandName'),'ö','o') is distinct from lower(j.manifest->>'brand')
   or obs->>'sourceUrl' not like 'https://aftermarket.zf.com/%' then raise exception 'ZF exact source identity mismatch'; end if;
  select count(*) into cardinality from public.catalog_products where organization_id=input_org and brand_id=brand_id_value
   and normalized_code=public.normalize_part_code(it.product_code);
  if cardinality<>1 then raise exception 'ZF catalog identity missing or ambiguous; register the exact product first'; end if;
  select * into p from public.catalog_products where organization_id=input_org and brand_id=brand_id_value
   and normalized_code=public.normalize_part_code(it.product_code) for update;
  if upper(regexp_replace(p.product_code,'\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
    or before_values->>'id' is distinct from p.id::text then raise exception 'ZF catalog identity changed since review'; end if;
  ean_conflict:=nullif(trim(p.ean),'') is not null and nullif(trim(vals->>'ean'),'') is not null
    and regexp_replace(p.ean,'\s','','g')<>regexp_replace(vals->>'ean','\s','','g');
  foreach field in array array['description','weight_kg','ean','origin','hs_code'] loop
   value:=vals->field; live:=to_jsonb(p)->field; old_value:=before_values->field;
   if value is null or value='null'::jsonb or value='""'::jsonb then outcomes:=outcomes||jsonb_build_object(field,'source_missing'); continue; end if;
   if field='weight_kg' and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<=0 or (value#>>'{}')::numeric>100000) then
    outcomes:=outcomes||jsonb_build_object(field,'invalid_source_weight'); continue; end if;
   if live is distinct from old_value then outcomes:=outcomes||jsonb_build_object(field,'changed_since_review'); continue; end if;
   if live=value then outcomes:=outcomes||jsonb_build_object(field,'unchanged'); continue; end if;
   if ean_conflict then outcomes:=outcomes||jsonb_build_object(field,'ean_identity_conflict'); continue; end if;
   -- Existing identifiers/variable commercial facts are never blindly replaced by an official lookup.
   if field in ('ean','origin','hs_code') and live is not null and live not in ('null'::jsonb,'""'::jsonb) then
    outcomes:=outcomes||jsonb_build_object(field,'existing_value_preserved'); continue; end if;
   changes:=changes||jsonb_build_object(field,value); outcomes:=outcomes||jsonb_build_object(field,'applied');
  end loop;
  status_text:=raw_article->'status'->>'value';
  if not ean_conflict and status_text ~* '^(discontinued|discontinued article|production discontinued|no longer produced|end of production|production ended)$' then
   if to_jsonb(p)->'lifecycle_status' is not distinct from before_values->'lifecycle_status' then
    changes:=changes||jsonb_build_object('lifecycle_status','discontinued','lifecycle_note','ZF official: '||status_text);
    outcomes:=outcomes||jsonb_build_object('lifecycle_status','applied');
   else outcomes:=outcomes||jsonb_build_object('lifecycle_status','changed_since_review'); end if;
  else outcomes:=outcomes||jsonb_build_object('lifecycle_status','no_explicit_production_stop'); end if;
  -- Update only changed fields; this also avoids triggering full catalog search rebuilds for no-ops.
  for field,value in select e.key,e.value from jsonb_each(changes) e loop
   if field='weight_kg' then execute format('update public.catalog_products set %I=$1::numeric,updated_at=now() where id=$2',field) using value#>>'{}',p.id;
   else execute format('update public.catalog_products set %I=$1,updated_at=now() where id=$2',field) using value#>>'{}',p.id; end if;
  end loop;
  source_hash:=public.catalog_provider_jsonb_sha256(obs->'raw');
  insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
   values(input_org,p.id,'zf_group_official_v2',obs->>'sourceUrl',raw_article->>'number','zf-exact.v2',source_hash)
   on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
  select id into source_id from public.catalog_product_source_records where organization_id=input_org and catalog_product_id=p.id
   and source_key='zf_group_official_v2' and payload_fingerprint=source_hash;
  for edge in select e.value from jsonb_array_elements(coalesce(obs->'replacements','[]')) e loop
   evidence:=edge->'target'->'raw'->'details';
   if edge->>'direction' not in ('replaces','replaced_by') or evidence is null
    or translate(lower(evidence->>'brandName'),'ö','o') is distinct from lower(j.manifest->>'brand')
    or upper(regexp_replace(evidence->>'number','\s','','g')) is distinct from upper(regexp_replace(edge->>'code','\s','','g')) then
    relations:=relations||jsonb_build_array(jsonb_build_object('code',edge->>'code','status','target_unverified')); continue; end if;
   -- A verified target must also be explicitly named by the immutable source, in that direction.
   if not exists(select 1 from jsonb_array_elements(coalesce(raw_article->(case when edge->>'direction'='replaces' then 'replaces' else 'replacedBy' end)->'values','[]')) e
     where upper(regexp_replace(coalesce(e->>'text',e->>'number'),'\s','','g'))=upper(regexp_replace(edge->>'code','\s','','g'))) then
    raise exception 'ZF replacement missing from explicit source evidence'; end if;
   perform public.record_catalog_product_relation(p.id,source_id,case when edge->>'direction'='replaces' then 'replacement' else 'replaced_by' end,j.manifest->>'brand',edge->>'code',null,null);
   v_old_code:=case when edge->>'direction'='replaces' then edge->>'code' else p.product_code end;
   v_new_code:=case when edge->>'direction'='replaces' then p.product_code else edge->>'code' end;
   edge_result:='review_required';
   can_link:=not ean_conflict and not exists(select 1 from jsonb_array_elements(obs->'replacementCandidates') e where e->>'direction'='replaced_by'
    and upper(regexp_replace(e->>'code','\s','','g'))<>upper(regexp_replace(v_new_code,'\s','','g')) and edge->>'direction'='replaced_by');
   select * into target from public.catalog_products where organization_id=input_org and brand_id=brand_id_value and normalized_code=public.normalize_part_code(v_new_code);
   if not exists(select 1 from public.catalog_products where organization_id=input_org and brand_id=brand_id_value and normalized_code=public.normalize_part_code(v_old_code) and upper(regexp_replace(product_code,'\s','','g'))=upper(regexp_replace(v_old_code,'\s','','g'))) then can_link:=false; edge_result:='old_identity_not_in_catalog'; end if;
   if target.id is null or upper(regexp_replace(target.product_code,'\s','','g'))<>upper(regexp_replace(v_new_code,'\s','','g')) then can_link:=false; edge_result:='target_not_in_catalog'; end if;
   if public.normalize_part_code(v_old_code)=public.normalize_part_code(v_new_code) then can_link:=false;edge_result:='normalized_identity_collision'; end if;
   -- Serialize mapping edits for this brand and check the entire reachable graph with a hard bound.
   if not pg_try_advisory_xact_lock(hashtextextended('zf-links:'||input_org::text||brand_id_value::text,0)) then raise exception 'ZF replacement links busy; retry same job'; end if;
   select * into mapping from public.item_code_references where organization_id=input_org and brand_id=brand_id_value and is_active and normalized_old_code=public.normalize_part_code(v_old_code) limit 1;
   if mapping.id is not null then
    can_link:=false;edge_result:=case when upper(regexp_replace(mapping.old_code,'\s','','g'))=upper(regexp_replace(v_old_code,'\s','','g')) and upper(regexp_replace(mapping.new_code,'\s','','g'))=upper(regexp_replace(v_new_code,'\s','','g')) then 'existing_mapping_preserved' else 'existing_mapping_conflict' end;
   end if;
   if can_link then
    with recursive chain(code,path,depth) as (
     select public.normalize_part_code(v_new_code),array[public.normalize_part_code(v_new_code)],0
     union all select r.normalized_new_code,c.path||r.normalized_new_code,c.depth+1 from chain c join public.item_code_references r
      on r.organization_id=input_org and r.brand_id=brand_id_value and r.is_active and r.normalized_old_code=c.code
      where c.depth<16
    ) select exists(select 1 from chain where code=public.normalize_part_code(v_old_code) or depth>=16) into cycles;
    if cycles then edge_result:='cycle_or_depth_conflict';
    else insert into public.item_code_references(organization_id,brand_id,old_code,new_code,reason)
      values(input_org,brand_id_value,v_old_code,v_new_code,'ZF official verified replacement · '||j.id::text);edge_result:='mapping_added';end if;
   end if;
   relations:=relations||jsonb_build_array(jsonb_build_object('old',v_old_code,'new',v_new_code,'status',edge_result));
  end loop;
  result_value:=jsonb_build_object('status','completed','fields',outcomes,'changes',changes,'before',before_values,'relations',relations,'source_fingerprint',source_hash,'source_status',status_text);
 end if;
 insert into public.catalog_zf_item_applications(job_id,item_index,organization_id,catalog_product_id,result)
  values(j.id,input_index,input_org,p.id,result_value);
 return result_value;
end $$;
revoke all on function public.apply_catalog_zf_job_item(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.apply_catalog_zf_job_item(uuid,uuid,uuid,integer) to service_role;
select pg_notify('pgrst','reload schema');
