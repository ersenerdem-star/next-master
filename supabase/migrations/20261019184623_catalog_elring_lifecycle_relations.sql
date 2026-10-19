-- Explicit, source-backed lifecycle/relations step; never infer from stock,
-- pricing, alternative products or the existence of a replacement relation.
create or replace function public.apply_elring_provider_lifecycle_batch(
  input_run_id uuid, input_brand_id uuid, input_offset integer default 0, input_batch_size integer default 25
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
set statement_timeout = '30s'
as $function$
declare
  r public.catalog_import_runs%rowtype;
  s public.catalog_external_sources%rowtype;
  p public.catalog_products%rowtype;
  staged record;
  article jsonb;
  entry jsonb;
  direction text;
  target text;
  v_source_record_id uuid;
  source_fingerprint text;
  status_label text;
  source_status text;
  processed integer := 0;
  discontinued_applied integer := 0;
  no_explicit_signal integer := 0;
  lifecycle_conflicts integer := 0;
  rejected_relations integer := 0;
  recorded_relations integer := 0;
  before_relations integer;
  relation_total integer;
  outcomes jsonb := '[]'::jsonb;
  seen_targets jsonb;
  accepted_unique integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
  if input_offset is null or input_offset < 0 or input_batch_size is null or input_batch_size not between 1 and 25 then
    raise exception 'Invalid package batch'; end if;
  select * into r from public.catalog_import_runs where id=input_run_id;
  if r.id is null or r.input_scope->>'source_key' is distinct from 'tecalliance_elring'
    or lower(r.input_scope->>'brand_name') is distinct from 'elring' then raise exception 'Invalid Elring run'; end if;
  select * into s from public.catalog_external_sources where organization_id=r.organization_id and source_key='tecalliance_elring';
  if s.id is null or s.is_active is not true or s.license_posture is distinct from 'allowed'
    or s.credential_boundary is distinct from 'none' or s.rate_limit_posture is distinct from 'bounded'
    or s.metadata->>'internal_catalog_persistence_allowed' is distinct from 'true'
    or nullif(s.metadata->>'approval_actor','') is null
    or nullif(s.metadata->>'publication_approval_reference','') is null then raise exception 'Elring publication authorization missing'; end if;
  if not exists(select 1 from public.brands where id=input_brand_id and organization_id=r.organization_id and lower(name)='elring') then
    raise exception 'Elring brand scope mismatch'; end if;
  if not exists(select 1 from public.catalog_provider_stage_publications where run_id=r.id and brand_id=input_brand_id
    and source_id=s.id and approval_actor=s.metadata->>'approval_actor'
    and approval_reference=s.metadata->>'publication_approval_reference' and status='completed') then
    raise exception 'Elring package publication must complete first'; end if;
  for staged in select * from public.catalog_import_stage where run_id=r.id and organization_id=r.organization_id
    order by row_index limit input_batch_size offset input_offset
  loop
    article := staged.source_payload->'raw';
    if jsonb_typeof(article) is distinct from 'object' or upper(trim(article->>'mfrName')) is distinct from 'ELRING'
      or article->>'dataSupplierId' is distinct from '10'
      or public.normalize_part_code(article->>'articleNumber') is distinct from staged.normalized_code then
      raise exception 'Elring lifecycle evidence identity mismatch'; end if;
    foreach direction in array array['replacesArticles','replacedByArticles'] loop
      if article ? direction and jsonb_typeof(article->direction) <> 'null' then
        if jsonb_typeof(article->direction) <> 'array' then raise exception 'Invalid Elring relation evidence'; end if;
        if jsonb_array_length(article->direction)>50 then raise exception 'Elring relation evidence bound exceeded'; end if;
      end if;
    end loop;
    select * into p from public.catalog_products where organization_id=r.organization_id and brand_id=input_brand_id
      and normalized_code=staged.normalized_code for update;
    if p.id is null then raise exception 'Published Elring product missing'; end if;
    source_fingerprint := public.catalog_provider_jsonb_sha256(article);
    insert into public.catalog_product_source_records(organization_id,catalog_product_id,source_key,source_url,
      source_product_id,source_version,payload_fingerprint)
    values(r.organization_id,p.id,'tecalliance_elring',staged.source_url,article->>'articleNumber','elring-lifecycle.v1',source_fingerprint)
    on conflict (organization_id,catalog_product_id,source_key,payload_fingerprint) do nothing;
    select id into v_source_record_id from public.catalog_product_source_records where organization_id=r.organization_id
      and catalog_product_id=p.id and source_key='tecalliance_elring' and payload_fingerprint=source_fingerprint;
    select count(*) into before_relations from public.catalog_product_relations where organization_id=r.organization_id
      and catalog_product_id=p.id and catalog_product_relations.source_record_id=v_source_record_id;
    seen_targets:='{}'::jsonb; accepted_unique:=0;
    foreach direction in array array['replacesArticles','replacedByArticles'] loop
      for entry in select value from jsonb_array_elements(coalesce(nullif(article->direction,'null'::jsonb),'[]'::jsonb)) loop
        target := trim(entry->>'articleNumber');
        if not (coalesce(case when nullif(trim(entry->>'mfrName'),'') is not null then upper(trim(entry->>'mfrName'))='ELRING'
          else nullif(article->>'mfrId','') is not null and entry->>'mfrId'=article->>'mfrId' end,false))
          or target is null or target !~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{1,59}$' or target !~ '[0-9]'
          or public.normalize_part_code(target)=p.normalized_code then rejected_relations:=rejected_relations+1; continue; end if;
        if seen_targets ? public.normalize_part_code(target) then
          if seen_targets->>public.normalize_part_code(target) <> direction then raise exception 'Elring replacement direction conflict'; end if;
        else
          accepted_unique:=accepted_unique+1;
          if accepted_unique>20 then raise exception 'Elring relation evidence bound exceeded'; end if;
          seen_targets:=seen_targets||jsonb_build_object(public.normalize_part_code(target),direction);
        end if;
        perform public.record_catalog_product_relation(p.id,v_source_record_id,
          case when direction='replacesArticles' then 'replacement' else 'replaced_by' end,'Elring',target,null,null);
      end loop;
    end loop;
    select count(*) into relation_total from public.catalog_product_relations where organization_id=r.organization_id
      and catalog_product_id=p.id and catalog_product_relations.source_record_id=v_source_record_id;
    recorded_relations:=recorded_relations+relation_total-before_relations;
    status_label := nullif(trim(article#>>'{misc,articleStatusDescription}'),'');
    source_status := case when lower(status_label) ~ '^(discontinued|discontinued article|production discontinued|no longer produced|end of production|production ended)$'
      then 'discontinued' else null end;
    if source_status is null then no_explicit_signal:=no_explicit_signal+1;
    elsif coalesce(p.lifecycle_status,'') in ('','active') then
      update public.catalog_products set lifecycle_status='discontinued',
        lifecycle_note=coalesce(nullif(trim(lifecycle_note),''),'Elring official status: '||status_label),updated_at=now() where id=p.id;
      discontinued_applied:=discontinued_applied+1;
    elsif p.lifecycle_status <> 'discontinued' then
      insert into public.product_attribute_conflicts(organization_id,product_id,brand_id,product_code,field_name,
        existing_value,incoming_value,normalized_incoming_value,source_type,source_reference)
      values(r.organization_id,p.id,input_brand_id,p.product_code,'lifecycle_status',p.lifecycle_status,'discontinued','discontinued','tecalliance_elring',staged.source_url)
      on conflict (organization_id,product_id,field_name,normalized_incoming_value) where status='pending_review'
      do update set last_detected_at=now(),detection_count=public.product_attribute_conflicts.detection_count+1;
      lifecycle_conflicts:=lifecycle_conflicts+1;
    end if;
    outcomes:=outcomes||jsonb_build_array(jsonb_build_object('product_code',p.product_code,'source_status',status_label,
      'explicit_discontinued',source_status is not null,'source_record_id',v_source_record_id,'relation_evidence_count',relation_total));
    processed:=processed+1;
  end loop;
  return jsonb_build_object('processed',processed,'discontinued_applied',discontinued_applied,'no_explicit_signal',no_explicit_signal,
    'lifecycle_conflicts',lifecycle_conflicts,'relations_inserted',recorded_relations,'rejected_relations',rejected_relations,'outcomes',outcomes,
    'operational_replacement_mapping',false,'automatic_reactivation',false);
end;
$function$;
revoke all on function public.apply_elring_provider_lifecycle_batch(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.apply_elring_provider_lifecycle_batch(uuid,uuid,integer,integer) to service_role;
select pg_notify('pgrst','reload schema');
