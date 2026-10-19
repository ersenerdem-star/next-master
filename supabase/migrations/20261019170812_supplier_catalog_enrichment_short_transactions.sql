-- Production PostgREST inherits an 8-second statement timeout. Keep catalog
-- metadata transactions short while retaining atomic cursor/audit checkpoints.
-- Existing publications and completed rows are not replayed.
create or replace function public.read_supplier_catalog_enrichment_batch(input_job_id uuid,input_token uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;result jsonb;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 -- Give active source ingestion priority; no cursor or product changes are lost.
 if exists(select 1 from public.supplier_price_release_batches b join public.supplier_price_releases rel on rel.id=b.release_id
  where rel.organization_id=j.organization_id and b.status='running' and b.lease_expires_at>clock_timestamp()) then
  update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='queued',lease_token=null,lease_until=now()+interval '30 seconds',updated_at=now() where id=j.id;
  return jsonb_build_object('status','deferred');
 end if;
 with source as materialized (
  select r.* from public.supplier_price_release_rows r where r.release_id=j.release_id and r.source_row_number>j.cursor
  order by r.source_row_number limit case when j.phase='file' then 100 else 3 end
 )
 select jsonb_agg(jsonb_build_object('rowNumber',r.source_row_number,'code',r.product_code,'rowStatus',r.row_status,
 'source',jsonb_build_object('description',r.description,'description_tr',r.description_tr,'oem_no',r.oem_no,'ean',r.ean,
 'vehicle',r.vehicle,'vehicle_model',r.vehicle_model,'market_segment',r.market_segment,'dimensions',r.dimensions,'weight',r.weight,'origin',r.origin,'tariff',r.tariff),
 'existing',coalesce((select jsonb_build_object('id',c.id,'description',c.description,'description_tr',c.description_tr,'oem_no',c.oem_no,'ean',c.ean,
 'vehicle',c.vehicle,'vehicle_model',c.vehicle_model,'market_segment',c.market_segment,'weight_kg',c.weight_kg,'dimensions',c.dimensions,'origin',c.origin,'hs_code',c.hs_code)
  from public.catalog_products c where c.organization_id=j.organization_id and c.brand_id=j.brand_id and public.normalize_catalog_product_code(c.product_code)=r.normalized_code limit 1),'{}'::jsonb),
 'fieldState',coalesce((select jsonb_object_agg(f.field,jsonb_build_object('applied_value',f.applied_value,'source_date',f.source_date))
  from supplier_price_ingestion_internal.catalog_enrichment_fields f join public.catalog_products c on c.id=f.product_id
  where c.organization_id=j.organization_id and c.brand_id=j.brand_id and public.normalize_catalog_product_code(c.product_code)=r.normalized_code),'{}'::jsonb),
 'conflicts',coalesce((select jsonb_agg(field) from (select 'origin' field where nullif(btrim(r.origin),'') is not null and exists(
   select 1 from public.supplier_current_price_pointers ptr join public.supplier_price_publications p on p.id=ptr.publication_id and p.status='published'
   join public.supplier_price_release_rows other on other.release_id=ptr.release_id and other.normalized_code=r.normalized_code
   where ptr.organization_id=j.organization_id and ptr.brand_id=j.brand_id and other.row_status='accepted'
    and nullif(btrim(other.origin),'') is not null and upper(btrim(other.origin))<>upper(btrim(r.origin)))
  union all select 'hs_code' where nullif(btrim(r.tariff),'') is not null and exists(
   select 1 from public.supplier_current_price_pointers ptr join public.supplier_price_publications p on p.id=ptr.publication_id and p.status='published'
   join public.supplier_price_release_rows other on other.release_id=ptr.release_id and other.normalized_code=r.normalized_code
   where ptr.organization_id=j.organization_id and ptr.brand_id=j.brand_id and other.row_status='accepted'
    and nullif(btrim(other.tariff),'') is not null and regexp_replace(other.tariff,'[.[:space:]-]','','g')<>regexp_replace(r.tariff,'[.[:space:]-]','','g'))) conflict_fields),'[]'::jsonb)) order by r.source_row_number)
 into result from source r;
 if result is null then
  if j.phase='file' then
   update supplier_price_ingestion_internal.catalog_enrichment_jobs set phase='official',cursor=0,updated_at=now() where id=j.id;
   return jsonb_build_object('status','next_phase','phase','official');
  end if;
  update supplier_price_ingestion_internal.catalog_enrichment_jobs set status=case when review_rows>0 then 'review_required' when missing_rows>0 then 'completed_missing' else 'completed' end,
   lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed');
 end if;
 return jsonb_build_object('status','batch','phase',j.phase,'cursor',j.cursor,'rows',result,'sourceDate',j.source_date,'sourceSha256',j.source_sha256,
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
  error_code=case when input_error is null then null when input_error in ('CATALOG_ENRICHMENT_DATABASE_TIMEOUT','CATALOG_ENRICHMENT_DATABASE_BUSY','OFFICIAL_SOURCE_TIMEOUT','OFFICIAL_SOURCE_RATE_LIMIT','OFFICIAL_SOURCE_ACCESS_DENIED','OFFICIAL_SOURCE_UNAVAILABLE','CATALOG_ENRICHMENT_PRODUCT_CHANGED') then input_error else 'CATALOG_ENRICHMENT_RETRY_REQUIRED' end,
  error_source_row=case when exists(select 1 from public.supplier_price_release_rows where release_id=j.release_id and source_row_number=input_error_row) then input_error_row else null end,
  error_provider=case when input_error_provider~'^[a-z][a-z0-9_]{1,79}$' then input_error_provider else null end,
  lease_token=null,lease_until=case when input_error is null then null else now()+interval '2 minutes' end,updated_at=now() where id=j.id;
 return jsonb_build_object('status','released');
end$$;

