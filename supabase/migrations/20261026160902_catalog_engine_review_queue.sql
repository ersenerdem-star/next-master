set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Decisions are keyed by source and product identity, rather than a transient
-- worker job. A fresh observation fingerprint reopens the item for review.
create table public.catalog_engine_review_decisions (
  organization_id uuid not null,
  source_key text not null,
  review_key text not null,
  observation_fingerprint text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  decided_by uuid not null references public.profiles(id),
  decided_at timestamptz not null default now(),
  application jsonb not null default '{}'::jsonb,
  primary key (organization_id, source_key, review_key)
);
create index catalog_engine_review_decisions_actor on public.catalog_engine_review_decisions(decided_by, decided_at desc);
alter table public.catalog_engine_review_decisions enable row level security;
revoke all on public.catalog_engine_review_decisions from public, anon, authenticated;
grant select, insert, update on public.catalog_engine_review_decisions to service_role;

-- This function reads sealed worker receipts from every catalog brand engine.
-- It deliberately does not alter the worker queue or wait for human decisions.
create function public.get_catalog_engine_review_queue(
  input_org uuid, input_brand text, input_status text default 'pending',
  input_limit integer default 50, input_offset integer default 0
) returns jsonb language plpgsql stable security definer
set search_path = '' set statement_timeout = '20s' as $$
declare result_value jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'REVIEW_SERVICE_REQUIRED'; end if;
  if input_brand is null or length(input_brand) > 120 then raise exception 'REVIEW_BRAND_REQUIRED'; end if;
  if input_status not in ('pending','approved','rejected','all') then raise exception 'REVIEW_STATUS_INVALID'; end if;
  if input_limit not between 1 and 100 or input_offset not between 0 and 100000 then raise exception 'REVIEW_PAGE_INVALID'; end if;

  with latest_scan as (
    select distinct on (j.manifest->>'source_key') j.manifest->>'source_key' source_key,
      j.manifest->>'scan_id' scan_id
    from public.catalog_brand_jobs j
    where j.organization_id = input_org and j.manifest->>'brand' = input_brand
      and j.manifest->>'adapter' like 'wilmink%discovery.v1'
      and j.status = 'reviewed' and nullif(j.manifest->>'scan_id','') is not null
    order by j.manifest->>'source_key', j.created_at desc
  ), receipts as (
    select j.id job_id, j.organization_id, j.manifest->>'brand' brand,
      j.manifest->>'source_key' source_key, j.manifest->>'adapter' adapter,
      j.created_at job_created_at, i.item_index, i.state, i.checkpoint,
      (v.ordinality - 1)::integer receipt_index, v.value observation,
      coalesce(nullif(v.value->>'sourceUrl',''), nullif(v.value->'before'->>'id',''), nullif(v.value->>'code','')) review_key
    from public.catalog_brand_jobs j
    join public.catalog_brand_job_items i on i.job_id = j.id and i.organization_id = j.organization_id
    left join latest_scan ls on ls.source_key = j.manifest->>'source_key'
    cross join lateral jsonb_array_elements(
      case when j.manifest->>'adapter' like 'wilmink%discovery.v1'
        then coalesce(i.observation->'products','[]'::jsonb)
        else jsonb_build_array(coalesce(i.observation,'{}'::jsonb)) end
    ) with ordinality v(value, ordinality)
    where j.organization_id = input_org and j.manifest->>'brand' = input_brand
      and j.status in ('reviewed','completed','failed')
      and i.observation is not null
      and nullif(j.manifest->>'source_key','') is not null
      and (ls.scan_id is null or j.manifest->>'scan_id' = ls.scan_id or j.manifest->>'scan_id' is null)
  ), latest as (
    select distinct on (source_key, review_key) * from receipts
    where review_key is not null
    order by source_key, review_key, job_created_at desc, item_index desc, receipt_index desc
  ), candidates as (
    select l.*,
      coalesce(nullif(l.observation->>'fingerprint',''), md5(l.observation::text)) fingerprint,
      coalesce(nullif(l.observation->>'code',''),nullif(l.checkpoint->>'productCode',''),l.review_key) product_code,
      coalesce(nullif(l.checkpoint->>'reason',''),nullif(l.observation->>'unavailable',''),
        l.observation->'issues'->0->>'code','REVIEW_REQUIRED') reason
    from latest l
    where l.checkpoint->>'status' = 'held'
      or nullif(l.observation->>'unavailable','') is not null
      or jsonb_array_length(case when jsonb_typeof(l.observation->'issues') = 'array' then l.observation->'issues' else '[]'::jsonb end) > 0
  ), decided as (
    select c.*,
      case when d.observation_fingerprint = c.fingerprint then d.decision else null end decision,
      case when d.observation_fingerprint = c.fingerprint then d.application else '{}'::jsonb end application,
      case when d.observation_fingerprint = c.fingerprint then d.decided_at else null end decided_at
    from candidates c
    left join public.catalog_engine_review_decisions d on d.organization_id = c.organization_id
      and d.source_key = c.source_key and d.review_key = c.review_key
  ), filtered as (
    select * from decided where input_status = 'all'
      or (input_status = 'pending' and decision is null)
      or decision = input_status
  ), counted as (select count(*) total from filtered), page as (
    select * from filtered order by job_created_at desc, job_id desc, item_index desc, receipt_index desc
    limit input_limit offset input_offset
  )
  select jsonb_build_object('total', counted.total, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'jobId',p.job_id,'itemIndex',p.item_index,'receiptIndex',p.receipt_index,
      'brand',p.brand,'sourceKey',p.source_key,'reviewKey',p.review_key,
      'productCode',p.product_code,'reason',p.reason,'fingerprint',p.fingerprint,
      'sourceUrl',p.observation->>'sourceUrl','sourceEan',p.observation->'sourceFields'->>'ean',
      'currentEan',p.observation->'before'->>'ean',
      'currentDescription',p.observation->'before'->>'description',
      'sourceDescription',coalesce(p.observation->'sourceFields'->>'description',p.observation->'fields'->>'description'),
      'canApprove',p.reason = 'EAN_IDENTITY_CONFLICT' and p.observation->'exactIdentity' = 'true'::jsonb
        and p.observation->'before'->>'id' is not null
        and p.observation->'sourceFields'->>'ean' ~ '^[0-9]{8,14}$',
      'decision',p.decision,'application',p.application,'decidedAt',p.decided_at,
      'observedAt',p.observation->>'observedAt')) from page p
  ),'[]'::jsonb)) into result_value from counted;
  return result_value;
end $$;

create function public.decide_catalog_engine_review_item(
  input_org uuid, input_actor uuid, input_job uuid, input_index integer,
  input_receipt_index integer, input_fingerprint text, input_decision text
) returns jsonb language plpgsql security definer
set search_path = '' set lock_timeout = '2s' set statement_timeout = '8s' as $$
declare j public.catalog_brand_jobs%rowtype; i public.catalog_brand_job_items%rowtype;
  s public.catalog_external_sources%rowtype; p public.catalog_products%rowtype;
  observation jsonb; decision_row public.catalog_engine_review_decisions%rowtype;
  v_review_key text; v_source_key text; fingerprint text; source_ean text;
  source_host text; application_value jsonb := '{}'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'REVIEW_SERVICE_REQUIRED'; end if;
  if input_decision not in ('approved','rejected') then raise exception 'REVIEW_DECISION_INVALID'; end if;
  if not exists(select 1 from public.profiles where id = input_actor and organization_id = input_org
      and role = 'superadmin' and is_active) then raise exception 'REVIEW_ADMIN_REQUIRED'; end if;
  select * into j from public.catalog_brand_jobs where id = input_job and organization_id = input_org for update;
  if j.id is null or j.status not in ('reviewed','completed','failed') then raise exception 'REVIEW_JOB_NOT_READY'; end if;
  select * into i from public.catalog_brand_job_items where job_id = input_job and organization_id = input_org
    and item_index = input_index for update;
  if i.job_id is null or i.observation is null then raise exception 'REVIEW_ITEM_NOT_FOUND'; end if;
  if j.manifest->>'adapter' like 'wilmink%discovery.v1' then
    observation := i.observation->'products'->input_receipt_index;
  elsif input_receipt_index = 0 then observation := i.observation;
  else raise exception 'REVIEW_ITEM_NOT_FOUND'; end if;
  if observation is null then raise exception 'REVIEW_ITEM_NOT_FOUND'; end if;
  if i.checkpoint->>'status' is distinct from 'held'
    and nullif(observation->>'unavailable','') is null
    and jsonb_array_length(case when jsonb_typeof(observation->'issues') = 'array' then observation->'issues' else '[]'::jsonb end) = 0
    then raise exception 'REVIEW_ITEM_NOT_HELD'; end if;
  fingerprint := coalesce(nullif(observation->>'fingerprint',''),md5(observation::text));
  if fingerprint is distinct from input_fingerprint then raise exception 'REVIEW_OBSERVATION_CHANGED'; end if;
  v_source_key := j.manifest->>'source_key';
  v_review_key := coalesce(nullif(observation->>'sourceUrl',''),nullif(observation->'before'->>'id',''),nullif(observation->>'code',''));
  if v_source_key is null or v_review_key is null then raise exception 'REVIEW_IDENTITY_MISSING'; end if;
  select * into decision_row from public.catalog_engine_review_decisions
    where organization_id = input_org and source_key = v_source_key
      and review_key = v_review_key for update;
  if decision_row.organization_id is not null and decision_row.observation_fingerprint = fingerprint then
    if decision_row.decision = input_decision then
      return jsonb_build_object('decision',decision_row.decision,'application',decision_row.application,'replayed',true);
    end if;
    raise exception 'REVIEW_DECISION_ALREADY_RECORDED';
  end if;
  if input_decision = 'approved' then
    if observation->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb is not true
      or observation->'exactIdentity' is distinct from 'true'::jsonb
      or observation->>'unavailable' is not null then raise exception 'REVIEW_APPLY_UNSUPPORTED'; end if;
    source_ean := observation->'sourceFields'->>'ean';
    if source_ean !~ '^[0-9]{8,14}$' then raise exception 'REVIEW_SOURCE_EAN_INVALID'; end if;
    select * into s from public.catalog_external_sources where organization_id = input_org and source_key = v_source_key;
    source_host := (regexp_match(observation->>'sourceUrl','^https://([a-zA-Z0-9.-]+)(?:/|$)'))[1];
    if s.id is null or not s.is_active or s.license_posture not in ('allowed','internal_review_required')
      or s.credential_boundary <> 'none' or s.rate_limit_posture <> 'bounded'
      or s.metadata->>'brand_engine_enrichment_allowed' is distinct from 'true'
      or not (s.metadata->'allowed_brands' ? (j.manifest->>'brand'))
      or source_host is null or not (s.metadata->'allowed_evidence_hosts' ? lower(source_host))
      or observation->>'brand' is distinct from j.manifest->>'brand'
      or observation->>'sourceKey' is distinct from v_source_key then raise exception 'REVIEW_SOURCE_NOT_AUTHORIZED'; end if;
    select * into p from public.catalog_products where id = (observation->'before'->>'id')::uuid
      and organization_id = input_org for update;
    if p.id is null or p.product_code is distinct from observation->>'code'
      or p.brand_id is distinct from (select id from public.brands where organization_id = input_org and name = j.manifest->>'brand')
      or p.ean is distinct from observation->'before'->>'ean' then raise exception 'REVIEW_CATALOG_CHANGED'; end if;
    update public.catalog_products set ean = source_ean, updated_at = now() where id = p.id;
    application_value := jsonb_build_object('status','applied','field','ean','before',p.ean,'after',source_ean,'productId',p.id);
  end if;
  insert into public.catalog_engine_review_decisions
    (organization_id,source_key,review_key,observation_fingerprint,decision,decided_by,application)
  values (input_org,v_source_key,v_review_key,fingerprint,input_decision,input_actor,application_value)
  on conflict (organization_id,source_key,review_key) do update
    set observation_fingerprint = excluded.observation_fingerprint, decision = excluded.decision,
      decided_by = excluded.decided_by, decided_at = now(), application = excluded.application;
  insert into public.catalog_observation_audit_ledger
    (organization_id,actor_id,action,evidence_reference,payload)
  values (input_org,input_actor,'catalog_engine_review_' || input_decision,
    observation->>'sourceUrl',jsonb_build_object('job_id',input_job,'item_index',input_index,
      'receipt_index',input_receipt_index,'source_key',v_source_key,'review_key',v_review_key,
      'fingerprint',fingerprint,'application',application_value));
  return jsonb_build_object('decision',input_decision,'application',application_value,'replayed',false);
end $$;

revoke all on function public.get_catalog_engine_review_queue(uuid,text,text,integer,integer),
  public.decide_catalog_engine_review_item(uuid,uuid,uuid,integer,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.get_catalog_engine_review_queue(uuid,text,text,integer,integer),
  public.decide_catalog_engine_review_item(uuid,uuid,uuid,integer,integer,text,text) to service_role;
select pg_notify('pgrst','reload schema');
