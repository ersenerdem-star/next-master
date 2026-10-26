set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- The older ZF and official Elring workers use their own job tables. Present
-- their sealed held receipts in the same decision UI without changing workers.
create function public.get_catalog_legacy_engine_review_queue(
  input_org uuid, input_brand text, input_status text default 'pending',
  input_limit integer default 50, input_offset integer default 0
) returns jsonb language plpgsql stable security definer
set search_path = '' set statement_timeout = '12s' as $$
declare result_value jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'REVIEW_SERVICE_REQUIRED'; end if;
  if input_status not in ('pending','approved','rejected','all') or input_limit not between 1 and 100
    or input_offset not between 0 and 100000 then raise exception 'REVIEW_PAGE_INVALID'; end if;
  with receipts as (
    select 'zf'::text engine, j.id job_id, j.organization_id, j.manifest->>'brand' brand,
      'zf_group_official_v2'::text source_key, j.created_at, i.item_index, i.product_code,
      i.observation, i.checkpoint
    from public.catalog_zf_jobs j join public.catalog_zf_job_items i on i.job_id=j.id
    where j.organization_id=input_org and j.manifest->>'brand'=input_brand
      and j.status in ('reviewed','completed','failed') and i.observation is not null
    union all
    select 'elring'::text, j.id, j.organization_id, 'Elring'::text,
      'tecalliance_elring'::text, j.created_at, i.item_index, i.product_code,
      i.observation, i.checkpoint
    from public.catalog_elring_jobs j join public.catalog_elring_job_items i on i.job_id=j.id
    where j.organization_id=input_org and input_brand='Elring'
      and j.status in ('reviewed','completed','failed') and i.observation is not null
  ), latest as (
    select distinct on(engine, product_code) * from receipts
    order by engine, product_code, created_at desc, item_index desc
  ), candidates as (
    select l.*, coalesce(nullif(l.observation->>'fingerprint',''),md5(l.observation::text)) fingerprint,
      l.product_code || '|' || coalesce(l.observation->>'sourceUrl','') review_key,
      coalesce(nullif(l.checkpoint->>'reason',''),
        case when l.checkpoint->'fields'->>'ean'='ean_identity_conflict' then 'EAN_IDENTITY_CONFLICT' end,
        nullif(l.observation->>'unavailable',''),
        l.observation->'issues'->0->>'code','REVIEW_REQUIRED') reason
    from latest l
    where l.checkpoint->>'status'='held'
      or l.checkpoint->'fields'->>'ean'='ean_identity_conflict'
      or l.observation->>'unavailable' is not null
      or jsonb_array_length(case when jsonb_typeof(l.observation->'issues')='array' then l.observation->'issues' else '[]'::jsonb end)>0
  ), decided as (
    select c.*, case when d.observation_fingerprint=c.fingerprint then d.decision else null end decision,
      case when d.observation_fingerprint=c.fingerprint then d.application else '{}'::jsonb end application,
      case when d.observation_fingerprint=c.fingerprint then d.decided_at else null end decided_at
    from candidates c left join public.catalog_engine_review_decisions d
      on d.organization_id=c.organization_id and d.source_key=c.source_key and d.review_key=c.review_key
  ), filtered as (
    select * from decided where input_status='all' or (input_status='pending' and decision is null) or decision=input_status
  ), counted as (select count(*) total from filtered), page as (
    select * from filtered order by created_at desc, job_id desc, item_index desc limit input_limit offset input_offset
  )
  select jsonb_build_object('total',counted.total,'items',coalesce((select jsonb_agg(jsonb_build_object(
    'engine',p.engine,'jobId',p.job_id,'itemIndex',p.item_index,'receiptIndex',0,
    'brand',p.brand,'sourceKey',p.source_key,'reviewKey',p.review_key,'productCode',p.product_code,
    'reason',p.reason,'fingerprint',p.fingerprint,'sourceUrl',p.observation->>'sourceUrl',
    'sourceEan',p.observation->'fields'->>'ean','currentEan',p.observation->'before'->>'ean',
    'currentDescription',p.observation->'before'->>'description','sourceDescription',p.observation->'fields'->>'description',
    'canApprove',p.engine='zf' and p.reason='EAN_IDENTITY_CONFLICT'
      and p.observation->'fields'->>'ean' ~ '^[0-9]{8,14}$'
      and p.observation->'before'->>'id' is not null,
    'decision',p.decision,'application',p.application,'decidedAt',p.decided_at,
    'observedAt',p.observation->>'observedAt')) from page p),'[]'::jsonb))
  into result_value from counted;
  return result_value;
end $$;

create function public.decide_catalog_legacy_engine_review_item(
  input_org uuid,input_actor uuid,input_engine text,input_job uuid,input_index integer,
  input_fingerprint text,input_decision text
) returns jsonb language plpgsql security definer
set search_path = '' set lock_timeout = '2s' set statement_timeout = '8s' as $$
declare job_brand text; job_status text; observation jsonb; checkpoint jsonb; product_code text;
  source_key_value text; source_ean text; review_key_value text; fingerprint_value text;
  decision_row public.catalog_engine_review_decisions%rowtype; p public.catalog_products%rowtype;
  s public.catalog_external_sources%rowtype; application_value jsonb:='{}'::jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'REVIEW_SERVICE_REQUIRED'; end if;
  if input_engine not in ('zf','elring') or input_decision not in ('approved','rejected') then raise exception 'REVIEW_DECISION_INVALID'; end if;
  if not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active)
    then raise exception 'REVIEW_ADMIN_REQUIRED'; end if;
  if input_engine='zf' then
    select j.manifest->>'brand',j.status,i.observation,i.checkpoint,i.product_code
      into job_brand,job_status,observation,checkpoint,product_code
    from public.catalog_zf_jobs j join public.catalog_zf_job_items i on i.job_id=j.id
    where j.organization_id=input_org and j.id=input_job and i.item_index=input_index for update of j,i;
    source_key_value:='zf_group_official_v2';
  else
    select 'Elring',j.status,i.observation,i.checkpoint,i.product_code
      into job_brand,job_status,observation,checkpoint,product_code
    from public.catalog_elring_jobs j join public.catalog_elring_job_items i on i.job_id=j.id
    where j.organization_id=input_org and j.id=input_job and i.item_index=input_index for update of j,i;
    source_key_value:='tecalliance_elring';
  end if;
  if job_status not in ('reviewed','completed','failed') or observation is null then raise exception 'REVIEW_JOB_NOT_READY'; end if;
  if checkpoint->>'status' is distinct from 'held' and checkpoint->'fields'->>'ean' is distinct from 'ean_identity_conflict'
    and observation->>'unavailable' is null
    and jsonb_array_length(case when jsonb_typeof(observation->'issues')='array' then observation->'issues' else '[]'::jsonb end)=0
    then raise exception 'REVIEW_ITEM_NOT_HELD'; end if;
  fingerprint_value:=coalesce(nullif(observation->>'fingerprint',''),md5(observation::text));
  if fingerprint_value is distinct from input_fingerprint then raise exception 'REVIEW_OBSERVATION_CHANGED'; end if;
  review_key_value:=product_code||'|'||coalesce(observation->>'sourceUrl','');
  select * into decision_row from public.catalog_engine_review_decisions
    where organization_id=input_org and source_key=source_key_value and review_key=review_key_value for update;
  if decision_row.organization_id is not null and decision_row.observation_fingerprint=fingerprint_value then
    if decision_row.decision=input_decision then
      return jsonb_build_object('decision',decision_row.decision,'application',decision_row.application,'replayed',true); end if;
    raise exception 'REVIEW_DECISION_ALREADY_RECORDED';
  end if;
  if input_decision='approved' then
    -- Only ZF EAN conflicts have a validated direct application path here.
    if input_engine<>'zf' or (checkpoint->>'reason' is distinct from 'EAN_IDENTITY_CONFLICT'
      and checkpoint->'fields'->>'ean' is distinct from 'ean_identity_conflict')
      or observation->>'unavailable' is not null then raise exception 'REVIEW_APPLY_UNSUPPORTED'; end if;
    source_ean:=observation->'fields'->>'ean';
    if source_ean !~ '^[0-9]{8,14}$' then raise exception 'REVIEW_SOURCE_EAN_INVALID'; end if;
    select * into s from public.catalog_external_sources where organization_id=input_org and source_key=source_key_value;
    if s.id is null or not s.is_active or s.metadata->>'internal_catalog_correction_allowed' is distinct from 'true'
      or not (s.metadata->'allowed_brands' ? job_brand)
      or observation->>'sourceUrl' not like 'https://aftermarket.zf.com/%'
      or observation->>'brand' is distinct from job_brand
      or upper(regexp_replace(observation->'raw'->'details'->>'number','\s','','g'))
         is distinct from upper(regexp_replace(product_code,'\s','','g'))
      then raise exception 'REVIEW_SOURCE_NOT_AUTHORIZED'; end if;
    select * into p from public.catalog_products where id=(observation->'before'->>'id')::uuid and organization_id=input_org for update;
    if p.id is null or p.product_code is distinct from product_code
      or p.brand_id is distinct from (select id from public.brands where organization_id=input_org and name=job_brand)
      or p.ean is distinct from observation->'before'->>'ean' then raise exception 'REVIEW_CATALOG_CHANGED'; end if;
    update public.catalog_products set ean=source_ean,updated_at=now() where id=p.id;
    application_value:=jsonb_build_object('status','applied','field','ean','before',p.ean,'after',source_ean,'productId',p.id);
  end if;
  insert into public.catalog_engine_review_decisions
    (organization_id,source_key,review_key,observation_fingerprint,decision,decided_by,application)
  values(input_org,source_key_value,review_key_value,fingerprint_value,input_decision,input_actor,application_value)
  on conflict(organization_id,source_key,review_key) do update
    set observation_fingerprint=excluded.observation_fingerprint,decision=excluded.decision,
      decided_by=excluded.decided_by,decided_at=now(),application=excluded.application;
  insert into public.catalog_observation_audit_ledger(organization_id,actor_id,action,evidence_reference,payload)
  values(input_org,input_actor,'catalog_engine_review_'||input_decision,observation->>'sourceUrl',
    jsonb_build_object('engine',input_engine,'job_id',input_job,'item_index',input_index,
      'source_key',source_key_value,'fingerprint',fingerprint_value,'application',application_value));
  return jsonb_build_object('decision',input_decision,'application',application_value,'replayed',false);
end $$;

revoke all on function public.get_catalog_legacy_engine_review_queue(uuid,text,text,integer,integer),
  public.decide_catalog_legacy_engine_review_item(uuid,uuid,text,uuid,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.get_catalog_legacy_engine_review_queue(uuid,text,text,integer,integer),
  public.decide_catalog_legacy_engine_review_item(uuid,uuid,text,uuid,integer,text,text) to service_role;
select pg_notify('pgrst','reload schema');
