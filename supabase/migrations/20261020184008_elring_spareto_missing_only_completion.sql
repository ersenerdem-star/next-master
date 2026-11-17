-- Secondary completion is explicitly scoped to one approved, sealed Elring run.
-- The generic source remains review-gated. No primary value is replaced.
set lock_timeout='500ms';
set statement_timeout='5s';
create table public.catalog_elring_spareto_jobs (
 run_id uuid primary key references public.catalog_import_runs(id),
 organization_id uuid not null references public.organizations(id),
 brand_id uuid not null references public.brands(id),
 source_id uuid not null references public.catalog_external_sources(id),
 manifest_fingerprint text not null,
 approval_reference text not null check(length(trim(approval_reference))>0),
 approved_until timestamptz not null,
 expected_products integer not null check(expected_products between 1 and 21543),
 status text not null default 'approved' check(status in ('approved','running','paused','completed')),
 scalar_processed integer not null default 0,
 vehicle_processed integer not null default 0,
 changed integer not null default 0,
 updated_at timestamptz not null default now()
);
create table public.catalog_elring_spareto_events (
 run_id uuid not null references public.catalog_elring_spareto_jobs(run_id),
 row_index integer not null,
 phase text not null check(phase in ('scalars','vehicle')),
 organization_id uuid not null,
 product_id uuid not null references public.catalog_products(id),
 product_code text not null,
 source_record_id uuid references public.catalog_product_source_records(id),
 evidence_fingerprint text not null,
 evidence jsonb not null,
 before_fields jsonb not null,
 after_fields jsonb not null,
 applied_fields jsonb not null,
 conflicts jsonb not null,
 created_at timestamptz not null default now(),
 primary key(run_id,row_index,phase)
);
alter table public.catalog_elring_spareto_jobs enable row level security;
alter table public.catalog_elring_spareto_events enable row level security;
revoke all on public.catalog_elring_spareto_jobs,public.catalog_elring_spareto_events from public,anon,authenticated,service_role;
grant select on public.catalog_elring_spareto_jobs,public.catalog_elring_spareto_events to service_role;

create function public.apply_elring_spareto_completion(input_run_id uuid,input_row_index integer,input_phase text,input_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='3s' set lock_timeout='250ms'
as $$
declare
 j public.catalog_elring_spareto_jobs%rowtype; s public.catalog_external_sources%rowtype;
 st public.catalog_import_stage%rowtype; p public.catalog_products%rowtype;
 old_event public.catalog_elring_spareto_events%rowtype;
 v_fp text; v_url text; v_before jsonb; v_after jsonb; v_patch jsonb:='{}';
 v_applied jsonb:='[]'; v_conflicts jsonb:='{}'; v_fields jsonb;
 f text; v text; existing text; sr uuid; n public.catalog_products%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if input_phase is null or input_phase not in ('scalars','vehicle') then raise exception 'Invalid secondary phase'; end if;
 select * into j from public.catalog_elring_spareto_jobs where run_id=input_run_id for update;
 if j.run_id is null or j.status='paused' or j.approved_until<now() then raise exception 'Secondary approval missing or expired'; end if;
 select * into s from public.catalog_external_sources where id=j.source_id and organization_id=j.organization_id;
 if s.source_key is distinct from 'spareto_elring_product_catalog' or s.is_active is distinct from true
  or s.license_posture is distinct from 'allowed'
  or not exists(select 1 from public.brands where id=j.brand_id and organization_id=j.organization_id and lower(name)='elring')
  or not exists(select 1 from public.catalog_import_runs where id=j.run_id and organization_id=j.organization_id
    and input_scope->>'source_key'='tecalliance_elring' and input_scope->>'collection_verified'='true'
    and input_scope->>'manifest_fingerprint'=j.manifest_fingerprint)
  or not exists(select 1 from public.catalog_provider_stage_publications where run_id=j.run_id and brand_id=j.brand_id and status='completed')
 then raise exception 'Secondary scope mismatch'; end if;
 select * into st from public.catalog_import_stage where run_id=j.run_id and organization_id=j.organization_id and row_index=input_row_index;
 v_url:=input_evidence->>'source_url';
 if st.run_id is null or st.source_key is distinct from 'tecalliance_elring'
  or st.source_payload->'raw'->>'mfrName' is distinct from 'ELRING'
  or st.source_payload->'raw'->>'dataSupplierId' is distinct from '10'
  or input_evidence->>'product_code' is distinct from st.product_code
  or input_evidence->>'stage_fingerprint' is distinct from st.source_fingerprint
  or v_url is null or v_url !~ '^https://spareto\.com/products/elring-[a-z0-9-]+/[a-z0-9-]+$'
  or public.normalize_part_code(regexp_replace(v_url,'^.*/','')) is distinct from st.normalized_code
 then raise exception 'Secondary exact identity mismatch'; end if;
 if input_evidence->>'status' is distinct from 'source_404' and (
  input_evidence->>'brand' is distinct from 'ELRING'
  or input_evidence->'raw_item'->>'item_brand' is distinct from 'ELRING'
  or input_evidence->'raw_item'->>'item_id' is distinct from st.product_code
  or input_evidence->'raw_item'->>'item_list_id' is distinct from 'variant'
  or coalesce(input_evidence->>'html_sha256','') !~ '^[a-f0-9]{64}$'
  or input_evidence->>'schema_version' is distinct from 'elring-spareto.v1'
 ) then raise exception 'Secondary detail evidence missing'; end if;
 v_fields:=coalesce(input_evidence->'fields','{}');
 if jsonb_typeof(v_fields)<>'object' or exists(select 1 from jsonb_object_keys(v_fields) k
  where k not in ('weight_kg','origin','hs_code','ean','oem_no','image_url','vehicle','vehicle_model','market_segment'))
  or (input_evidence->>'status'='source_404' and v_fields<>'{}')
 then raise exception 'Secondary field allowlist mismatch'; end if;
 v_fp:=public.catalog_provider_jsonb_sha256(input_evidence);
 select * into old_event from public.catalog_elring_spareto_events where run_id=j.run_id and row_index=input_row_index and phase=input_phase;
 if found then
  if old_event.evidence_fingerprint<>v_fp then raise exception 'Secondary receipt evidence mismatch'; end if;
  return jsonb_build_object('status','already_applied','applied_fields',old_event.applied_fields);
 end if;
 if j.status='completed' then raise exception 'Secondary job already completed'; end if;
 -- Never let a helper pre-empt the still-running official vehicle collector.
 if input_phase='vehicle' and not exists(select 1 from public.catalog_elring_completion_events
  where run_id=j.run_id and phase='fitment' and row_index=input_row_index)
 then return jsonb_build_object('status','waiting_for_official_vehicle'); end if;
 select * into p from public.catalog_products where organization_id=j.organization_id and brand_id=j.brand_id and normalized_code=st.normalized_code for update;
 if p.id is null then raise exception 'Secondary canonical product missing'; end if;
 v_before:=jsonb_build_object('weight_kg',p.weight_kg,'origin',p.origin,'hs_code',p.hs_code,'ean',p.ean,
  'oem_no',p.oem_no,'image_url',p.image_url,'vehicle',p.vehicle,'vehicle_model',p.vehicle_model,'market_segment',p.market_segment);
 for f,v in select key,value from jsonb_each_text(v_fields)
 loop
  if (input_phase='vehicle') is distinct from (f in ('vehicle','vehicle_model')) then continue; end if;
  if v is null or length(trim(v))=0 then continue; end if;
  if length(v)>50000 or (f='weight_kg' and (v !~ '^[0-9]+(\.[0-9]+)?$' or v::numeric<=0 or v::numeric>1000))
   or (f='origin' and v !~ '^[A-Z]{2}$') or (f='hs_code' and v !~ '^[0-9]{6,12}$')
   or (f='ean' and v !~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$')
   or (f='image_url' and (v !~ '^https://cdn\.spareto\.com/variants/images/' or v ~* '(placeholder|noimage|no-image|default)'))
   or (f='market_segment' and v not in ('pc','cv','lcv','motorcycle','engines','universal','marine','industrial','agriculture'))
  then raise exception 'Invalid secondary field %',f; end if;
  existing:=nullif(trim(v_before->>f),'');
  if existing is null then
   v_patch:=v_patch||jsonb_build_object(f,v_fields->f);v_applied:=v_applied||jsonb_build_array(f);
  elsif existing is distinct from v then
   v_conflicts:=v_conflicts||jsonb_build_object(f,jsonb_build_object('existing',existing,'candidate',v));
   if f<>'image_url' then
    insert into public.product_attribute_conflicts(organization_id,product_id,brand_id,product_code,field_name,existing_value,incoming_value,normalized_incoming_value,source_type,source_reference)
    values(j.organization_id,p.id,j.brand_id,p.product_code,f,existing,v,public.normalize_product_conflict_value(f,v),s.source_key,v_url)
    on conflict(organization_id,product_id,field_name,normalized_incoming_value) where status='pending_review'
    do update set last_detected_at=now(),detection_count=public.product_attribute_conflicts.detection_count+1;
   end if;
  end if;
 end loop;
 if v_patch<>'{}' then
  n:=jsonb_populate_record(p,v_patch);
  update public.catalog_products set weight_kg=n.weight_kg,origin=n.origin,hs_code=n.hs_code,ean=n.ean,
   oem_no=n.oem_no,image_url=n.image_url,vehicle=n.vehicle,vehicle_model=n.vehicle_model,market_segment=n.market_segment,updated_at=now()
   where id=p.id and organization_id=j.organization_id;
 end if;
 select jsonb_build_object('weight_kg',weight_kg,'origin',origin,'hs_code',hs_code,'ean',ean,'oem_no',oem_no,'image_url',image_url,
  'vehicle',vehicle,'vehicle_model',vehicle_model,'market_segment',market_segment) into v_after from public.catalog_products where id=p.id;
 if exists(select 1 from jsonb_each(v_before) b where nullif(trim(b.value#>>'{}'),'') is not null and b.value is distinct from v_after->b.key)
 then raise exception 'Secondary populated field overwrite'; end if;
 insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
 values(j.organization_id,p.id,s.source_key,v_url,p.product_code,'elring-spareto.v1',v_fp)
 on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
 select id into sr from public.catalog_product_source_records where organization_id=j.organization_id and catalog_product_id=p.id and source_key=s.source_key and payload_fingerprint=v_fp;
 insert into public.catalog_elring_spareto_events(run_id,row_index,phase,organization_id,product_id,product_code,source_record_id,evidence_fingerprint,evidence,before_fields,after_fields,applied_fields,conflicts)
 values(j.run_id,input_row_index,input_phase,j.organization_id,p.id,p.product_code,sr,v_fp,input_evidence,v_before,v_after,v_applied,v_conflicts);
 update public.catalog_elring_spareto_jobs set scalar_processed=scalar_processed+case when input_phase='scalars' then 1 else 0 end,
  vehicle_processed=vehicle_processed+case when input_phase='vehicle' then 1 else 0 end,
  changed=changed+case when v_patch<>'{}' then 1 else 0 end,status='running',updated_at=now() where run_id=j.run_id;
 return jsonb_build_object('status','applied','applied_fields',v_applied,'conflicts',v_conflicts);
end;
$$;
revoke all on function public.apply_elring_spareto_completion(uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_elring_spareto_completion(uuid,integer,text,jsonb) to service_role;
create function public.finish_elring_spareto_completion(input_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='3s' set lock_timeout='250ms'
as $$
declare j public.catalog_elring_spareto_jobs%rowtype; n integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_elring_spareto_jobs where run_id=input_run_id for update;
 if j.run_id is null or j.status='paused' or j.approved_until<now() then raise exception 'Secondary approval missing or expired'; end if;
 select count(*) into n from public.catalog_elring_spareto_events where run_id=j.run_id;
 if j.scalar_processed<>j.expected_products or j.vehicle_processed<>j.expected_products or n<>2*j.expected_products
 then raise exception 'Secondary coverage incomplete'; end if;
 if not exists(select 1 from public.catalog_elring_completion_jobs where run_id=j.run_id and phase='fitment' and status='completed')
 then raise exception 'Official vehicles incomplete'; end if;
 update public.catalog_elring_spareto_jobs set status='completed',updated_at=now() where run_id=j.run_id returning * into j;
 return to_jsonb(j);
end;
$$;
revoke all on function public.finish_elring_spareto_completion(uuid) from public,anon,authenticated;
grant execute on function public.finish_elring_spareto_completion(uuid) to service_role;
notify pgrst,'reload schema';
