-- TITANX Martex reference enrichment: verified observations are staged before
-- a service-only, row-locked, missing-only write. The collector independently
-- verifies raw HTML bytes, exact manufacturer/code, references and timestamps;
-- this migration records that attestation and does not fetch source content.
-- Multiple OEM codes are stored individually with provenance. A single OEM
-- alone is copied to the legacy scalar field; multiple are not concatenated.

-- Insert-only source admission: never overwrite another session's settings.
create function public.register_martex_titanx_reference_source_v2(input_organization_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare source_id uuid; created boolean:=false; src public.catalog_external_sources%rowtype;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'MARTEX_SERVICE_ROLE_REQUIRED'; end if;
 if input_organization_id is null or not exists(select 1 from public.brands b where b.organization_id=input_organization_id and lower(btrim(b.name))='titanx') then raise exception 'MARTEX_BRAND_SCOPE_INVALID'; end if;
 insert into public.catalog_external_sources(organization_id,source_key,display_name,source_owner,source_type,base_url,license_posture,robots_posture,rate_limit_posture,is_active,metadata)
 values(input_organization_id,'martex_titanx_observation_v1','Martex TITANX product reference','Martex','open_web','https://sklep.martextruck.pl','internal_review_required','restricted','bounded',true,
   jsonb_build_object('reference_enrichment_allowed',true,'request_basis','user_requested_martex_titanx_enrichment','minimum_request_interval_seconds',2,'robots_excluded_paths_respected',true))
 on conflict(organization_id,source_key) do nothing returning id into source_id;
 if source_id is not null then created:=true; end if;
 select * into src from public.catalog_external_sources s where s.organization_id=input_organization_id and s.source_key='martex_titanx_observation_v1';
 if src.id is null or not src.is_active or src.source_type<>'open_web' or src.base_url<>'https://sklep.martextruck.pl'
   or src.license_posture not in ('allowed','internal_review_required') or src.metadata->'reference_enrichment_allowed' is distinct from 'true'::jsonb then
   raise exception 'MARTEX_EXISTING_SOURCE_REQUIRES_REVIEW';
 end if;
 return jsonb_build_object('id',src.id,'created',created,'license_posture',src.license_posture);
end $$;
revoke all on function public.register_martex_titanx_reference_source_v2(uuid) from public,anon,authenticated;
grant execute on function public.register_martex_titanx_reference_source_v2(uuid) to service_role;

create table public.catalog_martex_reference_observations_v2 (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null, brand_id uuid not null,
 product_code text not null, source_key text not null,
 source_url text not null, source_sha256 text not null,
 observed_at timestamptz not null, source_description_pl text not null,
 observed_references jsonb not null, selected_oem jsonb not null,
 selected_vehicle text, evidence jsonb not null,
 status text not null check(status in ('ready','held')),
 hold_reason text, created_at timestamptz not null default now(),
 unique(organization_id,brand_id,product_code,source_sha256)
);

create table public.catalog_martex_reference_events_v2 (
 observation_id uuid primary key references public.catalog_martex_reference_observations_v2(id),
 organization_id uuid not null, product_id uuid not null,
 source_key text not null, source_url text not null, source_sha256 text not null,
 before_fields jsonb not null, after_fields jsonb not null,
 outcomes jsonb not null, created_at timestamptz not null default now()
);

alter table public.catalog_martex_reference_observations_v2 enable row level security;
alter table public.catalog_martex_reference_events_v2 enable row level security;
revoke all on public.catalog_martex_reference_observations_v2 from public, anon, authenticated, service_role;
revoke all on public.catalog_martex_reference_events_v2 from public, anon, authenticated, service_role;

create function public.stage_martex_reference_v2(input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 org uuid; brand uuid; code text; source_url text; source_hash text; observed_at timestamptz;
 source_description text; refs jsonb; selected jsonb; vehicle text; vehicles jsonb; e jsonb; x jsonb;
 reason text; result_id uuid; product_count int; prior public.catalog_martex_reference_observations_v2%rowtype;
 allowed_oem_labels text[]:=array['MB','VOLVO','RVI','IVECO','SCANIA','MAN','FIAT','DAF-OE','FORD','OPEL','NISSAN','TOYOTA','ISUZU','MAZDA','HYUNDAI','MITSUBISHI','CHRYSLER'];
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'MARTEX_SERVICE_ROLE_REQUIRED'; end if;
 if jsonb_typeof(input) is distinct from 'object' then raise exception 'MARTEX_INPUT_INVALID'; end if;
 org:=nullif(input->>'organization_id','')::uuid; brand:=nullif(input->>'brand_id','')::uuid;
 code:=input->>'product_code'; source_url:=input->>'source_url'; source_hash:=input->>'source_sha256';
 observed_at:=nullif(input->>'observed_at','')::timestamptz; source_description:=input->>'source_description_pl';
 refs:=input->'observed_references'; selected:=input->'selected_oem'; vehicles:=coalesce(input->'selected_vehicles','[]'::jsonb);
 if jsonb_typeof(vehicles) is distinct from 'array' or jsonb_array_length(vehicles)>30 then raise exception 'MARTEX_VEHICLES_FORMAT_INVALID'; end if;
 for x in select value from jsonb_array_elements(vehicles) loop
  if jsonb_typeof(x) is distinct from 'string' or length(btrim(x#>>'{}'))<2 or length(btrim(x#>>'{}'))>256
   or position('|' in (x#>>'{}'))>0 or position(chr(10) in (x#>>'{}'))>0
   or strpos(upper(source_description),upper(btrim(x#>>'{}')))=0 then raise exception 'MARTEX_VEHICLE_NOT_EXPLICIT'; end if;
 end loop;
 select string_agg(v,' | ' order by ord) into vehicle from (select distinct on (value#>>'{}') btrim(value#>>'{}') v,ordinality ord from jsonb_array_elements(vehicles) with ordinality order by value#>>'{}',ordinality) q;
 e:=coalesce(input->'evidence','{}'::jsonb);
 if org is null or brand is null or code is null or code !~ '^[A-Z0-9]+$'
    or source_url is null or source_url !~ '^https://sklep\.martextruck\.pl/partscatalogue/[^?#[:space:]]+$'
    or source_hash is null or source_hash !~ '^[0-9a-f]{64}$' or observed_at is null
    or nullif(btrim(source_description),'') is null or length(source_description)>4096
    or jsonb_typeof(refs) is distinct from 'array' or jsonb_typeof(selected) is distinct from 'array'
    or jsonb_array_length(refs)>500 or jsonb_array_length(selected)>100 then
    raise exception 'MARTEX_EVIDENCE_FORMAT_INVALID';
 end if;
 if not exists(select 1 from public.brands b where b.id=brand and b.organization_id=org and lower(btrim(b.name))='titanx') then
    raise exception 'MARTEX_BRAND_SCOPE_INVALID';
 end if;
 if not exists(select 1 from public.catalog_external_sources s where s.organization_id=org
     and s.source_key='martex_titanx_observation_v1' and s.is_active
     and s.license_posture in ('allowed','internal_review_required')
     and s.base_url='https://sklep.martextruck.pl'
     and s.metadata->'reference_enrichment_allowed'='true'::jsonb) then
    raise exception 'MARTEX_SOURCE_NOT_CONFIGURED';
 end if;
 select count(*) into product_count from public.catalog_products p where p.organization_id=org and p.brand_id=brand
   and p.product_code=code and p.normalized_code=public.normalize_part_code(code);
 if product_count<>1 then reason:='EXACT_PRODUCT_NOT_UNIQUE';
 elsif e->>'primary_brand' is distinct from 'TITANX' or e->>'primary_code' is distinct from code
   or e->>'collector_html_sha256_verified' is distinct from 'true' then reason:='SOURCE_IDENTITY_NOT_VERIFIED';
 elsif jsonb_array_length(selected)=0 and vehicle is null then reason:='NO_SUPPORTED_CANDIDATES';
 elsif vehicle is not null and length(vehicle)>4096 then reason:='VEHICLE_TOO_LONG';
 else
  for x in select value from jsonb_array_elements(selected) loop
   if nullif(btrim(x->>'code'),'') is null or nullif(public.normalize_part_code(x->>'code'),'') is null or length(x->>'code')>100
     or (x->>'code') ~ '[|,;\r\n]' or not (upper(coalesce(x->>'manufacturer',''))=any(allowed_oem_labels))
     or not exists(select 1 from jsonb_array_elements(refs) r
       where r->>'code'=x->>'code' and upper(r->>'manufacturer')=upper(x->>'manufacturer')) then
     reason:='OEM_REFERENCE_NOT_EXPLICIT_OR_ALLOWED'; exit;
   end if;
  end loop;
 end if;
 insert into public.catalog_martex_reference_observations_v2
  (organization_id,brand_id,product_code,source_key,source_url,source_sha256,observed_at,source_description_pl,
   observed_references,selected_oem,selected_vehicle,evidence,status,hold_reason)
 values(org,brand,code,'martex_titanx_observation_v1',source_url,source_hash,observed_at,source_description,
   refs,selected,vehicle,e,case when reason is null then 'ready' else 'held' end,reason)
 on conflict (organization_id,brand_id,product_code,source_sha256) do nothing returning id into result_id;
 if result_id is null then
  select * into prior from public.catalog_martex_reference_observations_v2
   where organization_id=org and brand_id=brand and product_code=code and source_sha256=source_hash;
  if prior.source_url is distinct from source_url or prior.observed_at is distinct from observed_at
   or prior.source_description_pl is distinct from source_description or prior.observed_references is distinct from refs
   or prior.selected_oem is distinct from selected or prior.selected_vehicle is distinct from vehicle
   or prior.evidence is distinct from e then raise exception 'MARTEX_OBSERVATION_CONFLICT'; end if;
  return jsonb_build_object('id',prior.id,'status',prior.status,'reason',prior.hold_reason,'reused',true);
 end if;
 return jsonb_build_object('id',result_id,'status',case when reason is null then 'ready' else 'held' end,'reason',reason,'reused',false);
end $$;

create function public.apply_martex_reference_v2(input_observation_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 obs public.catalog_martex_reference_observations_v2%rowtype; p public.catalog_products%rowtype;
 existing public.catalog_martex_reference_events_v2%rowtype; before_fields jsonb; after_fields jsonb;
 outcomes jsonb:='{}'::jsonb; oem_text text; target_oem text; target_vehicle text; source_id uuid; identifiers_count int:=0; unique_oem_count int:=0;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'MARTEX_SERVICE_ROLE_REQUIRED'; end if;
 select * into obs from public.catalog_martex_reference_observations_v2 where id=input_observation_id for update;
 if not found then raise exception 'MARTEX_OBSERVATION_NOT_FOUND'; end if;
 if obs.status<>'ready' then return jsonb_build_object('status','held','reason',obs.hold_reason); end if;
 perform 1 from public.catalog_external_sources s where s.organization_id=obs.organization_id
   and s.source_key=obs.source_key and s.is_active and s.license_posture in ('allowed','internal_review_required')
   and s.base_url='https://sklep.martextruck.pl' and s.metadata->'reference_enrichment_allowed'='true'::jsonb
   for share;
 if not found then raise exception 'MARTEX_SOURCE_NOT_CONFIGURED'; end if;
 select * into existing from public.catalog_martex_reference_events_v2 where observation_id=obs.id;
 if found then return jsonb_build_object('status','already_processed','outcomes',existing.outcomes); end if;
 select * into p from public.catalog_products cp where cp.organization_id=obs.organization_id and cp.brand_id=obs.brand_id
   and cp.product_code=obs.product_code and cp.normalized_code=public.normalize_part_code(obs.product_code) for update;
 if not found then raise exception 'MARTEX_PRODUCT_CHANGED'; end if;
 -- Reuse canonical provenance and identity structures without changing existing identifiers.
 insert into public.catalog_product_source_records
  (organization_id,catalog_product_id,source_key,source_url,source_product_id,retrieved_at,payload_fingerprint)
 values(obs.organization_id,p.id,obs.source_key,obs.source_url,obs.product_code,obs.observed_at,obs.source_sha256)
 on conflict (organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
 select id into source_id from public.catalog_product_source_records
  where organization_id=obs.organization_id and catalog_product_id=p.id and source_key=obs.source_key
   and payload_fingerprint=obs.source_sha256 and source_url=obs.source_url and source_product_id=obs.product_code;
 if source_id is null then raise exception 'MARTEX_PROVENANCE_CONFLICT'; end if;
 insert into public.catalog_product_identifiers
  (organization_id,catalog_product_id,identifier_type,authority,value,source_record_id)
 select obs.organization_id,p.id,'oem',upper(x->>'manufacturer'),x->>'code',source_id
  from jsonb_array_elements(obs.selected_oem) x
 on conflict do nothing;
 get diagnostics identifiers_count=row_count;
 before_fields:=jsonb_build_object('oem_no',p.oem_no,'vehicle',p.vehicle);
 select count(distinct public.normalize_part_code(x->>'code')),min(x->>'code')
   into unique_oem_count,oem_text from jsonb_array_elements(obs.selected_oem) x;
 if unique_oem_count <> 1 then oem_text:=null; end if;
 if length(coalesce(oem_text,''))>12000 then raise exception 'MARTEX_OEM_TOO_LONG'; end if;
 target_oem:=case when nullif(btrim(coalesce(p.oem_no,'')),'') is null then oem_text else p.oem_no end;
 target_vehicle:=case when nullif(btrim(coalesce(p.vehicle,'')),'') is null then obs.selected_vehicle else p.vehicle end;
 outcomes:=jsonb_build_object('identifiers_inserted',identifiers_count,'oem_no',case when unique_oem_count>1 then 'multiple_identifiers_only' when oem_text is null then 'not_proposed' when nullif(btrim(coalesce(p.oem_no,'')),'') is not null then 'existing_preserved' else 'applied' end,
  'vehicle',case when obs.selected_vehicle is null then 'not_proposed' when nullif(btrim(coalesce(p.vehicle,'')),'') is not null then 'existing_preserved' else 'applied' end);
 if p.oem_no is distinct from target_oem or p.vehicle is distinct from target_vehicle then
  update public.catalog_products cp set oem_no=target_oem,vehicle=target_vehicle,updated_at=now() where cp.id=p.id returning cp.* into p;
 end if;
 after_fields:=jsonb_build_object('oem_no',p.oem_no,'vehicle',p.vehicle);
 insert into public.catalog_martex_reference_events_v2(observation_id,organization_id,product_id,source_key,source_url,source_sha256,before_fields,after_fields,outcomes)
 values(obs.id,obs.organization_id,p.id,obs.source_key,obs.source_url,obs.source_sha256,before_fields,after_fields,outcomes);
 return jsonb_build_object('status','processed','before',before_fields,'after',after_fields,'outcomes',outcomes);
end $$;

revoke all on function public.stage_martex_reference_v2(jsonb) from public,anon,authenticated;
revoke all on function public.apply_martex_reference_v2(uuid) from public,anon,authenticated;
grant execute on function public.stage_martex_reference_v2(jsonb) to service_role;
grant execute on function public.apply_martex_reference_v2(uuid) to service_role;
