-- Run exclusively in an empty disposable PostgreSQL database, never production.
\set ON_ERROR_STOP on
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create schema auth;
create function auth.role() returns text language sql stable as $$ select current_setting('test.role',true) $$;
create table public.brands(id uuid primary key,organization_id uuid,name text);
create table public.catalog_import_runs(id uuid primary key,organization_id uuid,input_scope jsonb);
create table public.catalog_external_sources(id uuid primary key,organization_id uuid,source_key text,is_active boolean,
  license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
create table public.catalog_import_stage(run_id uuid,organization_id uuid,row_index integer,normalized_code text,source_url text,source_payload jsonb);
create table public.catalog_provider_stage_publications(run_id uuid,brand_id uuid,source_id uuid,approval_actor text,approval_reference text,status text);
create table public.catalog_products(id uuid primary key,organization_id uuid,brand_id uuid,product_code text,normalized_code text,
  description text,origin text,hs_code text,weight_kg numeric,ean text,oem_no text,vehicle text,vehicle_model text,dimensions jsonb,
  image_url text,market_segment text,updated_at timestamptz);
create table public.product_attribute_conflicts(organization_id uuid,product_id uuid,brand_id uuid,product_code text,field_name text,
  existing_value text,incoming_value text,normalized_incoming_value text,source_type text,source_reference text,
  status text default 'pending_review', last_detected_at timestamptz,detection_count integer default 1);
create unique index test_conflict on public.product_attribute_conflicts(organization_id,product_id,field_name,normalized_incoming_value) where status='pending_review';
create function public.normalize_product_conflict_value(text,text) returns text language sql immutable as $$ select lower(trim($2)) $$;
create function public.normalize_catalog_market_segment(text) returns text language sql immutable as $$ select case when $1 in ('pc','cv','lcv','engines','universal') then $1 else null end $$;
create table public.test_protocol_calls(payload jsonb);
-- Contract double for the existing shared protocol: deliberately overwrites
-- OEM/vehicle if supplied, reproducing the legacy risk the wrapper must fence.
create function public.apply_catalog_provider_enrichment_protocol(jsonb,text,text) returns jsonb language plpgsql as $$
declare v jsonb := $1->0;
begin
  insert into public.test_protocol_calls values(v);
  update public.catalog_products set description=coalesce(description,v->>'description'),hs_code=coalesce(hs_code,v->>'hs_code'),
    oem_no=coalesce(v->>'oem_no',oem_no),vehicle=coalesce(v->>'vehicle',vehicle),
    vehicle_model=coalesce(vehicle_model,v->>'vehicle_model'),dimensions=coalesce(dimensions,v->'dimensions')
  where organization_id=(v->>'organization_id')::uuid and brand_id=(v->>'brand_id')::uuid and product_code=v->>'product_code';
  return '{"scalar":{"applied_count":1}}'::jsonb;
end $$;
\i :migration_file

insert into public.brands values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Elring');
insert into public.catalog_import_runs values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',
  '{"source_key":"tecalliance_elring","brand_name":"Elring"}');
insert into public.catalog_external_sources values('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',
  'tecalliance_elring',true,'allowed','none','bounded','{}');
insert into public.catalog_products(id,organization_id,brand_id,product_code,normalized_code,oem_no,vehicle,image_url) values
 ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
  '115.100','115100','EXISTING-OEM','EXISTING-MAKE','https://existing.invalid/image.jpg');
insert into public.catalog_import_stage values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',0,'115100',
 'https://web.tecalliance.net/elring/en/home?articleNumber=115.100',
 '{"fields":{"description":"Seal ring","hs_code":"7415210000","oem_no":"NEW-OEM","vehicle":"NEW-MAKE","vehicle_model":"A4","market_segment":"pc","dimensions":{"thickness_mm":1.5},"image_url":"https://new.invalid/a.jpg","lifecycle_status":"discontinued","price":99}}');

do $$ begin
  perform set_config('test.role','authenticated',true);
  begin
    perform public.enrich_elring_provider_stage_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
    raise exception 'TEST: unprivileged role accepted';
  exception when raise_exception then if sqlerrm <> 'Service role required' then raise; end if; end;
  perform set_config('test.role','service_role',true);
  begin
    perform public.enrich_elring_provider_stage_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
    raise exception 'TEST: unauthorized source accepted';
  exception when raise_exception then if sqlerrm <> 'Elring publication authorization missing' then raise; end if; end;
end $$;
update public.catalog_external_sources set metadata='{"internal_catalog_persistence_allowed":true,"approval_actor":"owner","publication_approval_reference":"decision"}';
do $$ begin
  perform set_config('test.role','service_role',true);
  begin
    perform public.enrich_elring_provider_stage_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
    raise exception 'TEST: unpublished package accepted';
  exception when raise_exception then if sqlerrm <> 'Elring package publication must complete first' then raise; end if; end;
end $$;
insert into public.catalog_provider_stage_publications values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000004','owner','decision','completed');
set test.role='service_role';
select public.enrich_elring_provider_stage_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
select public.enrich_elring_provider_stage_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
do $$ declare p public.catalog_products%rowtype; begin
  select * into p from public.catalog_products;
  if p.oem_no <> 'EXISTING-OEM' or p.vehicle <> 'EXISTING-MAKE' or p.image_url <> 'https://existing.invalid/image.jpg' then raise exception 'TEST: protected field overwritten'; end if;
  if p.hs_code <> '7415210000' or p.vehicle_model <> 'A4' or p.market_segment <> 'pc' or p.dimensions <> '{"thickness_mm":1.5}'::jsonb then raise exception 'TEST: fields lost'; end if;
  if (select count(*) from public.product_attribute_conflicts) <> 2 then raise exception 'TEST: conflicts missing or duplicated'; end if;
  if exists(select 1 from public.test_protocol_calls where payload ?| array['image_url','lifecycle_status','price','market_segment']) then raise exception 'TEST: disallowed field reached shared guard'; end if;
  if has_function_privilege('anon','public.enrich_elring_provider_stage_batch(uuid,uuid,integer,integer)','execute')
    or has_function_privilege('authenticated','public.enrich_elring_provider_stage_batch(uuid,uuid,integer,integer)','execute') then raise exception 'TEST: public execute leaked'; end if;
end $$;
select 'ELRING_SQL_CONTRACT_PASSED' as result;
