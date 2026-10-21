set local lock_timeout='2s';
set local statement_timeout='30s';
-- Preserve the public RPC signature, grants, cursor fencing and price boundaries.
create or replace function public.apply_supplier_catalog_enrichment_batch(input_job_id uuid,input_token uuid,input_phase text,input_cursor bigint,input_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;r public.supplier_price_release_rows%rowtype;c public.catalog_products%rowtype;
 entry jsonb;patch jsonb;issues jsonb;before_values jsonb;proof jsonb;item record;v_code text;v_cursor bigint;v_inserted boolean;v_count integer:=0;changed integer:=0;reviews integer:=0;missing integer:=0;
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
  changed_products=changed_products+changed,review_rows=review_rows+reviews,missing_rows=missing_rows+missing,consecutive_errors=0,error_code=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','applied','cursor',v_cursor,'rows',v_count);
end$$;
