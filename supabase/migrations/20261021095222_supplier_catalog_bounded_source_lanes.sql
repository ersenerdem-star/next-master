-- Denso and the existing shared official-source queue may run together.
-- Keep all non-Denso brands in one conservative lane (including the ZF group),
-- at most two official consumers globally, and file projection exclusive.
-- No source pacing, price pointer, cursor or publication policy is changed.
create or replace function public.claim_supplier_catalog_enrichment() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
 token uuid:=gen_random_uuid();active_count integer;v_brand text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_ENRICHMENT_SERVICE_REQUIRED';end if;
 if not exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_control where singleton and enabled) then return jsonb_build_object('status','disabled');end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-enrichment-consumer-v1',0)) then return jsonb_build_object('status','empty');end if;
 select count(*) into active_count from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and lease_until>clock_timestamp();
 if active_count>=2 or exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and phase='file' and lease_until>clock_timestamp()) then return jsonb_build_object('status','empty');end if;
 -- Drain existing official consumers before an eligible file job. This keeps
 -- new price-file projection first without repeatedly starting other sources.
 if active_count>0 and exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status in ('queued','running') and phase='file' and (lease_until is null or lease_until<clock_timestamp())) then return jsonb_build_object('status','empty');end if;
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
 order by case when candidate.phase='file' then 0 else 1 end,candidate.updated_at,candidate.id
 limit 1 for update of candidate skip locked;
 if not found then return jsonb_build_object('status','empty');end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='running',lease_token=token,
  lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=now() where id=j.id;
 select name into v_brand from public.brands where id=j.brand_id and organization_id=j.organization_id;
 return jsonb_build_object('status','claimed','jobId',j.id,'token',token,'releaseId',j.release_id,'phase',j.phase,'brandId',j.brand_id,'brand',v_brand);
end$$;
-- CREATE OR REPLACE retains the existing service-only grants.
select pg_notify('pgrst','reload schema');
