-- File uploads have priority; official jobs rotate after bounded execution windows.
create or replace function public.claim_supplier_catalog_enrichment() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;token uuid:=gen_random_uuid();
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_ENRICHMENT_SERVICE_REQUIRED';end if;
 if not exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_control where singleton and enabled) then return jsonb_build_object('status','disabled');end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-enrichment-consumer-v1',0))
  or exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','empty');end if;
 select * into j from supplier_price_ingestion_internal.catalog_enrichment_jobs
 where status in ('queued','running') and (lease_until is null or lease_until<clock_timestamp()) order by case when phase='file' then 0 else 1 end,updated_at,id for update skip locked limit 1;
 if not found then return jsonb_build_object('status','empty');end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='running',lease_token=token,
  lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=now() where id=j.id;
 return jsonb_build_object('status','claimed','jobId',j.id,'token',token,'releaseId',j.release_id,'phase',j.phase,
  'brandId',j.brand_id,'brand',(select name from public.brands where id=j.brand_id and organization_id=j.organization_id));
end$$;

create or replace function public.release_supplier_catalog_enrichment(input_job_id uuid,input_token uuid,input_error text default null,input_error_row bigint default null,input_error_provider text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status=case when input_error is not null and consecutive_errors>=9 then 'failed' else 'queued' end,
  consecutive_errors=case when input_error is null then consecutive_errors else consecutive_errors+1 end,
  error_code=case when input_error is null then null when input_error in ('CATALOG_ENRICHMENT_DATABASE_TIMEOUT','CATALOG_ENRICHMENT_DATABASE_BUSY','OFFICIAL_SOURCE_TIMEOUT','OFFICIAL_SOURCE_RATE_LIMIT','OFFICIAL_SOURCE_ACCESS_DENIED','OFFICIAL_SOURCE_UNAVAILABLE','OFFICIAL_PROVIDER_IMPLEMENTATION_ERROR','OFFICIAL_OBSERVATION_IDENTITY_INVALID','OFFICIAL_OBSERVATION_SOURCE_INVALID','CATALOG_ENRICHMENT_PRODUCT_CHANGED') then input_error else 'CATALOG_ENRICHMENT_RETRY_REQUIRED' end,
  error_source_row=case when exists(select 1 from public.supplier_price_release_rows where release_id=j.release_id and source_row_number=input_error_row) then input_error_row else null end,
  error_provider=case when input_error_provider~'^[a-z][a-z0-9_]{1,79}$' then input_error_provider else null end,
  lease_token=null,lease_until=case when input_error is null then null else now()+interval '2 minutes' end,updated_at=now() where id=j.id;
 return jsonb_build_object('status','released');
end$$;


create or replace function public.finish_supplier_catalog_without_official_source(input_job_id uuid,input_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 if j.phase<>'official' then raise exception 'CATALOG_ENRICHMENT_PHASE_INVALID';end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='review_required',
  error_code=case when exists(select 1 from public.brands b join public.catalog_external_sources s on s.organization_id=b.organization_id and s.source_key='tecalliance_elring' and not s.is_active where b.id=j.brand_id and b.name='Elring') then 'OFFICIAL_SOURCE_OPERATIONAL_HOLD' else 'OFFICIAL_SOURCE_NOT_CONFIGURED' end,lease_token=null,lease_until=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','review_required');
end$$;

select pg_notify('pgrst','reload schema');
