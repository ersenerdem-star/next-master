-- Source-verified corrections for confirmed foreign SKU-prefixed descriptions.
create or replace function public.apply_catalog_zf_job_item(input_org uuid,input_job uuid,input_token uuid,input_index integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare
 j public.catalog_zf_jobs%rowtype; it public.catalog_zf_job_items%rowtype;
 p public.catalog_products%rowtype; target public.catalog_products%rowtype; src public.catalog_external_sources%rowtype;
 obs jsonb; before_values jsonb; vals jsonb; changes jsonb:='{}'; outcomes jsonb:='{}'; relations jsonb:='[]';
 field text; value jsonb; live jsonb; old_value jsonb; source_id uuid; brand_id_value uuid; source_hash text;
 edge jsonb; evidence jsonb; v_old_code text; v_new_code text; mapping public.item_code_references%rowtype;
 can_link boolean; cycles boolean; edge_result text; status_text text; result_value jsonb; application jsonb;
 cardinality integer; ean_conflict boolean; corrupt_weight_baseline boolean; raw_article jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 select * into j from public.catalog_zf_jobs where id=input_job and organization_id=input_org and mode='publish'
  and status='running' and lease_token=input_token and lease_expires_at>now() for update;
 if j.id is null or input_index is distinct from j.next_index then raise exception 'ZF worker lease or cursor lost'; end if;
 select result into application from public.catalog_zf_item_applications where job_id=j.id and item_index=input_index;
 if found then return application; end if;
 select * into src from public.catalog_external_sources where organization_id=input_org and source_key='zf_group_official_v2';
 if src.id is null or not src.is_active or src.license_posture not in ('allowed','internal_review_required')
  or src.credential_boundary is distinct from 'none' or src.rate_limit_posture<>'bounded'
  or src.metadata->>'internal_catalog_correction_allowed' is distinct from 'true'
  or src.metadata->>'automated_read_only_approved' is distinct from 'true'
  or nullif(src.metadata->>'publication_approval_reference','') is null
  or not (src.metadata->'allowed_brands' ? (j.manifest->>'brand')) then raise exception 'ZF correction authorization unavailable'; end if;
 select * into it from public.catalog_zf_job_items where job_id=j.id and organization_id=input_org and item_index=input_index;
 obs:=it.observation; vals:=obs->'fields'; before_values:=obs->'before'; raw_article:=obs->'raw'->'details';
 select id into brand_id_value from public.brands where organization_id=input_org and name=j.manifest->>'brand';
 if obs->>'unavailable' is not null then
  result_value:=jsonb_build_object('status','source_unavailable','reason',obs->>'unavailable');
 else
  if obs is null or obs->>'brand' is distinct from j.manifest->>'brand'
   or upper(regexp_replace(obs->>'code','\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
   or upper(regexp_replace(raw_article->>'number','\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
   or translate(lower(raw_article->>'brandName'),'ö','o') is distinct from lower(j.manifest->>'brand')
   or obs->>'sourceUrl' not like 'https://aftermarket.zf.com/%' then raise exception 'ZF exact source identity mismatch'; end if;
  select count(*) into cardinality from public.catalog_products where organization_id=input_org and brand_id=brand_id_value
   and normalized_code=public.normalize_part_code(it.product_code);
  if cardinality<>1 then raise exception 'ZF catalog identity missing or ambiguous; register the exact product first'; end if;
  select * into p from public.catalog_products where organization_id=input_org and brand_id=brand_id_value
   and normalized_code=public.normalize_part_code(it.product_code) for update;
  if upper(regexp_replace(p.product_code,'\s','','g')) is distinct from upper(regexp_replace(it.product_code,'\s','','g'))
    or before_values->>'id' is distinct from p.id::text then raise exception 'ZF catalog identity changed since review'; end if;
  ean_conflict:=nullif(trim(p.ean),'') is not null and nullif(trim(vals->>'ean'),'') is not null
    and regexp_replace(p.ean,'\s','','g')<>regexp_replace(vals->>'ean','\s','','g');
  -- A foreign SKU-prefixed title invalidates the old title/weight baseline.
  -- Only an exact manufacturer/article receipt with a usable, non-conflicting
  -- official EAN may replace that baseline; normal products keep the outlier hold.
  corrupt_weight_baseline:=not ean_conflict and coalesce(vals->>'ean','') ~ '^[0-9]{8,14}$'
   and length(regexp_replace(coalesce((regexp_match(p.description,'^\s*([0-9][A-Za-z0-9 .,/+-]*?)\s+[-–:]\s+[A-Za-z]'))[1],''),'[^0-9]','','g'))>=5;
  foreach field in array array['description','weight_kg','ean','origin','hs_code'] loop
   value:=vals->field; live:=to_jsonb(p)->field; old_value:=before_values->field;
   if value is null or value='null'::jsonb or value='""'::jsonb then outcomes:=outcomes||jsonb_build_object(field,'source_missing'); continue; end if;
   if field='weight_kg' and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric<=0 or (value#>>'{}')::numeric>100000) then
    outcomes:=outcomes||jsonb_build_object(field,'invalid_source_weight'); continue; end if;
   if live is distinct from old_value then outcomes:=outcomes||jsonb_build_object(field,'changed_since_review'); continue; end if;
   if live=value then outcomes:=outcomes||jsonb_build_object(field,'unchanged'); continue; end if;
   if ean_conflict then outcomes:=outcomes||jsonb_build_object(field,'ean_identity_conflict'); continue; end if;
   -- Existing identifiers/variable commercial facts are never blindly replaced by an official lookup.
   if field in ('ean','origin','hs_code') and live is not null and live not in ('null'::jsonb,'""'::jsonb) then
    outcomes:=outcomes||jsonb_build_object(field,'existing_value_preserved'); continue; end if;
   -- Official sources can contain package/variant errors too. A large existing
   -- weight discrepancy needs a specific product review, not blanket acceptance.
   if field='weight_kg' and not corrupt_weight_baseline and coalesce(p.weight_kg,0)>0 and
    ((value#>>'{}')::numeric/p.weight_kg<0.5 or (value#>>'{}')::numeric/p.weight_kg>2) then
    outcomes:=outcomes||jsonb_build_object(field,'large_weight_difference_review_required'); continue; end if;
   changes:=changes||jsonb_build_object(field,value); outcomes:=outcomes||jsonb_build_object(field,'applied');
  end loop;
  status_text:=raw_article->'status'->>'value';
  if not ean_conflict and status_text ~* '^(discontinued|discontinued article|production discontinued|no longer produced|end of production|production ended)$' then
   if to_jsonb(p)->'lifecycle_status' is not distinct from before_values->'lifecycle_status' then
    changes:=changes||jsonb_build_object('lifecycle_status','discontinued','lifecycle_note','ZF official: '||status_text);
    outcomes:=outcomes||jsonb_build_object('lifecycle_status','applied');
   else outcomes:=outcomes||jsonb_build_object('lifecycle_status','changed_since_review'); end if;
  else outcomes:=outcomes||jsonb_build_object('lifecycle_status','no_explicit_production_stop'); end if;
  -- Update only changed fields; this also avoids triggering full catalog search rebuilds for no-ops.
  for field,value in select e.key,e.value from jsonb_each(changes) e loop
   if field='weight_kg' then execute format('update public.catalog_products set %I=$1::numeric,updated_at=now() where id=$2',field) using value#>>'{}',p.id;
   else execute format('update public.catalog_products set %I=$1,updated_at=now() where id=$2',field) using value#>>'{}',p.id; end if;
  end loop;
  source_hash:=public.catalog_provider_jsonb_sha256(obs->'raw');
  insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
   values(input_org,p.id,'zf_group_official_v2',obs->>'sourceUrl',raw_article->>'number','zf-exact.v2',source_hash)
   on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
  select id into source_id from public.catalog_product_source_records where organization_id=input_org and catalog_product_id=p.id
   and source_key='zf_group_official_v2' and payload_fingerprint=source_hash;
  for edge in select e.value from jsonb_array_elements(coalesce(obs->'replacements','[]')) e loop
   evidence:=edge->'target'->'raw'->'details';
   if edge->>'direction' not in ('replaces','replaced_by') or evidence is null
    or translate(lower(evidence->>'brandName'),'ö','o') is distinct from lower(j.manifest->>'brand')
    or upper(regexp_replace(evidence->>'number','\s','','g')) is distinct from upper(regexp_replace(edge->>'code','\s','','g')) then
    relations:=relations||jsonb_build_array(jsonb_build_object('code',edge->>'code','status','target_unverified')); continue; end if;
   -- A verified target must also be explicitly named by the immutable source, in that direction.
   if not exists(select 1 from jsonb_array_elements(coalesce(raw_article->(case when edge->>'direction'='replaces' then 'replaces' else 'replacedBy' end)->'values','[]')) e
     where upper(regexp_replace(coalesce(e->>'text',e->>'number'),'\s','','g'))=upper(regexp_replace(edge->>'code','\s','','g'))) then
    raise exception 'ZF replacement missing from explicit source evidence'; end if;
   perform public.record_catalog_product_relation(p.id,source_id,case when edge->>'direction'='replaces' then 'replacement' else 'replaced_by' end,j.manifest->>'brand',edge->>'code',null,null);
   v_old_code:=case when edge->>'direction'='replaces' then edge->>'code' else p.product_code end;
   v_new_code:=case when edge->>'direction'='replaces' then p.product_code else edge->>'code' end;
   edge_result:='review_required';
   can_link:=not ean_conflict and not exists(select 1 from jsonb_array_elements(obs->'replacementCandidates') e where e->>'direction'='replaced_by'
    and upper(regexp_replace(e->>'code','\s','','g'))<>upper(regexp_replace(v_new_code,'\s','','g')) and edge->>'direction'='replaced_by');
   select * into target from public.catalog_products where organization_id=input_org and brand_id=brand_id_value and normalized_code=public.normalize_part_code(v_new_code);
   if not exists(select 1 from public.catalog_products where organization_id=input_org and brand_id=brand_id_value and normalized_code=public.normalize_part_code(v_old_code) and upper(regexp_replace(product_code,'\s','','g'))=upper(regexp_replace(v_old_code,'\s','','g'))) then can_link:=false; edge_result:='old_identity_not_in_catalog'; end if;
   if target.id is null or upper(regexp_replace(target.product_code,'\s','','g'))<>upper(regexp_replace(v_new_code,'\s','','g')) then can_link:=false; edge_result:='target_not_in_catalog'; end if;
   if public.normalize_part_code(v_old_code)=public.normalize_part_code(v_new_code) then can_link:=false;edge_result:='normalized_identity_collision'; end if;
   -- Serialize mapping edits for this brand and check the entire reachable graph with a hard bound.
   if not pg_try_advisory_xact_lock(hashtextextended('zf-links:'||input_org::text||brand_id_value::text,0)) then raise exception 'ZF replacement links busy; retry same job'; end if;
   select * into mapping from public.item_code_references where organization_id=input_org and brand_id=brand_id_value and is_active and normalized_old_code=public.normalize_part_code(v_old_code) limit 1;
   if mapping.id is not null then
    can_link:=false;edge_result:=case when upper(regexp_replace(mapping.old_code,'\s','','g'))=upper(regexp_replace(v_old_code,'\s','','g')) and upper(regexp_replace(mapping.new_code,'\s','','g'))=upper(regexp_replace(v_new_code,'\s','','g')) then 'existing_mapping_preserved' else 'existing_mapping_conflict' end;
   end if;
   if can_link then
    with recursive chain(code,path,depth) as (
     select public.normalize_part_code(v_new_code),array[public.normalize_part_code(v_new_code)],0
     union all select r.normalized_new_code,c.path||r.normalized_new_code,c.depth+1 from chain c join public.item_code_references r
      on r.organization_id=input_org and r.brand_id=brand_id_value and r.is_active and r.normalized_old_code=c.code
      where c.depth<16
    ) select exists(select 1 from chain where code=public.normalize_part_code(v_old_code) or depth>=16) into cycles;
    if cycles then edge_result:='cycle_or_depth_conflict';
    else insert into public.item_code_references(organization_id,brand_id,old_code,new_code,reason)
      values(input_org,brand_id_value,v_old_code,v_new_code,'ZF official verified replacement · '||j.id::text);edge_result:='mapping_added';end if;
   end if;
   relations:=relations||jsonb_build_array(jsonb_build_object('old',v_old_code,'new',v_new_code,'status',edge_result));
  end loop;
  result_value:=jsonb_build_object('status','completed','fields',outcomes,'changes',changes,'before',before_values,'relations',relations,'source_fingerprint',source_hash,'source_status',status_text);
 end if;
 insert into public.catalog_zf_item_applications(job_id,item_index,organization_id,catalog_product_id,result)
  values(j.id,input_index,input_org,p.id,result_value);
 return result_value;
end $$;
