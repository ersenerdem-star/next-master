set local lock_timeout='2s';
set local statement_timeout='30s';
-- Alternate bounded turns under file pressure, retaining exclusive file writes.
-- Active workers and leases keep their current cursor and invocation budget.
alter table supplier_price_ingestion_internal.catalog_enrichment_control
 add column next_phase text not null default 'file' check(next_phase in ('file','official'));
update supplier_price_ingestion_internal.catalog_enrichment_control set next_phase='official'
 where exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and phase='file' and lease_until>clock_timestamp());
-- Denso and the existing shared official-source queue may run together.
-- Keep all non-Denso brands in one conservative lane (including the ZF group),
-- at most two official consumers globally, and file projection exclusive.
-- No source pacing, price pointer, cursor or publication policy is changed.
create or replace function public.claim_supplier_catalog_enrichment() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
 token uuid:=gen_random_uuid();active_count integer;v_brand text;preferred_phase text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_ENRICHMENT_SERVICE_REQUIRED';end if;
 if not exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_control where singleton and enabled) then return jsonb_build_object('status','disabled');end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-enrichment-consumer-v1',0)) then return jsonb_build_object('status','empty');end if;
 select count(*) into active_count from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and lease_until>clock_timestamp();
 if active_count>=2 or exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and phase='file' and lease_until>clock_timestamp()) then return jsonb_build_object('status','empty');end if;
 -- Drain existing official consumers before an eligible file job. This keeps
 -- new price-file projection first without repeatedly starting other sources.
 if active_count>0 and exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status in ('queued','running') and phase='file' and (lease_until is null or lease_until<clock_timestamp())) then return jsonb_build_object('status','empty');end if;
 select next_phase into preferred_phase from supplier_price_ingestion_internal.catalog_enrichment_control where singleton;
 select candidate.* into j from supplier_price_ingestion_internal.catalog_enrichment_jobs candidate
 join public.brands b on b.id=candidate.brand_id and b.organization_id=candidate.organization_id
 where candidate.status in ('queued','running') and (candidate.lease_until is null or candidate.lease_until<clock_timestamp())
 and (candidate.phase='official' or active_count=0)
 and not exists(
  select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs busy
  join public.brands bb on bb.id=busy.brand_id and bb.organization_id=busy.organization_id
  where busy.status='running' and busy.lease_until>clock_timestamp()
  and (lower(btrim(bb.name))='denso')=(lower(btrim(b.name))='denso')
 )
 order by case when candidate.phase=preferred_phase then 0 else 1 end,candidate.updated_at,candidate.id
 limit 1 for update of candidate skip locked;
 if not found then return jsonb_build_object('status','empty');end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='running',lease_token=token,
  lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=now() where id=j.id;
 update supplier_price_ingestion_internal.catalog_enrichment_control set next_phase=case when j.phase='file' then 'official' else 'file' end where singleton;
 select name into v_brand from public.brands where id=j.brand_id and organization_id=j.organization_id;
 return jsonb_build_object('status','claimed','jobId',j.id,'token',token,'releaseId',j.release_id,'phase',j.phase,'brandId',j.brand_id,'brand',v_brand);
end$$;
-- CREATE OR REPLACE retains the existing service-only grants.
select pg_notify('pgrst','reload schema');

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
  'turnBudgetMs',case when j.phase='official' and exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status in ('queued','running') and phase='file') then 60000 else 240000 end,
  'brandId',j.brand_id,'brand',(select name from public.brands where id=j.brand_id and organization_id=j.organization_id));
end$$;
