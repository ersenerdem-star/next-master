set lock_timeout='500ms';set statement_timeout='5s';
create function public.apply_elring_complete_vehicle_fitment(input_run_id uuid,input_row_index integer,input_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='3s' set lock_timeout='250ms'
as $$
declare
 j public.catalog_elring_completion_jobs%rowtype;
 r public.catalog_import_runs%rowtype;
 s public.catalog_external_sources%rowtype;
 st public.catalog_import_stage%rowtype;
 p public.catalog_products%rowtype;
 v_vehicle text; v_models text; v_fingerprint text; v_count integer; v_before jsonb; v_after jsonb; incoming jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if input_row_index is null or input_row_index<0 or jsonb_typeof(input_evidence) is distinct from 'object'
  or input_evidence->>'complete' is distinct from 'true'
  or jsonb_typeof(input_evidence->'coverage') is distinct from 'array'
  or jsonb_typeof(input_evidence->'vehicles') is distinct from 'array'
  or input_evidence->>'evidence_manifest_sha256' !~ '^[a-f0-9]{64}$'
 then raise exception 'Complete vehicle evidence required'; end if;
 select * into j from public.catalog_elring_completion_jobs where run_id=input_run_id and phase='fitment' for update;
 if j.run_id is null or j.status='paused' or j.approved_until<now() then raise exception 'Fitment approval missing or expired'; end if;
 select * into r from public.catalog_import_runs where id=j.run_id and organization_id=j.organization_id;
 select * into s from public.catalog_external_sources where id=j.source_id and organization_id=j.organization_id;
 if r.status is distinct from 'staged' or r.input_scope->>'manifest_fingerprint' is distinct from j.manifest_fingerprint
  or r.input_scope->>'source_key' is distinct from 'tecalliance_elring' or r.input_scope->>'collection_verified' is distinct from 'true'
  or s.is_active is distinct from false or s.source_key is distinct from 'tecalliance_elring' or s.license_posture is distinct from 'allowed'
  or s.metadata->>'internal_catalog_persistence_allowed' is distinct from 'true'
  or not exists(select 1 from public.catalog_provider_stage_publications where run_id=j.run_id and brand_id=j.brand_id
   and source_id=j.source_id and status='completed')
 then raise exception 'Elring fitment scope mismatch'; end if;
 select * into st from public.catalog_import_stage where run_id=j.run_id and organization_id=j.organization_id and row_index=input_row_index;
 if st.run_id is null or st.source_key is distinct from 'tecalliance_elring'
  or st.source_payload->'raw'->>'mfrName' is distinct from 'ELRING'
  or st.source_payload->'raw'->>'dataSupplierId' is distinct from '10'
  or input_evidence->>'product_code' is distinct from st.product_code
  or input_evidence->>'stage_fingerprint' is distinct from st.source_fingerprint
 then raise exception 'Fitment article identity mismatch'; end if;
 v_fingerprint:=public.catalog_provider_jsonb_sha256(input_evidence);
 if input_row_index<=j.cursor then
  if not exists(select 1 from public.catalog_elring_completion_events where run_id=j.run_id and phase='fitment'
   and row_index=input_row_index and after_fields->>'fitment_evidence_fingerprint'=v_fingerprint)
  then raise exception 'Fitment replay evidence mismatch'; end if;
  return to_jsonb(j);
 end if;
 if input_row_index<>j.cursor+1 then raise exception 'Fitment cursor gap'; end if;
 -- Every vehicle-bearing generic article must have an untruncated list and
 -- resolved detail record for every official linkage target. Engines/axles are
 -- separate target classes; this boundary publishes vehicle makes/models only.
 if exists(select 1 from jsonb_array_elements(st.source_payload->'raw'->'genericArticles') g
   where coalesce(g->'linkageTargetTypes','[]'::jsonb) ?| array['V','L','P','O','C','B']
    and not exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c
      where c->>'article_id'=g->>'legacyArticleId' and c->>'complete'='true'
       and c->>'target_type' in ('PO','B') and c->>'pairs_count'=c->>'resolved_count'
       and jsonb_typeof(c->'target_keys')='array' and jsonb_array_length(c->'target_keys')=(c->>'pairs_count')::integer
       and c->>'pairs_fingerprint' ~ '^[a-f0-9]{64}$'))
  or exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c
    where not exists(select 1 from jsonb_array_elements(st.source_payload->'raw'->'genericArticles') g
      where g->>'legacyArticleId'=c->>'article_id') or (c->>'pairs_count')::integer<0)
 then raise exception 'Incomplete vehicle linkage coverage'; end if;
 v_count:=jsonb_array_length(input_evidence->'vehicles');
 if v_count>100000 or exists(select 1 from jsonb_array_elements(input_evidence->'vehicles') v
   where coalesce(v->>'target_type','') not in ('P','O','B') or coalesce(v->>'target_id','') !~ '^[1-9][0-9]*$'
    or nullif(trim(v->>'manuDesc'),'') is null or nullif(trim(v->>'modelDesc'),'') is null)
 then raise exception 'Invalid vehicle detail evidence'; end if;
 if exists(select 1 from jsonb_array_elements(input_evidence->'vehicles') v
    where not exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c
     where c->'target_keys' ? ((v->>'target_type')||':'||(v->>'target_id'))))
  or exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c,
    lateral jsonb_array_elements_text(c->'target_keys') k
    where not exists(select 1 from jsonb_array_elements(input_evidence->'vehicles') v
     where (v->>'target_type')||':'||(v->>'target_id')=k.value))
 then raise exception 'Vehicle target coverage mismatch'; end if;
 if v_count=0 and exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c where (c->>'pairs_count')::integer>0)
 then raise exception 'Vehicle details missing'; end if;
 select string_agg(name,', ' order by name) into v_vehicle from
  (select distinct trim(v->>'manuDesc') as name from jsonb_array_elements(input_evidence->'vehicles') v) names;
 select string_agg(name,', ' order by name) into v_models from
  (select distinct trim(v->>'manuDesc')||' '||trim(v->>'modelDesc') as name from jsonb_array_elements(input_evidence->'vehicles') v) names;
 select * into p from public.catalog_products where organization_id=j.organization_id and brand_id=j.brand_id and normalized_code=st.normalized_code for update;
 if p.id is null then raise exception 'Published fitment product missing'; end if;
 v_before:=jsonb_build_object('vehicle',p.vehicle,'vehicle_model',p.vehicle_model);
 incoming:=jsonb_build_object('organization_id',j.organization_id,'brand_id',j.brand_id,'product_code',p.product_code,
  'vehicle_model',v_models,'source_reference',st.source_url);
 if nullif(trim(p.vehicle),'') is null then incoming:=incoming||jsonb_build_object('vehicle',v_vehicle);
 elsif v_vehicle is not null and p.vehicle<>v_vehicle then
  insert into public.product_attribute_conflicts(organization_id,product_id,brand_id,product_code,field_name,existing_value,
   incoming_value,normalized_incoming_value,source_type,source_reference)
  values(j.organization_id,p.id,j.brand_id,p.product_code,'vehicle',p.vehicle,v_vehicle,
   public.normalize_product_conflict_value('vehicle',v_vehicle),'tecalliance_elring',st.source_url)
  on conflict(organization_id,product_id,field_name,normalized_incoming_value) where status='pending_review'
  do update set last_detected_at=now(),detection_count=public.product_attribute_conflicts.detection_count+1;
 end if;
 if v_count>0 then
  perform public.apply_catalog_provider_enrichment_protocol(jsonb_build_array(incoming),'tecalliance_elring',st.source_url);
 end if;
 insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,source_product_id,source_version,payload_fingerprint)
 values(j.organization_id,p.id,'tecalliance_elring',st.source_url,st.product_code,'elring-vehicle-fitment.v1',v_fingerprint)
 on conflict(organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
 select jsonb_build_object('vehicle',vehicle,'vehicle_model',vehicle_model) into v_after from public.catalog_products where id=p.id;
 insert into public.catalog_elring_completion_events(run_id,phase,row_index,organization_id,product_id,product_code,before_fields,after_fields,outcome,evidence_fingerprint)
 values(j.run_id,'fitment',input_row_index,j.organization_id,p.id,p.product_code,v_before,
  v_after||jsonb_build_object('fitment_evidence_fingerprint',v_fingerprint,'evidence_manifest_sha256',input_evidence->>'evidence_manifest_sha256',
   'vehicle_count',v_count,'coverage',input_evidence->'coverage'),
  case when v_count=0 then 'source_no_vehicle_linkages' when v_before is distinct from v_after then 'changed' else 'preserved_or_verified' end,st.source_fingerprint);
 update public.catalog_elring_completion_jobs set cursor=input_row_index,processed=j.processed+1,
  changed=j.changed+case when v_before is distinct from v_after then 1 else 0 end,
  totals=jsonb_build_object('vehicle_records',coalesce((j.totals->>'vehicle_records')::bigint,0)+v_count),
  status=case when input_row_index=r.staged_rows-1 then 'completed' else 'running' end,updated_at=now()
 where run_id=j.run_id and phase='fitment' returning * into j;
 return to_jsonb(j);
end $$;
revoke all on function public.apply_elring_complete_vehicle_fitment(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.apply_elring_complete_vehicle_fitment(uuid,integer,jsonb) to service_role;
notify pgrst,'reload schema';
