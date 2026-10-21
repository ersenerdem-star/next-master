set local lock_timeout='2s';
set local statement_timeout='30s';
-- Historical official_checked remains scanned-row progress. New counters only
-- cover v2 receipts; no old cursor, audit row or price publication is replayed.
alter table supplier_price_ingestion_internal.catalog_enrichment_jobs
 add column official_requested bigint not null default 0,
 add column lifecycle_recorded bigint not null default 0,
 add column coverage_start_row bigint;
-- Preserve the public RPC signature, grants, cursor fencing and price boundaries.
create or replace function public.apply_supplier_catalog_enrichment_batch(input_job_id uuid,input_token uuid,input_phase text,input_cursor bigint,input_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;r public.supplier_price_release_rows%rowtype;c public.catalog_products%rowtype;
 entry jsonb;patch jsonb;issues jsonb;before_values jsonb;proof jsonb;item record;v_code text;v_cursor bigint;v_inserted boolean;v_count integer:=0;changed integer:=0;reviews integer:=0;missing integer:=0;requests integer:=0;coverage_row bigint;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 if j.phase<>input_phase or j.cursor<>input_cursor then raise exception 'CATALOG_ENRICHMENT_CURSOR_CHANGED';end if;
 if jsonb_typeof(input_rows)<>'array' or jsonb_array_length(input_rows) not between 1 and 500 or octet_length(input_rows::text)>3000000 then raise exception 'CATALOG_ENRICHMENT_BATCH_INVALID';end if;
 -- Complete prefix only: a caller cannot advance past an unprocessed source row.
 if (select array_agg((e->>'rowNumber')::bigint order by ord) from jsonb_array_elements(input_rows) with ordinality as x(e,ord)) is distinct from
  (select array_agg(x.source_row_number order by x.source_row_number) from (select source_row_number from public.supplier_price_release_rows
   where release_id=j.release_id and source_row_number>j.cursor order by source_row_number limit jsonb_array_length(input_rows))x) then raise exception 'CATALOG_ENRICHMENT_PREFIX_INVALID';end if;
 v_cursor:=j.cursor;
 for entry in select value from jsonb_array_elements(input_rows) loop
  select * into r from public.supplier_price_release_rows where release_id=j.release_id and source_row_number=(entry->>'rowNumber')::bigint;
  v_cursor:=r.source_row_number;v_count:=v_count+1;v_code:=r.normalized_code;
  if r.row_status<>'accepted' or v_code<>public.normalize_catalog_product_code(r.product_code) then reviews:=reviews+1;continue;end if;
  patch:=coalesce(entry->'patch','{}');issues:=coalesce(entry->'issues','[]');proof:=coalesce(entry->'evidence','{}');
  if jsonb_typeof(patch)<>'object' or jsonb_typeof(issues)<>'array' or jsonb_typeof(proof)<>'object' or octet_length(entry::text)>64000
   or exists(select 1 from jsonb_object_keys(patch) k where k not in ('description','description_tr','oem_no','vehicle','vehicle_model','ean','market_segment','weight_kg','dimensions','origin','hs_code'))
   or exists(select 1 from jsonb_each(patch) k where k.value='null'::jsonb or (jsonb_typeof(k.value)='string' and btrim(k.value#>>'{}')='')) then raise exception 'CATALOG_ENRICHMENT_PATCH_INVALID';end if;
  if j.phase='official' and proof->>'policy'='supplier-catalog-enrichment-v2' then
   if proof->'sourceRequested' is distinct from 'true'::jsonb
    or coalesce(proof->>'sourceOutcome','') not in ('matched','not_found','unsupported_domain')
    or coalesce(proof#>>'{lifecycle,checks,replacement}','') not in ('unsupported','no_explicit_signal','found','unverified_target_identity','review_required','blocked')
    or coalesce(proof#>>'{lifecycle,checks,discontinued}','') not in ('unsupported','no_explicit_signal','found','unverified_target_identity','review_required','blocked') then
    raise exception 'CATALOG_ENRICHMENT_LIFECYCLE_RECEIPT_REQUIRED';
   end if;
   requests:=requests+1;coverage_row:=coalesce(coverage_row,r.source_row_number);
  end if;
  if j.phase='official' and patch<>'{}' and (proof->>'authority'<>'official' or proof->>'code'<>v_code or proof->>'brandId'<>j.brand_id::text
    or coalesce(proof->>'sourceUrl','')!~'^https://' or coalesce(proof->>'fingerprint','')!~'^[0-9a-f]{64}$') then raise exception 'CATALOG_ENRICHMENT_EVIDENCE_REQUIRED';end if;
  select * into c from public.catalog_products cp where cp.organization_id=j.organization_id and cp.brand_id=j.brand_id
   and public.normalize_catalog_product_code(cp.product_code)=v_code order by cp.id limit 1 for update;
  if c.id is not null and c.id::text is distinct from entry->'existing'->>'id' then raise exception 'CATALOG_ENRICHMENT_PRODUCT_CHANGED';end if;
  before_values:=coalesce(to_jsonb(c),'{}');
  for item in select key,value from jsonb_each(coalesce(entry->'existing','{}')) where key<>'id' loop
   if (before_values->item.key) is distinct from item.value then raise exception 'CATALOG_ENRICHMENT_PRODUCT_CHANGED';end if;
  end loop;
  -- Source EAN is checked against the locked row, independently of the worker's
  -- proposed patch. A conflict holds every metadata field, including identifiers.
  if j.phase='official' and nullif(btrim(c.ean),'') is not null then
   if proof ? 'sourceEan' and nullif(btrim(proof->>'sourceEan'),'') is not null
    and upper(regexp_replace(c.ean,'\s','','g'))<>upper(regexp_replace(proof->>'sourceEan','\s','','g')) then
    patch:='{}'::jsonb;
    if not issues @> '[{"field":"ean","code":"EAN_IDENTITY_CONFLICT"}]'::jsonb then
     issues:=issues||jsonb_build_array(jsonb_build_object('field','ean','code','EAN_IDENTITY_CONFLICT'));
    end if;
   elsif patch<>'{}'::jsonb and not (proof ? 'sourceEan') then
    patch:='{}'::jsonb;
    issues:=issues||jsonb_build_array(jsonb_build_object('field','ean','code','SOURCE_EAN_NOT_RECORDED'));
   end if;
  end if;
  v_inserted:=false;
  begin
   if c.id is null and j.phase='file' then
    insert into public.catalog_products(organization_id,brand_id,product_code) values(j.organization_id,j.brand_id,r.product_code) returning * into c;
    if public.normalize_catalog_product_code(c.product_code)<>v_code then raise check_violation using message='CATALOG_ENRICHMENT_IDENTITY_CONFLICT';end if;
    v_inserted:=true;
   end if;
   if c.id is not null and patch<>'{}' then
    -- Official observations complete missing values only, with additive identifiers.
    if j.phase='official' and exists(select 1 from jsonb_each(patch) x where x.key not in ('oem_no','vehicle','vehicle_model')
     and nullif(btrim(coalesce(before_values->>x.key,'')),'') is not null) then raise exception 'CATALOG_ENRICHMENT_OFFICIAL_OVERWRITE_DENIED';end if;
    update public.catalog_products cp set
     description=case when patch?'description' then patch->>'description' else cp.description end,
     description_tr=case when patch?'description_tr' then patch->>'description_tr' else cp.description_tr end,
     oem_no=case when patch?'oem_no' then patch->>'oem_no' else cp.oem_no end,
     vehicle=case when patch?'vehicle' then patch->>'vehicle' else cp.vehicle end,
     vehicle_model=case when patch?'vehicle_model' then patch->>'vehicle_model' else cp.vehicle_model end,
     ean=case when patch?'ean' then patch->>'ean' else cp.ean end,
     market_segment=case when patch?'market_segment' then patch->>'market_segment' else cp.market_segment end,
     weight_kg=case when patch?'weight_kg' then (patch->>'weight_kg')::numeric else cp.weight_kg end,
     dimensions=case when patch?'dimensions' then patch->'dimensions' else cp.dimensions end,
     origin=case when patch?'origin' then patch->>'origin' else cp.origin end,
     hs_code=case when patch?'hs_code' then patch->>'hs_code' else cp.hs_code end,updated_at=now() where cp.id=c.id returning cp.* into c;
    select jsonb_object_agg(k,to_jsonb(c)->k) into patch from jsonb_object_keys(patch) k;
    for item in select key,value from jsonb_each(patch) loop
     insert into supplier_price_ingestion_internal.catalog_enrichment_fields(product_id,field,applied_value,source_date,job_id)
      values(c.id,item.key,item.value,j.source_date,j.id) on conflict(product_id,field) do update set
      applied_value=excluded.applied_value,source_date=excluded.source_date,job_id=excluded.job_id;
    end loop;
   end if;
  exception when unique_violation or check_violation then
   c.id:=null;v_inserted:=false;patch:='{}';issues:=issues||jsonb_build_array(jsonb_build_object('field','product_code','code','CATALOG_IDENTITY_OR_VALUE_CONFLICT'));
  end;
  if v_inserted or patch<>'{}' then changed:=changed+1;end if;
  if jsonb_array_length(issues)>0 then reviews:=reviews+1;end if;
  if coalesce((entry->>'missing')::boolean,false) then missing:=missing+1;end if;
  if v_inserted or patch<>'{}' or jsonb_array_length(issues)>0 or proof<>'{}' or coalesce((entry->>'missing')::boolean,false) then
   insert into supplier_price_ingestion_internal.catalog_enrichment_changes(job_id,phase,source_row_number,product_code,product_id,before_values,patch,issues,evidence,missing_fields)
    values(j.id,j.phase,r.source_row_number,r.product_code,c.id,coalesce(entry->'existing','{}'),patch,issues,
     proof||jsonb_build_object('releaseId',j.release_id,'sourceSha256',j.source_sha256,'sourceDate',j.source_date),coalesce(entry->'missingFields','[]'));
  end if;
 end loop;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set cursor=v_cursor,
  processed_rows=processed_rows+case when j.phase='file' then v_count else 0 end,
  official_checked=official_checked+case when j.phase='official' then v_count else 0 end,
  official_requested=official_requested+requests,lifecycle_recorded=lifecycle_recorded+requests,
  coverage_start_row=coalesce(coverage_start_row,coverage_row),
  changed_products=changed_products+changed,review_rows=review_rows+reviews,missing_rows=missing_rows+missing,consecutive_errors=0,error_code=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','applied','cursor',v_cursor,'rows',v_count);
end$$;

create or replace function public.get_supplier_catalog_enrichment_status(input_release_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'CATALOG_ENRICHMENT_ADMIN_REQUIRED';end if;
 if cardinality(input_release_ids)>25 then raise exception 'CATALOG_ENRICHMENT_PAGE_LIMIT';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('releaseId',j.release_id,'status',j.status,'phase',j.phase,'totalRows',j.total_rows,
 'processedRows',j.processed_rows,'changedProducts',j.changed_products,'reviewRows',j.review_rows,'officialChecked',j.official_checked,
 'missingRows',j.missing_rows,'officialRequested',j.official_requested,'lifecycleRecorded',j.lifecycle_recorded,'coverageStartRow',j.coverage_start_row,'errorCode',j.error_code,'errorSourceRow',j.error_source_row,'errorProvider',j.error_provider,'updatedAt',j.updated_at)) from supplier_price_ingestion_internal.catalog_enrichment_jobs j
 where j.organization_id=org and j.release_id=any(input_release_ids)),'[]'::jsonb);
end$$;
create or replace function public.get_supplier_catalog_enrichment_details(input_release_id uuid,input_after_phase text default '',input_after_row bigint default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();result jsonb;
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'CATALOG_ENRICHMENT_ADMIN_REQUIRED';end if;
 if input_after_phase not in ('','file','official') or input_after_row<0 then raise exception 'CATALOG_ENRICHMENT_CURSOR_INVALID';end if;
 select jsonb_agg(to_jsonb(x) order by phase,source_row_number) into result from (
  select c.phase,c.source_row_number,c.product_code,c.before_values,c.patch,c.issues,c.missing_fields,c.evidence->>'sourceUrl' source_url,c.evidence->'lifecycle' lifecycle,c.evidence->>'sourceEan' source_ean
  from supplier_price_ingestion_internal.catalog_enrichment_changes c join supplier_price_ingestion_internal.catalog_enrichment_jobs j on j.id=c.job_id
  where j.organization_id=org and j.release_id=input_release_id and (c.phase,c.source_row_number)>(input_after_phase,input_after_row)
  and (jsonb_array_length(c.issues)>0 or jsonb_array_length(c.missing_fields)>0 or c.evidence ? 'lifecycle') order by c.phase,c.source_row_number limit 21
 )x;
 return coalesce(result,'[]'::jsonb);
end$$;
