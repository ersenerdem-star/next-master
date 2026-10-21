set local lock_timeout='2s';
set local statement_timeout='30s';
-- Supplemental reads are independent of the primary upload cursor. Canonical
-- completion requires an authenticated tenant administrator's explicit review.
create table supplier_price_ingestion_internal.catalog_secondary_reviews (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null, job_id uuid not null references supplier_price_ingestion_internal.catalog_enrichment_jobs(id) on delete cascade,
 source_row_number bigint not null, product_id uuid not null, brand_id uuid not null, product_code text not null,
 official_evidence jsonb not null, status text not null default 'queued' check(status in ('queued','running','retry_wait','reviewed','observed','applied','blocked','held')),
 before_values jsonb, observation jsonb, proposal jsonb, application jsonb,
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 lease_token uuid, lease_until timestamptz, error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(job_id,source_row_number)
);
create index catalog_secondary_ready on supplier_price_ingestion_internal.catalog_secondary_reviews(next_attempt_at,created_at) where status in ('queued','running','retry_wait');
create index catalog_secondary_release_page on supplier_price_ingestion_internal.catalog_secondary_reviews(job_id,source_row_number);
alter table supplier_price_ingestion_internal.catalog_secondary_reviews enable row level security;
revoke all on supplier_price_ingestion_internal.catalog_secondary_reviews from public,anon,authenticated,service_role;
create table supplier_price_ingestion_internal.catalog_secondary_attempts (
 review_id uuid not null,attempt integer not null,observation jsonb,error_code text,created_at timestamptz not null default now(),primary key(review_id,attempt)
);
alter table supplier_price_ingestion_internal.catalog_secondary_attempts enable row level security;
revoke all on supplier_price_ingestion_internal.catalog_secondary_attempts from public,anon,authenticated,service_role;
alter table supplier_price_ingestion_internal.catalog_enrichment_jobs add column secondary_enqueue_errors bigint not null default 0;

create function supplier_price_ingestion_internal.secondary_source_allowed(input_org uuid,input_brand uuid,input_apply boolean default false)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.catalog_external_sources s join public.brands b on b.organization_id=s.organization_id
  where b.organization_id=input_org and b.id=input_brand and s.source_key='spareto_secondary_exact_v1' and s.is_active
   and s.license_posture in ('allowed','internal_review_required') and s.credential_boundary='none' and s.rate_limit_posture='bounded'
   and s.metadata->'secondary_review_read_allowed'='true'::jsonb and s.metadata->'allowed_brands' ? b.name
   and nullif(s.metadata->>'approval_actor','') is not null and nullif(s.metadata->>'publication_approval_reference','') is not null
   and (not input_apply or s.metadata->'secondary_review_apply_allowed'='true'::jsonb));
$$;
revoke all on function supplier_price_ingestion_internal.secondary_source_allowed(uuid,uuid,boolean) from public,anon,authenticated,service_role;

create function supplier_price_ingestion_internal.queue_secondary_catalog_review() returns trigger
language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 if new.phase<>'official' or new.product_id is null or new.evidence->>'authority' is distinct from 'official'
  or new.evidence->>'sourceOutcome' is distinct from 'matched' or new.issues @> '[{"field":"ean","code":"EAN_IDENTITY_CONFLICT"}]'::jsonb then return new;end if;
 select * into j from supplier_price_ingestion_internal.catalog_enrichment_jobs where id=new.job_id;
 if not supplier_price_ingestion_internal.secondary_source_allowed(j.organization_id,j.brand_id) then return new;end if;
 if jsonb_array_length(new.missing_fields)=0 and coalesce(new.evidence#>>'{lifecycle,checks,replacement}','unsupported')<>'unsupported'
  and coalesce(new.evidence#>>'{lifecycle,checks,discontinued}','unsupported')<>'unsupported' then return new;end if;
 insert into supplier_price_ingestion_internal.catalog_secondary_reviews(organization_id,job_id,source_row_number,product_id,brand_id,product_code,official_evidence)
 values(j.organization_id,j.id,new.source_row_number,new.product_id,j.brand_id,new.product_code,new.evidence) on conflict(job_id,source_row_number)do nothing;
 return new;
exception when others then
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set secondary_enqueue_errors=secondary_enqueue_errors+1 where id=new.job_id;
 raise warning 'CATALOG_SECONDARY_QUEUE_FAILED job=% state=%',new.job_id,sqlstate;
 return new;
end$$;
revoke all on function supplier_price_ingestion_internal.queue_secondary_catalog_review() from public,anon,authenticated,service_role;
create trigger queue_secondary_catalog_review after insert on supplier_price_ingestion_internal.catalog_enrichment_changes
 for each row execute function supplier_price_ingestion_internal.queue_secondary_catalog_review();

create function public.claim_supplier_catalog_secondary_review() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;token uuid:=gen_random_uuid();p jsonb;brand text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SECONDARY_SERVICE_REQUIRED';end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-secondary-consumer-v1',0))
  or exists(select 1 from supplier_price_ingestion_internal.catalog_secondary_reviews where status='running' and lease_until>clock_timestamp()) then return null;end if;
 select candidate.* into q from supplier_price_ingestion_internal.catalog_secondary_reviews candidate
 where candidate.status in ('queued','running','retry_wait') and candidate.next_attempt_at<=clock_timestamp()
  and (candidate.lease_until is null or candidate.lease_until<clock_timestamp())
  and supplier_price_ingestion_internal.secondary_source_allowed(candidate.organization_id,candidate.brand_id)
 order by candidate.next_attempt_at,candidate.created_at,candidate.id limit 1 for update skip locked;
 if not found then return null;end if;
 select to_jsonb(c) into p from public.catalog_products c where c.organization_id=q.organization_id and c.brand_id=q.brand_id and c.id=q.product_id
  and public.normalize_catalog_product_code(c.product_code)=public.normalize_catalog_product_code(q.product_code);
 if p is null then
  update supplier_price_ingestion_internal.catalog_secondary_reviews set status='blocked',error_code='SECONDARY_CATALOG_IDENTITY_CHANGED',updated_at=now() where id=q.id;
  return jsonb_build_object('skipped',true);
 end if;
 update supplier_price_ingestion_internal.catalog_secondary_reviews set status='running',lease_token=token,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,before_values=p,updated_at=now() where id=q.id;
 select name into brand from public.brands where id=q.brand_id and organization_id=q.organization_id;
 return jsonb_build_object('id',q.id,'token',token,'organizationId',q.organization_id,'brand',brand,'code',q.product_code,'before',p,
  'official',jsonb_build_object('authority','official','brand',brand,'code',public.normalize_catalog_product_code(q.product_code),'sourceUrl',q.official_evidence->>'sourceUrl',
   'fingerprint',q.official_evidence->>'fingerprint','fields',case when nullif(q.official_evidence->>'sourceEan','') is not null then jsonb_build_object('ean',q.official_evidence->>'sourceEan') else '{}'::jsonb end));
end$$;

create function public.read_supplier_catalog_secondary_claim(input_id uuid,input_token uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;brand text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SECONDARY_SERVICE_REQUIRED';end if;
 select * into q from supplier_price_ingestion_internal.catalog_secondary_reviews where id=input_id and status='running' and lease_token=input_token and lease_until>clock_timestamp();
 if not found or not supplier_price_ingestion_internal.secondary_source_allowed(q.organization_id,q.brand_id) then raise exception 'SECONDARY_LEASE_LOST';end if;
 select name into brand from public.brands where organization_id=q.organization_id and id=q.brand_id;
 return jsonb_build_object('id',q.id,'token',q.lease_token,'organizationId',q.organization_id,'brand',brand,'code',q.product_code,'before',q.before_values,
  'official',jsonb_build_object('authority','official','brand',brand,'code',public.normalize_catalog_product_code(q.product_code),'sourceUrl',q.official_evidence->>'sourceUrl',
   'fingerprint',q.official_evidence->>'fingerprint','fields',case when nullif(q.official_evidence->>'sourceEan','') is not null then jsonb_build_object('ean',q.official_evidence->>'sourceEan') else '{}'::jsonb end));
end$$;

create function public.finish_supplier_catalog_secondary_review(input_id uuid,input_token uuid,input_observation jsonb default null,input_proposal jsonb default null,input_error text default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;brand text;item record;transient boolean;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SECONDARY_SERVICE_REQUIRED';end if;
 select * into q from supplier_price_ingestion_internal.catalog_secondary_reviews where id=input_id and status='running' and lease_token=input_token and lease_until>clock_timestamp() for update;
 if not found then raise exception 'SECONDARY_LEASE_LOST';end if;
 if input_error is not null then
  insert into supplier_price_ingestion_internal.catalog_secondary_attempts(review_id,attempt,observation,error_code)values(q.id,q.attempts,case when octet_length(input_observation::text)<4000 then input_observation else null end,left(input_error,100));
  transient:=input_error~'(HTTP_(429|5[0-9]{2})|TIMEOUT|NETWORK)' and q.attempts<4;
  update supplier_price_ingestion_internal.catalog_secondary_reviews set status=case when transient then 'retry_wait' else 'blocked' end,
   error_code=case when input_error~'^[A-Z][A-Z0-9_]{1,99}$' then input_error else 'SECONDARY_SOURCE_FAILED' end,
   observation=case when jsonb_typeof(input_observation)='object' and octet_length(input_observation::text)<4000 then input_observation else observation end,
   next_attempt_at=clock_timestamp()+q.attempts*interval '2 minutes',lease_token=null,lease_until=null,updated_at=now() where id=q.id;
  return jsonb_build_object('status',case when transient then 'retry_wait' else 'blocked' end);
 end if;
 select name into brand from public.brands where organization_id=q.organization_id and id=q.brand_id;
 if input_observation is null or input_proposal is null or octet_length(input_observation::text)+octet_length(input_proposal::text)>128000
  or input_observation->>'brand' is distinct from brand or input_observation->'exactIdentity' is distinct from 'true'::jsonb
  or public.normalize_catalog_product_code(input_observation->>'code') is distinct from public.normalize_catalog_product_code(q.product_code)
  or coalesce(input_observation->>'sourceUrl','')!~'^https://spareto[.]com/products/[a-zA-Z0-9._~%/-]+$'
  or coalesce(input_observation->>'fingerprint','')!~'^[a-f0-9]{64}$'
  or jsonb_typeof(input_proposal->'fields') is distinct from 'object'
  or not supplier_price_ingestion_internal.secondary_source_allowed(q.organization_id,q.brand_id) then raise exception 'SECONDARY_RECEIPT_INVALID';end if;
 for item in select key,value from jsonb_each(input_proposal->'fields') loop
  if item.key not in ('description','description_tr','oem_no','vehicle','vehicle_model','ean','market_segment','weight_kg','dimensions','origin','hs_code')
   or item.value is distinct from input_observation->'fields'->item.key
   or nullif(btrim(q.before_values->>item.key),'') is not null then raise exception 'SECONDARY_MISSING_ONLY_REQUIRED';end if;
  if item.key='dimensions' then
   if jsonb_typeof(item.value)<>'object' then raise exception 'SECONDARY_FIELD_INVALID';end if;
  elsif item.key='weight_kg' then
   if jsonb_typeof(item.value)<>'number' or (item.value#>>'{}')::numeric<=0 or (item.value#>>'{}')::numeric>100000 then raise exception 'SECONDARY_FIELD_INVALID';end if;
  elsif jsonb_typeof(item.value)<>'string' or nullif(btrim(item.value#>>'{}'),'') is null or length(item.value#>>'{}')>12000 then raise exception 'SECONDARY_FIELD_INVALID';end if;
  if item.key='origin' and (item.value#>>'{}')!~'^[A-Z]{2}$' then raise exception 'SECONDARY_FIELD_INVALID';end if;
  if item.key='hs_code' and (item.value#>>'{}')!~'^[0-9]{6,12}$' then raise exception 'SECONDARY_FIELD_INVALID';end if;
 end loop;
 insert into supplier_price_ingestion_internal.catalog_secondary_attempts(review_id,attempt,observation)values(q.id,q.attempts,input_observation);
 update supplier_price_ingestion_internal.catalog_secondary_reviews set observation=input_observation,proposal=input_proposal,status=case when input_proposal->>'status'='review_required' then 'held' when input_proposal->'fields'='{}'::jsonb then 'observed' else 'reviewed' end,error_code=null,lease_token=null,lease_until=null,updated_at=now() where id=q.id;
 return jsonb_build_object('status',case when input_proposal->>'status'='review_required' then 'held' when input_proposal->'fields'='{}'::jsonb then 'observed' else 'reviewed' end);
end$$;

create function public.get_supplier_catalog_secondary_reviews(input_release_id uuid,input_after_row bigint default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();job uuid;items jsonb;counts jsonb;
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'SECONDARY_ADMIN_REQUIRED';end if;
 select id into job from supplier_price_ingestion_internal.catalog_enrichment_jobs where organization_id=org and release_id=input_release_id;
 select jsonb_object_agg(status,n) into counts from (select status,count(*) n from supplier_price_ingestion_internal.catalog_secondary_reviews where organization_id=org and job_id=job group by status) s;
 select jsonb_agg(to_jsonb(x) order by source_row_number) into items from (
  select id,source_row_number,product_code,status,error_code,before_values,observation,proposal,application
  from supplier_price_ingestion_internal.catalog_secondary_reviews where organization_id=org and job_id=job and source_row_number>input_after_row order by source_row_number limit 21
 ) x;
 return jsonb_build_object('counts',coalesce(counts,'{}'::jsonb),'items',coalesce(items,'[]'::jsonb),
  'enqueueErrors',coalesce((select secondary_enqueue_errors from supplier_price_ingestion_internal.catalog_enrichment_jobs where id=job),0));
end$$;

create table supplier_price_ingestion_internal.catalog_secondary_applications (
 review_id uuid primary key,organization_id uuid not null,product_id uuid not null,
 official_evidence jsonb not null,secondary_evidence jsonb not null,application jsonb not null,created_at timestamptz not null default now()
);
create index catalog_secondary_applications_product on supplier_price_ingestion_internal.catalog_secondary_applications(organization_id,product_id,created_at);
alter table supplier_price_ingestion_internal.catalog_secondary_applications enable row level security;
revoke all on supplier_price_ingestion_internal.catalog_secondary_applications from public,anon,authenticated,service_role;

create function supplier_price_ingestion_internal.apply_secondary_review_one(input_org uuid,input_actor uuid,input_id uuid,input_automatic boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare org uuid:=input_org;actor uuid:=input_actor;v_id uuid:=input_id;q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;p public.catalog_products%rowtype;
 item record;patch jsonb;outcomes jsonb;before_row jsonb;
begin
  select * into q from supplier_price_ingestion_internal.catalog_secondary_reviews where catalog_secondary_reviews.id=v_id and organization_id=org for update;
  if not found then raise exception 'SECONDARY_REVIEW_SCOPE_MISMATCH';end if;
  if q.status='applied' then return jsonb_build_object('id',v_id,'status','applied');end if;
  if q.status<>'reviewed' or not supplier_price_ingestion_internal.secondary_source_allowed(org,q.brand_id,true) then raise exception 'SECONDARY_REVIEW_NOT_READY';end if;
  -- Secondary source reads may proceed separately, but canonical writes share
  -- the primary scheduler's gate and never overlap an active primary turn.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-enrichment-consumer-v1',0))
   or exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and lease_until>clock_timestamp()) then
   return jsonb_build_object('id',v_id,'status','deferred','reason','PRIMARY_CATALOG_TURN_ACTIVE');
  end if;
  select * into p from public.catalog_products where catalog_products.id=q.product_id and organization_id=org and brand_id=q.brand_id for update;
  if not found or public.normalize_catalog_product_code(p.product_code)<>public.normalize_catalog_product_code(q.product_code) then raise exception 'SECONDARY_CATALOG_IDENTITY_CHANGED';end if;
  before_row:=to_jsonb(p);patch:='{}';outcomes:='{}';
  if nullif(btrim(p.ean),'') is not null and nullif(btrim(q.observation->'fields'->>'ean'),'') is not null
   and regexp_replace(p.ean,'\s','','g')<>regexp_replace(q.observation->'fields'->>'ean','\s','','g') then
   update supplier_price_ingestion_internal.catalog_secondary_reviews set status='held',application=jsonb_build_object('actor',actor,'reason','EAN_IDENTITY_CONFLICT','before',before_row),updated_at=now() where catalog_secondary_reviews.id=v_id;
   return jsonb_build_object('id',v_id,'status','held');
  end if;
  if coalesce(q.proposal->>'status','')<>'staged_candidate' then raise exception 'SECONDARY_IDENTITY_REVIEW_REQUIRED';end if;
  for item in select key,value from jsonb_each(q.proposal->'fields') loop
   if nullif(btrim(before_row->>item.key),'') is not null then outcomes:=outcomes||jsonb_build_object(item.key,'existing_value_preserved');
   elsif before_row->item.key is distinct from q.before_values->item.key then outcomes:=outcomes||jsonb_build_object(item.key,'changed_since_review');
   else patch:=patch||jsonb_build_object(item.key,item.value);outcomes:=outcomes||jsonb_build_object(item.key,'applied');end if;
  end loop;
  if patch<>'{}' then
   update public.catalog_products cp set
    description=case when patch?'description' then patch->>'description' else cp.description end,
    description_tr=case when patch?'description_tr' then patch->>'description_tr' else cp.description_tr end,
    oem_no=case when patch?'oem_no' then patch->>'oem_no' else cp.oem_no end,
    vehicle=case when patch?'vehicle' then patch->>'vehicle' else cp.vehicle end,
    vehicle_model=case when patch?'vehicle_model' then patch->>'vehicle_model' else cp.vehicle_model end,
    ean=case when patch?'ean' then patch->>'ean' else cp.ean end,
    market_segment=case when patch?'market_segment' then patch->>'market_segment' else cp.market_segment end,
    weight_kg=case when patch?'weight_kg' then (patch->>'weight_kg')::numeric else cp.weight_kg end,
    dimensions=case when patch?'dimensions' then patch->'dimensions' else cp.dimensions end,
    origin=case when patch?'origin' then patch->>'origin' else cp.origin end,
    hs_code=case when patch?'hs_code' then patch->>'hs_code' else cp.hs_code end,updated_at=now()
   where cp.id=p.id;
  end if;
  insert into supplier_price_ingestion_internal.catalog_secondary_applications(review_id,organization_id,product_id,official_evidence,secondary_evidence,application)
  values(v_id,org,p.id,q.official_evidence,q.observation,jsonb_build_object('actor',actor,'automatic',input_automatic,'before',before_row,'patch',patch,'fields',outcomes,'sourceUrl',q.observation->>'sourceUrl','fingerprint',q.observation->>'fingerprint')) on conflict(review_id)do nothing;
  update supplier_price_ingestion_internal.catalog_secondary_reviews set status='applied',application=jsonb_build_object('actor',actor,'automatic',input_automatic,'before',before_row,'patch',patch,'fields',outcomes,'sourceUrl',q.observation->>'sourceUrl','fingerprint',q.observation->>'fingerprint'),updated_at=now() where catalog_secondary_reviews.id=v_id;
  return jsonb_build_object('id',v_id,'status','applied','fields',outcomes);
end$$;
revoke all on function supplier_price_ingestion_internal.apply_secondary_review_one(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;

create function public.apply_supplier_catalog_secondary_reviews(input_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='15s' as $$
declare org uuid:=public.current_profile_org_id();actor uuid:=auth.uid();v_id uuid;result jsonb:='[]';
begin
 if actor is null or org is null or not exists(select 1 from public.profiles where profiles.id=actor and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'SECONDARY_ADMIN_REQUIRED';end if;
 if input_ids is null or cardinality(input_ids) not between 1 and 20 then raise exception 'SECONDARY_REVIEW_PAGE_LIMIT';end if;
 foreach v_id in array input_ids loop
  result:=result||jsonb_build_array(supplier_price_ingestion_internal.apply_secondary_review_one(org,actor,v_id,false));
 end loop;
 return result;
end$$;

create function public.apply_supplier_catalog_secondary_approved(input_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='15s' as $$
declare q supplier_price_ingestion_internal.catalog_secondary_reviews%rowtype;actor uuid;source_metadata jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SECONDARY_SERVICE_REQUIRED';end if;
 select candidate.* into q from supplier_price_ingestion_internal.catalog_secondary_reviews candidate
 join public.catalog_external_sources src on src.organization_id=candidate.organization_id and src.source_key='spareto_secondary_exact_v1'
 where candidate.status='reviewed' and (input_id is null or candidate.id=input_id)
  and src.metadata->'secondary_review_automatic_apply_allowed'='true'::jsonb
  and coalesce(src.metadata->>'approval_actor','')~'^[a-f0-9-]{36}$'
  and not exists(select 1 from jsonb_object_keys(candidate.proposal->'fields') k where not(src.metadata->'automatic_fields' ? k))
  and supplier_price_ingestion_internal.secondary_source_allowed(candidate.organization_id,candidate.brand_id,true)
 order by candidate.updated_at,candidate.id limit 1 for update of candidate skip locked;
 if not found then return null;end if;
 select metadata into source_metadata from public.catalog_external_sources where organization_id=q.organization_id and source_key='spareto_secondary_exact_v1';
 if coalesce(source_metadata->>'approval_actor','')!~'^[a-f0-9-]{36}$' then raise exception 'SECONDARY_AUTOMATIC_APPROVAL_REQUIRED';end if;
 actor:=(source_metadata->>'approval_actor')::uuid;
 if not exists(select 1 from public.profiles where profiles.id=actor and organization_id=q.organization_id and is_active and role in ('admin','superadmin'))
  or coalesce(q.proposal->>'status','')<>'staged_candidate' then raise exception 'SECONDARY_AUTOMATIC_APPROVAL_REQUIRED';end if;
 if exists(select 1 from jsonb_object_keys(q.proposal->'fields') k where not(source_metadata->'automatic_fields' ? k)) then raise exception 'SECONDARY_AUTOMATIC_FIELD_NOT_APPROVED';end if;
 return supplier_price_ingestion_internal.apply_secondary_review_one(q.organization_id,actor,q.id,true);
end$$;
revoke all on function public.apply_supplier_catalog_secondary_approved(uuid) from public,anon,authenticated;
grant execute on function public.apply_supplier_catalog_secondary_approved(uuid) to service_role;

revoke all on function public.claim_supplier_catalog_secondary_review(),public.finish_supplier_catalog_secondary_review(uuid,uuid,jsonb,jsonb,text),public.get_supplier_catalog_secondary_reviews(uuid,bigint),public.apply_supplier_catalog_secondary_reviews(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.claim_supplier_catalog_secondary_review(),public.finish_supplier_catalog_secondary_review(uuid,uuid,jsonb,jsonb,text) to service_role;
grant execute on function public.get_supplier_catalog_secondary_reviews(uuid,bigint),public.apply_supplier_catalog_secondary_reviews(uuid[]) to authenticated;

revoke all on function public.read_supplier_catalog_secondary_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_supplier_catalog_secondary_claim(uuid,uuid) to service_role;
