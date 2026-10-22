set local lock_timeout='2s';
set local statement_timeout='30s';

-- Keep the proven writer unchanged behind the same service-only public RPC.
-- The wrapper isolates only deterministic product-data failures. Lease,
-- prefix, publication, source-authority and infrastructure failures still stop.
alter function public.apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb)
 rename to apply_supplier_catalog_enrichment_batch_strict;
alter function public.apply_supplier_catalog_enrichment_batch_strict(uuid,uuid,text,bigint,jsonb)
 set schema supplier_price_ingestion_internal;
revoke all on function supplier_price_ingestion_internal.apply_supplier_catalog_enrichment_batch_strict(uuid,uuid,text,bigint,jsonb)
 from public,anon,authenticated,service_role;

create function supplier_price_ingestion_internal.hold_catalog_enrichment_product(
 input_job_id uuid,input_token uuid,input_phase text,input_cursor bigint,input_row jsonb,input_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
 r public.supplier_price_release_rows%rowtype;p public.catalog_products%rowtype;
 receipt jsonb;reason text;entry_bytes integer;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 if j.phase is distinct from input_phase or j.cursor is distinct from input_cursor then raise exception 'CATALOG_ENRICHMENT_CURSOR_CHANGED';end if;
 if input_reason is null or input_reason not in('CATALOG_ENRICHMENT_PATCH_INVALID','CATALOG_ENRICHMENT_PRODUCT_CHANGED',
  'OFFICIAL_EXACT_MATCH_AMBIGUOUS','OFFICIAL_OBSERVATION_IDENTITY_INVALID','DENSO_BRAND_MISMATCH','DENSO_RESPONSE_TOO_LARGE',
  'SKF_PRODUCT_IDENTITY_INVALID','SKF_EAN_AMBIGUOUS','SKF_RESPONSE_TOO_LARGE',
  'ELRING_IDENTITY_MISMATCH','ELRING_IDENTITY_AMBIGUOUS','ELRING_PRODUCT_NOT_FOUND','ELRING_RESPONSE_TOO_LARGE')
  or (input_reason not in('CATALOG_ENRICHMENT_PATCH_INVALID','CATALOG_ENRICHMENT_PRODUCT_CHANGED') and j.phase<>'official')
  then raise exception 'CATALOG_ENRICHMENT_HOLD_REASON_INVALID';end if;
 select * into r from public.supplier_price_release_rows where release_id=j.release_id and source_row_number>j.cursor order by source_row_number limit 1;
 if r.release_id is null or r.source_row_number is distinct from (input_row->>'rowNumber')::bigint then raise exception 'CATALOG_ENRICHMENT_PREFIX_INVALID';end if;
 select * into p from public.catalog_products where organization_id=j.organization_id and brand_id=j.brand_id
  and public.normalize_catalog_product_code(product_code)=r.normalized_code order by id limit 1;
 entry_bytes:=octet_length(input_row::text);
 reason:=case when input_reason='CATALOG_ENRICHMENT_PATCH_INVALID' then
  case when entry_bytes>64000 then 'CATALOG_ENRICHMENT_RECORD_TOO_LARGE' else 'CATALOG_ENRICHMENT_ROW_INVALID' end else input_reason end;
 -- Retain the product in place. A bounded review receipt refers to the full
 -- unchanged product/source rather than copying an oversized before snapshot.
 receipt:=jsonb_build_object('policy','supplier-catalog-enrichment-v2','outcome','held','reason',reason,
  'releaseId',j.release_id,'sourceSha256',j.source_sha256,'sourceDate',j.source_date,
  'entryBytes',entry_bytes,'entryLimitBytes',64000,
  'entryFingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(input_row::text,'UTF8')),'hex'),
  'existingFingerprint',case when p.id is not null then pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(to_jsonb(p)::text,'UTF8')),'hex') end,
  'sourceUrl',case when input_row#>>'{evidence,sourceUrl}' ~ '^https://' then left(input_row#>>'{evidence,sourceUrl}',2000) end,
  'sourceRequested',coalesce(input_row#>'{evidence,sourceRequested}','false'::jsonb),
  'lifecycle',case when j.phase='official' then jsonb_build_object('checks',jsonb_build_object('replacement','blocked','discontinued','blocked'),'reason',reason) end);
 insert into supplier_price_ingestion_internal.catalog_enrichment_changes(job_id,phase,source_row_number,product_code,product_id,before_values,patch,issues,evidence,missing_fields)
 values(j.id,j.phase,r.source_row_number,r.product_code,p.id,
  case when p.id is null then '{}'::jsonb else jsonb_build_object('id',p.id,'snapshotStoredInCatalog',true) end,'{}',
  jsonb_build_array(jsonb_build_object('field',case when input_reason in('CATALOG_ENRICHMENT_PATCH_INVALID','CATALOG_ENRICHMENT_PRODUCT_CHANGED') then 'record' else 'source' end,'code',reason,'entryBytes',entry_bytes)),receipt,'[]');
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set cursor=r.source_row_number,
  processed_rows=processed_rows+case when j.phase='file' then 1 else 0 end,
  official_checked=official_checked+case when j.phase='official' then 1 else 0 end,
  official_requested=official_requested+case when j.phase='official' and input_row#>'{evidence,sourceRequested}'='true'::jsonb then 1 else 0 end,
  lifecycle_recorded=lifecycle_recorded+case when j.phase='official' and input_row#>'{evidence,sourceRequested}'='true'::jsonb then 1 else 0 end,
  coverage_start_row=case when j.phase='official' and input_row#>'{evidence,sourceRequested}'='true'::jsonb then coalesce(coverage_start_row,r.source_row_number) else coverage_start_row end,
  review_rows=review_rows+1,consecutive_errors=0,error_code=null,error_source_row=null,error_provider=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','applied','cursor',r.source_row_number,'rows',1,'held',1,'reason',reason);
end$$;
revoke all on function supplier_price_ingestion_internal.hold_catalog_enrichment_product(uuid,uuid,text,bigint,jsonb,text)
 from public,anon,authenticated,service_role;

create function public.apply_supplier_catalog_enrichment_batch(input_job_id uuid,input_token uuid,input_phase text,input_cursor bigint,input_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare row_value jsonb;result_value jsonb;current_cursor bigint:=input_cursor;held integer:=0;
begin
 -- The original writer validates the complete prefix and commits ordinary
 -- batches together. Its failed subtransaction leaves no partial writes.
 begin
  return supplier_price_ingestion_internal.apply_supplier_catalog_enrichment_batch_strict(input_job_id,input_token,input_phase,input_cursor,input_rows);
 exception when raise_exception then
  if sqlerrm not in('CATALOG_ENRICHMENT_PATCH_INVALID','CATALOG_ENRICHMENT_PRODUCT_CHANGED') then raise;end if;
 end;
 for row_value in select value from jsonb_array_elements(input_rows) loop
  begin
   result_value:=supplier_price_ingestion_internal.apply_supplier_catalog_enrichment_batch_strict(input_job_id,input_token,input_phase,current_cursor,jsonb_build_array(row_value));
  exception when raise_exception then
   if sqlerrm not in('CATALOG_ENRICHMENT_PATCH_INVALID','CATALOG_ENRICHMENT_PRODUCT_CHANGED') then raise;end if;
   result_value:=supplier_price_ingestion_internal.hold_catalog_enrichment_product(input_job_id,input_token,input_phase,current_cursor,row_value,sqlerrm);
   held:=held+1;
  end;
  if result_value->>'status'='superseded' then return result_value;end if;
  current_cursor:=(result_value->>'cursor')::bigint;
 end loop;
 return jsonb_build_object('status','applied','cursor',current_cursor,'rows',jsonb_array_length(input_rows),'held',held);
end$$;
revoke all on function public.apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb) to service_role;
create function public.hold_supplier_catalog_enrichment_product(input_job_id uuid,input_token uuid,input_phase text,input_cursor bigint,input_row jsonb,input_reason text)
returns jsonb language sql security definer set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
 select supplier_price_ingestion_internal.hold_catalog_enrichment_product(input_job_id,input_token,input_phase,input_cursor,input_row,input_reason)
$$;
revoke all on function public.hold_supplier_catalog_enrichment_product(uuid,uuid,text,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function public.hold_supplier_catalog_enrichment_product(uuid,uuid,text,bigint,jsonb,text) to service_role;
comment on function public.apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb) is
 'Product-data failures enter durable per-row review; remaining complete-prefix rows continue. Prices, canonical values of held products and infrastructure/auth gates are preserved.';
select pg_notify('pgrst','reload schema');
