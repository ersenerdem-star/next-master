-- Disposable PostgreSQL only. First run elring-guarded-enrichment.fixture.sql.
\set ON_ERROR_STOP on
create extension if not exists pgcrypto;
create function public.normalize_part_code(text) returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
alter table public.catalog_products add column lifecycle_status text default 'active', add column lifecycle_note text;
create table public.catalog_product_source_records(id uuid primary key default gen_random_uuid(),organization_id uuid,catalog_product_id uuid,
  source_key text,source_url text,source_product_id text,source_version text,payload_fingerprint text,
  unique(organization_id,catalog_product_id,source_key,payload_fingerprint));
create table public.catalog_product_relations(id uuid primary key default gen_random_uuid(),organization_id uuid,catalog_product_id uuid,
  relation_type text,related_brand text,related_product_code text,related_oem_no text,related_description text,source_record_id uuid,
  relation_fingerprint text,unique(organization_id,catalog_product_id,relation_fingerprint));
create function public.catalog_provider_jsonb_sha256(jsonb) returns text language sql immutable as $$select encode(digest($1::text,'sha256'),'hex')$$;
\i :relation_contract_file
\i :lifecycle_migration_file

update public.catalog_products set lifecycle_note='Existing manual note';
update public.catalog_import_stage set source_payload=source_payload||'{"raw":{"dataSupplierId":10,"mfrName":"ELRING","mfrId":510,"articleNumber":"115.100",
 "misc":{"articleStatusDescription":"Production discontinued"},"replacesArticles":[{"articleNumber":"001.000","mfrName":"ELRING"}],
 "replacedByArticles":[{"articleNumber":"300.000","mfrId":510},{"articleNumber":"400.000","mfrName":"OTHER"},{"articleNumber":"500.000"},{"articleNumber":"115.100","mfrName":"ELRING"}]}}'::jsonb;
set test.role='service_role';
do $$ declare result jsonb; begin
 result:=public.apply_elring_provider_lifecycle_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
 if result->>'processed'<>'1' or result->>'discontinued_applied'<>'1' or result->>'relations_inserted'<>'2' or result->>'rejected_relations'<>'3' then raise exception 'TEST: incorrect lifecycle result: %',result; end if;
 if not exists(select 1 from public.catalog_products where lifecycle_status='discontinued' and lifecycle_note='Existing manual note') then raise exception 'TEST: status or preservation failed'; end if;
 if not exists(select 1 from public.catalog_product_relations where relation_type='replacement' and related_product_code='001.000')
   or not exists(select 1 from public.catalog_product_relations where relation_type='replaced_by' and related_product_code='300.000') then raise exception 'TEST: relation direction lost'; end if;
 result:=public.apply_elring_provider_lifecycle_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
 if result->>'relations_inserted'<>'0' or result->>'discontinued_applied'<>'0' then raise exception 'TEST: replay not idempotent'; end if;
 if (select count(*) from public.catalog_product_relations)<>2 or (select count(*) from public.catalog_product_source_records)<>1 then raise exception 'TEST: duplicate evidence'; end if;
end $$;
update public.catalog_import_stage set source_payload=jsonb_set(source_payload,'{raw,misc,articleStatusDescription}','"Normal"');
select public.apply_elring_provider_lifecycle_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
do $$ begin if exists(select 1 from public.catalog_products where lifecycle_status<>'discontinued') then raise exception 'TEST: implicit reactivation'; end if; end $$;
update public.catalog_products set lifecycle_status='active';
update public.catalog_import_stage set source_payload=jsonb_set(source_payload,'{raw,misc}','{"articleStatusId":99,"articleStatusDescription":"Out of stock"}');
select public.apply_elring_provider_lifecycle_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
do $$ begin if exists(select 1 from public.catalog_products where lifecycle_status<>'active') then raise exception 'TEST: stock/replacement inferred discontinued'; end if; end $$;
update public.catalog_import_stage set source_payload=jsonb_set(source_payload,'{raw,replacesArticles}','[{"articleNumber":"300.000","mfrId":510}]');
do $$ begin
 begin
  perform public.apply_elring_provider_lifecycle_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
  raise exception 'TEST: direction conflict allowed';
 exception when raise_exception then if sqlerrm<>'Elring replacement direction conflict' then raise; end if; end;
 if has_function_privilege('anon','public.apply_elring_provider_lifecycle_batch(uuid,uuid,integer,integer)','execute')
   or has_function_privilege('authenticated','public.apply_elring_provider_lifecycle_batch(uuid,uuid,integer,integer)','execute') then raise exception 'TEST: permission leak'; end if;
 perform set_config('test.role','authenticated',true);
 begin
  perform public.apply_elring_provider_lifecycle_batch('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002');
  raise exception 'TEST: role check missing';
 exception when raise_exception then if sqlerrm<>'Service role required' then raise; end if; end;
end $$;
select 'ELRING_LIFECYCLE_CONTRACT_PASSED' as result;
