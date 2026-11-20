set request.jwt.claim.role = 'service_role';
do $$
declare
 indata jsonb; result jsonb; obs uuid; n int; got text;
begin
 if has_function_privilege('anon','public.apply_martex_reference_v2(uuid)','EXECUTE') or has_function_privilege('authenticated','public.apply_martex_reference_v2(uuid)','EXECUTE') or not has_function_privilege('service_role','public.apply_martex_reference_v2(uuid)','EXECUTE') then raise exception 'bad privileges'; end if;
 if has_table_privilege('service_role','public.catalog_martex_reference_observations_v2','SELECT') then raise exception 'stage table exposed'; end if;
 result:=public.register_martex_titanx_reference_source_v2('11111111-1111-4111-8111-111111111111'); if (result->>'created')::boolean is not false then raise exception 'existing source overwritten'; end if;
 insert into public.organizations values ('66666666-6666-4666-8666-666666666666');
 insert into public.brands values ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','Titanx');
 result:=public.register_martex_titanx_reference_source_v2('66666666-6666-4666-8666-666666666666'); if (result->>'created')::boolean is not true then raise exception 'new source not created'; end if;
 result:=public.register_martex_titanx_reference_source_v2('66666666-6666-4666-8666-666666666666'); if (result->>'created')::boolean is not false then raise exception 'source registration not idempotent'; end if;
 indata:=jsonb_build_object('organization_id','11111111-1111-4111-8111-111111111111','brand_id','22222222-2222-4222-8222-222222222222','product_code','BL119001','source_url','https://sklep.martextruck.pl/partscatalogue/example.aspx','source_sha256',repeat('a',64),'observed_at','2026-11-20T11:52:00Z',
 'source_description_pl','SILNIK DMUCHAWY MB ACTROS 04.97 VOLVO FH12',
 'observed_references','[{"manufacturer":"MB","code":"0018308708"},{"manufacturer":"MB","code":"A0018308708"},{"manufacturer":"HELLA","code":"BAD123"}]'::jsonb,
 'selected_oem','[{"manufacturer":"MB","code":"0018308708"},{"manufacturer":"MB","code":"A0018308708"}]'::jsonb,
 'selected_vehicles','["MB ACTROS","VOLVO FH12"]'::jsonb,
 'evidence','{"primary_brand":"TITANX","primary_code":"BL119001","collector_html_sha256_verified":true}'::jsonb);
 result:=public.stage_martex_reference_v2(indata); if result->>'status'<>'ready' then raise exception 'stage %',result; end if; obs:=(result->>'id')::uuid;
 result:=public.stage_martex_reference_v2(indata); if (result->>'reused')::boolean is not true or (result->>'id')::uuid<>obs then raise exception 'not idempotent stage'; end if;
 result:=public.apply_martex_reference_v2(obs); if result->>'status'<>'processed' or result#>>'{outcomes,oem_no}'<>'multiple_identifiers_only' or result#>>'{outcomes,vehicle}'<>'applied' or result#>'{after,oem_no}'<>'null'::jsonb then raise exception 'apply %',result; end if;
 select count(*) into n from public.catalog_product_identifiers where identifier_type='oem' and value in ('0018308708','A0018308708') and source_record_id is not null; if n<>2 then raise exception 'identifier count %',n; end if;
 select vehicle into got from public.catalog_products where product_code='BL119001'; if got<>'MB ACTROS | VOLVO FH12' then raise exception 'vehicle values %',got; end if;
 result:=public.apply_martex_reference_v2(obs); if result->>'status'<>'already_processed' then raise exception 'not idempotent apply'; end if;
 select count(*) into n from public.catalog_martex_reference_events_v2; if n<>1 then raise exception 'event count %',n; end if;
 select buy_price::text into got from public.supplier_prices; if got<>'12' then raise exception 'prices changed'; end if;
 result:=public.stage_martex_reference_v2(indata || jsonb_build_object('source_sha256',repeat('b',64),'selected_oem','[{"manufacturer":"HELLA","code":"BAD123"}]'::jsonb)); if result->>'status'<>'held' then raise exception 'non OE not held'; end if;
 result:=public.stage_martex_reference_v2(indata || jsonb_build_object('source_sha256',repeat('9',64),'observed_references','[{"manufacturer":"MB","code":"***"}]'::jsonb,'selected_oem','[{"manufacturer":"MB","code":"***"}]'::jsonb)); if result->>'status'<>'held' or result->>'reason'<>'OEM_REFERENCE_NOT_EXPLICIT_OR_ALLOWED' then raise exception 'empty normalized OE accepted'; end if;
 begin perform public.stage_martex_reference_v2(indata || jsonb_build_object('source_sha256',repeat('c',64),'selected_vehicles','["MB ATEGO"]'::jsonb)); raise exception 'invalid vehicle accepted'; exception when raise_exception then if sqlerrm <> 'MARTEX_VEHICLE_NOT_EXPLICIT' then raise; end if; end;
 begin perform public.stage_martex_reference_v2(indata || jsonb_build_object('source_sha256',repeat('a',64),'selected_oem','[]'::jsonb)); raise exception 'modified duplicate accepted'; exception when raise_exception then if sqlerrm <> 'MARTEX_OBSERVATION_CONFLICT' then raise; end if; end;
 update public.catalog_external_sources set is_active=false;
 begin perform public.stage_martex_reference_v2(indata || jsonb_build_object('source_sha256',repeat('d',64))); raise exception 'inactive accepted'; exception when raise_exception then if sqlerrm <> 'MARTEX_SOURCE_NOT_CONFIGURED' then raise; end if; end;
 begin perform public.register_martex_titanx_reference_source_v2('11111111-1111-4111-8111-111111111111'); raise exception 'inactive source overwritten'; exception when raise_exception then if sqlerrm <> 'MARTEX_EXISTING_SOURCE_REQUIRES_REVIEW' then raise; end if; end;
end $$;
select 'PASS: exact identity, typed references, missing-only, source records, idempotency, RLS privileges, price guard, source disable' as result;
update public.catalog_external_sources set is_active=true;
insert into public.catalog_products(id,organization_id,brand_id,product_code) values ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','BL119002');
create function public.test_block_update() returns trigger language plpgsql as $$ begin if new.product_code='BL119002' then raise exception 'test trigger'; end if; return new; end $$;
create trigger test_block before update on public.catalog_products for each row execute function public.test_block_update();
do $$
declare obs uuid; arg jsonb; n integer;
begin
 arg:=jsonb_build_object('organization_id','11111111-1111-4111-8111-111111111111','brand_id','22222222-2222-4222-8222-222222222222','product_code','BL119002','source_url','https://sklep.martextruck.pl/partscatalogue/example.aspx','source_sha256',repeat('f',64),'observed_at','2026-11-20T11:52:00Z','source_description_pl','SILNIK DMUCHAWY MB ACTROS','observed_references','[{"manufacturer":"MB","code":"0018308708"}]'::jsonb,'selected_oem','[{"manufacturer":"MB","code":"0018308708"}]'::jsonb,'selected_vehicles','["MB ACTROS"]'::jsonb,'evidence','{"primary_brand":"TITANX","primary_code":"BL119002","collector_html_sha256_verified":true}'::jsonb);
 obs:=(public.stage_martex_reference_v2(arg)->>'id')::uuid;
 begin perform public.apply_martex_reference_v2(obs); raise exception 'expected trigger failure'; exception when raise_exception then if sqlerrm<>'test trigger' then raise; end if; end;
 select count(*) into n from public.catalog_product_source_records where catalog_product_id='55555555-5555-4555-8555-555555555555'; if n<>0 then raise exception 'source row not rolled back'; end if;
 select count(*) into n from public.catalog_product_identifiers where catalog_product_id='55555555-5555-4555-8555-555555555555'; if n<>0 then raise exception 'identifier row not rolled back'; end if;
 select count(*) into n from public.catalog_martex_reference_events_v2 where observation_id=obs; if n<>0 then raise exception 'event not rolled back'; end if;
end $$;
drop trigger test_block on public.catalog_products;
do $$
declare result jsonb; obs uuid;
begin
 select id into obs from public.catalog_martex_reference_observations_v2 where product_code='BL119002';
 result:=public.apply_martex_reference_v2(obs);
 if result#>>'{after,oem_no}'<>'0018308708' or result#>>'{outcomes,oem_no}'<>'applied' then raise exception 'single OE missing %',result; end if;
 if (select normalized_oem from public.catalog_products where product_code='BL119002')<>'0018308708' then raise exception 'single OE normalization wrong'; end if;
end $$;
select 'PASS: all-or-nothing rollback on trigger failure and single OE canonical search key' as result;
