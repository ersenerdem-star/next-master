-- Explicit admin decisions run on the existing supplier worker, outside HTTP request lifetime.
-- Both targets start CLOSED. Production publisher and the original62 migration history are unchanged.
create table supplier_price_ingestion_internal.admin_release_action_control (
 singleton boolean primary key default true check(singleton),
 expected_project_ref text check(expected_project_ref in ('kaxsqafdevabkxofwdod','zjgueqijumzlfioihnkt')),
 enabled boolean not null default false,
 check(not enabled or expected_project_ref is not null)
);
insert into supplier_price_ingestion_internal.admin_release_action_control(singleton) values(true);
alter table supplier_price_ingestion_internal.admin_release_action_control enable row level security;
revoke all on supplier_price_ingestion_internal.admin_release_action_control from public,anon,authenticated,service_role;
create table supplier_price_ingestion_internal.admin_release_actions (
 decision_id uuid primary key, project_ref text not null,
 organization_id uuid not null, actor_id uuid not null, release_id uuid not null references public.supplier_price_releases(id),
 supplier_id uuid not null, brand_id uuid not null, source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 action text not null check(action in ('review','publish')), request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=20000),
 accepted_auth_session_id uuid not null, accepted_token_iat bigint not null, accepted_token_exp bigint not null,
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 lease_owner uuid, lease_expires_at timestamptz, attempt integer not null default 0 check(attempt between 0 and 3),
 receipt jsonb, error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((status='running')=(lease_owner is not null and lease_expires_at is not null)),
 check((status='completed')=(receipt is not null)),check((status='failed')=(error_code is not null))
);
alter table supplier_price_ingestion_internal.admin_release_actions enable row level security;
revoke all on supplier_price_ingestion_internal.admin_release_actions from public,anon,authenticated,service_role;
create unique index admin_release_actions_one_active on supplier_price_ingestion_internal.admin_release_actions(release_id) where status in ('queued','running');
create index admin_release_actions_dispatch on supplier_price_ingestion_internal.admin_release_actions(project_ref,status,created_at);
create table if not exists supplier_price_ingestion_internal.admin_staging_publication_decisions (
  decision_id uuid primary key,
  release_id uuid not null unique references public.supplier_price_releases(id),
  organization_id uuid not null,
  supplier_id uuid not null,
  brand_id uuid not null,
  actor_id uuid not null,
  review_revision bigint not null check(review_revision >= 0),
  expected_previous_publication_id uuid,
  publication_id uuid not null unique references public.supplier_price_publications(id),
  publication_version bigint not null check(publication_version > 0),
  source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
  identity_audit jsonb not null,
  decided_at timestamptz not null default now()
);
alter table supplier_price_ingestion_internal.admin_staging_publication_decisions enable row level security;
revoke all on supplier_price_ingestion_internal.admin_staging_publication_decisions from public,anon,authenticated,service_role;

create or replace function supplier_price_ingestion_internal.admin_publish_staging(
  input_project_ref text,
  input_release_id uuid,
  input_organization_id uuid,
  input_supplier_id uuid,
  input_brand_id uuid,
  input_actor_id uuid,
  input_decision_id uuid,
  input_expected_review_revision bigint,
  input_expected_previous_publication_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_current public.supplier_current_price_pointers%rowtype;
  v_previous public.supplier_price_publications%rowtype;
  v_publication public.supplier_price_publications%rowtype;
  v_decision supplier_price_ingestion_internal.admin_staging_publication_decisions%rowtype;
  v_actor_org uuid;
  v_actor_role text;
  v_actor_active boolean;
  v_version bigint;
  v_identity jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'PRODUCTION_PUBLICATION_SERVICE_REQUIRED'; end if;
  if input_project_ref is distinct from 'kaxsqafdevabkxofwdod' then raise exception 'PRODUCTION_PUBLICATION_NOT_ENABLED'; end if;
  perform 1 from supplier_price_ingestion_internal.admin_release_action_control c
    where c.singleton and c.enabled and c.expected_project_ref=input_project_ref for share;
  if not found then raise exception 'PRODUCTION_PUBLICATION_NOT_ENABLED'; end if;
  if input_release_id is null or input_organization_id is null or input_supplier_id is null
    or input_brand_id is null or input_actor_id is null or input_decision_id is null
    or input_expected_review_revision is null or input_expected_review_revision < 0
    then raise exception 'PRODUCTION_PUBLICATION_INPUT_REQUIRED'; end if;
  if current_setting('transaction_isolation') <> 'read committed'
    then raise exception 'PRODUCTION_PUBLICATION_REQUIRES_READ_COMMITTED'; end if;

  -- Share the existing publication/identity lock domains. Acquire identity
  -- before the release row, matching review/check_publication_identity order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-production-decision:'||input_decision_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-publication:'||input_organization_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-identity:'||input_organization_id::text,0));
  select p.organization_id,lower(p.role::text),p.is_active into v_actor_org,v_actor_role,v_actor_active
    from public.profiles p where p.id=input_actor_id for share;
  if not found or v_actor_org is distinct from input_organization_id or v_actor_active is distinct from true
    or coalesce(v_actor_role,'') not in ('admin','superadmin')
    then raise exception 'PRODUCTION_PUBLICATION_ACTOR_INVALID'; end if;

  select d.* into v_decision from supplier_price_ingestion_internal.admin_staging_publication_decisions d
    where d.decision_id=input_decision_id;
  if found then
    if v_decision.release_id is distinct from input_release_id
      or v_decision.organization_id is distinct from input_organization_id
      or v_decision.supplier_id is distinct from input_supplier_id or v_decision.brand_id is distinct from input_brand_id
      or v_decision.actor_id is distinct from input_actor_id
      or v_decision.review_revision is distinct from input_expected_review_revision
      or v_decision.expected_previous_publication_id is distinct from input_expected_previous_publication_id
      then raise exception 'PRODUCTION_PUBLICATION_DECISION_CONFLICT'; end if;
    -- Replay the historical receipt, including after supersession. Never move
    -- a newer pointer backwards or substitute a new caller's decision UUID.
    return jsonb_build_object('status','published','release_id',v_decision.release_id,
      'publication_id',v_decision.publication_id,'version',v_decision.publication_version,
      'actor_id',v_decision.actor_id,'decision_id',v_decision.decision_id,'review_revision',v_decision.review_revision,
      'expected_previous_publication_id',v_decision.expected_previous_publication_id,
      'is_current',exists(select 1 from public.supplier_current_price_pointers p
        where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id
          and p.publication_id=v_decision.publication_id and p.release_id=v_decision.release_id),
      'replayed',true,'published',true);
  end if;

  select r.* into v_release from public.supplier_price_releases r where r.id=input_release_id for update;
  if not found or v_release.organization_id is distinct from input_organization_id
    or v_release.supplier_id is distinct from input_supplier_id or v_release.brand_id is distinct from input_brand_id
    then raise exception 'PRODUCTION_PUBLICATION_SCOPE_MISMATCH'; end if;
  if v_release.review_revision is distinct from input_expected_review_revision
    then raise exception 'PRODUCTION_PUBLICATION_STALE_REVIEW'; end if;
  -- A pointer represents a complete supplier/brand snapshot. A merge release
  -- contains only changed rows and cannot safely replace that snapshot.
  if v_release.mode is distinct from 'replace'
    then raise exception 'PRODUCTION_PUBLICATION_REPLACE_REQUIRED'; end if;
  if v_release.status is distinct from 'validated' or v_release.validated_at is null
    then raise exception 'PRODUCTION_PUBLICATION_RELEASE_NOT_VALIDATED'; end if;
  if v_release.error_code is not null or v_release.total_rows is null or v_release.total_rows <= 0
    or coalesce(v_release.accepted_rows,0) <> v_release.total_rows
    or coalesce(v_release.processed_rows,0) <> v_release.total_rows
    or coalesce(v_release.current_cursor,0) <> v_release.total_rows
    or coalesce(v_release.rejected_rows,0) <> 0 or coalesce(v_release.warning_rows,0) <> 0
    or coalesce(v_release.conflict_rows,0) <> 0
    or v_release.source_verification_required is distinct from true or v_release.uploaded_at is null
    or v_release.source_file_path is null or btrim(v_release.source_file_path)=''
    or v_release.source_file_sha256 is null or v_release.source_file_sha256 !~ '^[0-9a-f]{64}$'
    then raise exception 'PRODUCTION_PUBLICATION_VALIDATION_NOT_CLEAR'; end if;
  if exists(select 1 from public.supplier_price_publications p where p.release_id=input_release_id)
    then raise exception 'PRODUCTION_PUBLICATION_RELEASE_ALREADY_RECORDED'; end if;

  select p.* into v_current from public.supplier_current_price_pointers p
    where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id for update;
  if v_current.publication_id is distinct from input_expected_previous_publication_id
    then raise exception 'PRODUCTION_PUBLICATION_STALE_POINTER'; end if;
  if v_current.publication_id is not null then
    select p.* into v_previous from public.supplier_price_publications p where p.id=v_current.publication_id for update;
    if not found or v_previous.status is distinct from 'published'
      or v_previous.organization_id is distinct from input_organization_id
      or v_previous.supplier_id is distinct from input_supplier_id or v_previous.brand_id is distinct from input_brand_id
      or v_previous.release_id is distinct from v_current.release_id
      then raise exception 'PRODUCTION_PUBLICATION_CURRENT_POINTER_INVALID'; end if;
  end if;

  -- Refresh current cross-brand evidence inside the locked transaction. A
  -- previously checked JSON audit is not permission to publish changed data.
  v_identity:=supplier_price_validation_internal.check_publication_identity(
    input_release_id,input_organization_id,input_supplier_id,input_brand_id);
  if v_identity->'publication_allowed' is distinct from 'true'::jsonb
    or v_identity->>'status' is distinct from 'identity_checked' then
    return jsonb_build_object('status','review_required','release_id',input_release_id,
      'decision_id',input_decision_id,'error_code',v_identity->>'error_code','replayed',false,'published',false);
  end if;
  v_identity:=v_identity->'brand_identity_audit';
  if v_identity->>'policy' is distinct from 'cross-brand-v1'
    or v_identity->'checked' is distinct from 'true'::jsonb
    or v_identity->'review_required' is distinct from 'false'::jsonb
    then raise exception 'PRODUCTION_PUBLICATION_IDENTITY_NOT_CLEAR'; end if;

  select coalesce(max(p.publication_version),0)+1 into v_version from public.supplier_price_publications p
    where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id;
  insert into public.supplier_price_publications(release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)
    values(input_release_id,input_organization_id,input_supplier_id,input_brand_id,'published',v_version,now()) returning * into v_publication;
  if v_current.publication_id is not null then
    update public.supplier_price_publications set status='superseded',superseded_at=now() where id=v_current.publication_id;
  end if;
  insert into public.supplier_current_price_pointers(organization_id,supplier_id,brand_id,publication_id,release_id,updated_at)
    values(input_organization_id,input_supplier_id,input_brand_id,v_publication.id,input_release_id,now())
    on conflict(organization_id,supplier_id,brand_id) do update set
      publication_id=excluded.publication_id,release_id=excluded.release_id,updated_at=now();
  update public.supplier_price_releases set status='published',published_at=now(),updated_at=now(),error_code=null,error_message=null where id=input_release_id;
  insert into supplier_price_ingestion_internal.admin_staging_publication_decisions(
    decision_id,release_id,organization_id,supplier_id,brand_id,actor_id,review_revision,
    expected_previous_publication_id,publication_id,publication_version,source_sha256,identity_audit)
    values(input_decision_id,input_release_id,input_organization_id,input_supplier_id,input_brand_id,input_actor_id,
      input_expected_review_revision,input_expected_previous_publication_id,v_publication.id,v_version,v_release.source_file_sha256,v_identity);
  insert into public.supplier_price_release_events(release_id,event_type,stage,status,total_rows,worker_version,error_message)
    values(input_release_id,'admin_staging_published','publication','completed',v_release.total_rows,
      'admin-staging-publication-v1','Staging admin publication decision '||input_decision_id::text);
  return jsonb_build_object('status','published','release_id',input_release_id,'publication_id',v_publication.id,
    'version',v_version,'actor_id',input_actor_id,'decision_id',input_decision_id,'review_revision',input_expected_review_revision,
    'expected_previous_publication_id',input_expected_previous_publication_id,'is_current',true,'replayed',false,'published',true);
end;
$function$;

create function supplier_price_ingestion_internal.admin_action_target(input_project_ref text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'ACTION_SERVICE_REQUIRED';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'ACTION_ISOLATION_REQUIRED';end if;
 perform 1 from supplier_price_ingestion_internal.admin_release_action_control where singleton and enabled and expected_project_ref=input_project_ref for share;
 if not found then raise exception 'ACTION_NOT_ENABLED';end if;
end $$;
create function supplier_price_ingestion_internal.admin_action_session(input_actor_id uuid,input_organization_id uuid,input_auth_session_id uuid,input_token_iat bigint,input_token_exp bigint)
returns void language plpgsql security definer set search_path='' as $$
declare s auth.sessions%rowtype;p public.profiles%rowtype;
begin
 if input_actor_id is null or input_organization_id is null or input_auth_session_id is null or input_token_iat is null or input_token_exp is null
  or input_token_iat<=0 or input_token_iat>extract(epoch from clock_timestamp())+30 or input_token_exp<=input_token_iat or input_token_exp<=extract(epoch from clock_timestamp()) then raise exception 'ACTION_SESSION_DENIED';end if;
 select * into s from auth.sessions where id=input_auth_session_id for share;
 if not found or s.user_id is distinct from input_actor_id or (s.not_after is not null and s.not_after<=clock_timestamp()) then raise exception 'ACTION_SESSION_DENIED';end if;
 select * into p from public.profiles where id=input_actor_id for share;
 if not found or p.is_active is distinct from true or p.organization_id is distinct from input_organization_id or coalesce(p.role,'') not in ('admin','superadmin') then raise exception 'ACTION_ACTOR_DENIED';end if;
 if p.session_revoked_at is not null and input_token_iat<=extract(epoch from p.session_revoked_at) then raise exception 'ACTION_SESSION_DENIED';end if;
end $$;
create function supplier_price_ingestion_internal.admin_action_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'ACTION_IMMUTABLE';end if;
 if tg_table_name='admin_staging_publication_decisions' then raise exception 'ACTION_IMMUTABLE';end if;
 if (to_jsonb(new)-array['status','lease_owner','lease_expires_at','attempt','receipt','error_code','updated_at']) is distinct from
    (to_jsonb(old)-array['status','lease_owner','lease_expires_at','attempt','receipt','error_code','updated_at']) or old.status in ('completed','failed') then raise exception 'ACTION_IMMUTABLE';end if;
 return new;
end $$;
create trigger admin_release_actions_immutable before update or delete on supplier_price_ingestion_internal.admin_release_actions for each row execute function supplier_price_ingestion_internal.admin_action_immutable();
create trigger admin_staging_decisions_immutable before update or delete on supplier_price_ingestion_internal.admin_staging_publication_decisions for each row execute function supplier_price_ingestion_internal.admin_action_immutable();
create function supplier_price_ingestion_internal.admin_action_receipt(a supplier_price_ingestion_internal.admin_release_actions,input_replayed boolean)
returns jsonb language sql set search_path='' as $$
 select case when a.status='completed' then a.receipt||jsonb_build_object('replayed',input_replayed)||case when a.receipt->'published'='true'::jsonb then jsonb_build_object('isCurrent',exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=a.organization_id and p.release_id=a.release_id and p.publication_id=(a.receipt->>'publicationId')::uuid)) else '{}'::jsonb end
 else jsonb_build_object('releaseId',a.release_id,'decisionId',a.decision_id,'action',case when a.action='review' then a.request->>'action' else 'publish' end,'status',a.status,'errorCode',a.error_code,'published',false,'replayed',input_replayed) end;
$$;
create function supplier_price_ingestion_internal.admin_action_source_verified(input_release_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.supplier_price_releases r join supplier_price_ingestion_internal.handoffs h on h.release_id=r.id
 join public.supplier_price_upload_sessions u on u.id=h.session_id and u.release_id=r.id
 where r.id=input_release_id and r.source_verification_required and r.uploaded_at is not null
 and r.source_file_sha256 ~ '^[a-f0-9]{64}$' and h.source_sha256=r.source_file_sha256 and h.source_path=r.source_file_path
 and h.organization_id=r.organization_id and u.organization_id=r.organization_id and u.status='uploaded'
 and h.storage_bucket='supplier-price-imports' and u.storage_object_path=r.source_file_path
 and u.total_bytes=h.source_bytes and u.uploaded_bytes=u.total_bytes
 and h.workflow_id='supplier-price-verified:v1:'||r.id::text);
$$;
create function public.get_supplier_release_action_evidence(input_project_ref text,input_actor_id uuid,input_organization_id uuid,input_auth_session_id uuid,input_token_iat bigint,input_token_exp bigint,input_release_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare r public.supplier_price_releases%rowtype;p public.supplier_current_price_pointers%rowtype;v boolean;busy boolean;publication_enabled boolean:=false;review_op jsonb;publish_op jsonb;
begin
 perform supplier_price_ingestion_internal.admin_action_target(input_project_ref);
 perform supplier_price_ingestion_internal.admin_action_session(input_actor_id,input_organization_id,input_auth_session_id,input_token_iat,input_token_exp);
 select * into r from public.supplier_price_releases where id=input_release_id and organization_id=input_organization_id;
 if not found then raise exception 'ACTION_SCOPE_DENIED';end if;
 if octet_length(r.brand_identity_audit::text)>16384 then raise exception 'ACTION_EVIDENCE_TOO_LARGE';end if;
 select * into p from public.supplier_current_price_pointers where organization_id=r.organization_id and supplier_id=r.supplier_id and brand_id=r.brand_id;
 v:=supplier_price_ingestion_internal.admin_action_source_verified(r.id);
 -- Release readiness is insufficient while the independently governed production
 -- publication switch is closed. V3 has no dependency on production-only tables.
 if input_project_ref='kaxsqafdevabkxofwdod' then
  publication_enabled:=true;
 elsif input_project_ref='zjgueqijumzlfioihnkt' and to_regclass('supplier_price_ingestion_internal.production_publication_control') is not null then
  select exists(select 1 from supplier_price_ingestion_internal.production_publication_control c
   where c.singleton and c.enabled and c.expected_project_ref=input_project_ref) into publication_enabled;
 end if;
 select exists(select 1 from supplier_price_ingestion_internal.admin_release_actions a where a.release_id=r.id and a.status in ('queued','running')) into busy;
 select jsonb_build_object('decisionId',a.decision_id,'status',a.status,'receipt',case when a.receipt is not null then supplier_price_ingestion_internal.admin_action_receipt(a,true) else null end,'errorCode',a.error_code) into review_op from supplier_price_ingestion_internal.admin_release_actions a where a.release_id=r.id and a.actor_id=input_actor_id and a.action='review' order by a.created_at desc,a.decision_id desc limit 1;
 select jsonb_build_object('decisionId',a.decision_id,'status',a.status,'receipt',case when a.receipt is not null then supplier_price_ingestion_internal.admin_action_receipt(a,true) else null end,'errorCode',a.error_code) into publish_op from supplier_price_ingestion_internal.admin_release_actions a where a.release_id=r.id and a.actor_id=input_actor_id and a.action='publish' order by a.created_at desc,a.decision_id desc limit 1;
 return jsonb_build_object('actorId',input_actor_id,'organizationId',r.organization_id,'releaseId',r.id,'supplierId',r.supplier_id,'brandId',r.brand_id,
 'supplier',(select name from public.suppliers where id=r.supplier_id and organization_id=r.organization_id),'brand',(select name from public.brands where id=r.brand_id and organization_id=r.organization_id),
 'mode',r.mode,'status',r.status,'reviewRevision',r.review_revision,'errorCode',r.error_code,'brandIdentityAudit',r.brand_identity_audit,
 'totalRows',coalesce(r.total_rows,0),'processedRows',coalesce(r.processed_rows,0),'acceptedRows',coalesce(r.accepted_rows,0),'rejectedRows',coalesce(r.rejected_rows,0),'warningRows',coalesce(r.warning_rows,0),'conflictRows',coalesce(r.conflict_rows,0),
 'sourceVerified',v,'currentPublicationId',p.publication_id,'currentReleaseId',p.release_id,'currentPublicationVersion',(select publication_version from public.supplier_price_publications where id=p.publication_id),'isCurrent',coalesce(p.release_id=r.id,false),
 'canReview',coalesce(v and not busy and r.status in ('staged','validated') and (r.error_code is not null or coalesce(r.brand_identity_audit->>'review_required','false')='true'),false),
 'canPublish',coalesce(publication_enabled and v and not busy and r.status='validated' and r.mode='replace' and r.error_code is null and r.total_rows>0 and r.accepted_rows=r.total_rows and r.current_cursor=r.total_rows and r.processed_rows=r.total_rows and r.rejected_rows=0 and r.warning_rows=0 and r.conflict_rows=0 and coalesce(r.brand_identity_audit->>'checked','false')='true' and coalesce(r.brand_identity_audit->>'review_required','true')='false',false),
 'reviewOperation',review_op,'publishOperation',publish_op);
end $$;
create function public.request_supplier_release_action(input_project_ref text,input_actor_id uuid,input_organization_id uuid,input_auth_session_id uuid,input_token_iat bigint,input_token_exp bigint,input_action text,input_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare r public.supplier_price_releases%rowtype;a supplier_price_ingestion_internal.admin_release_actions%rowtype;decision uuid;release uuid;expected bigint;keys text[];
begin
 perform supplier_price_ingestion_internal.admin_action_target(input_project_ref);
 perform supplier_price_ingestion_internal.admin_action_session(input_actor_id,input_organization_id,input_auth_session_id,input_token_iat,input_token_exp);
 if input_action is null or input_action not in ('review','publish') or jsonb_typeof(input_request) is distinct from 'object' or octet_length(input_request::text)>20000 then raise exception 'ACTION_INPUT_INVALID';end if;
 select array_agg(k order by k collate "C") into keys from jsonb_object_keys(input_request)k;
 if (input_action='review' and keys<>array['action','decisionId','expectedAudit','expectedError','expectedRevision','expectedStatus','reason','releaseId'])
 or (input_action='publish' and keys<>array['decisionId','expectedPreviousPublicationId','expectedReviewRevision','releaseId']) then raise exception 'ACTION_INPUT_INVALID';end if;
 begin
  if jsonb_typeof(input_request->'decisionId')<>'string' or jsonb_typeof(input_request->'releaseId')<>'string' then raise invalid_text_representation;end if;
  decision:=(input_request->>'decisionId')::uuid;release:=(input_request->>'releaseId')::uuid;
  if jsonb_typeof(input_request->(case when input_action='review' then 'expectedRevision' else 'expectedReviewRevision' end)) is distinct from 'number' or (input_request->>case when input_action='review' then 'expectedRevision' else 'expectedReviewRevision' end) !~ '^(0|[1-9][0-9]*)$' then raise invalid_text_representation;end if;
  expected:=(input_request->>case when input_action='review' then 'expectedRevision' else 'expectedReviewRevision' end)::bigint;
 exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'ACTION_INPUT_INVALID';end;
 if decision is null or release is null or expected is null then raise exception 'ACTION_INPUT_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended('supplier-admin-action:'||decision::text,0));
 select * into a from supplier_price_ingestion_internal.admin_release_actions where decision_id=decision;
 if found then
  if a.project_ref is distinct from input_project_ref or a.actor_id is distinct from input_actor_id or a.organization_id is distinct from input_organization_id or a.action is distinct from input_action or a.request is distinct from input_request then raise exception 'ACTION_DECISION_CONFLICT';end if;
  return supplier_price_ingestion_internal.admin_action_receipt(a,true);
 end if;
 select * into r from public.supplier_price_releases where id=release and organization_id=input_organization_id;
 if not found then raise exception 'ACTION_SCOPE_DENIED';end if;
 if not supplier_price_ingestion_internal.admin_action_source_verified(release) then raise exception 'ACTION_SOURCE_REQUIRED';end if;
 if r.review_revision<>expected then raise exception 'ACTION_STALE_EVIDENCE';end if;
 if input_action='review' then
  if input_request->>'action' is null or input_request->>'action' not in ('recheck','reject') or input_request->>'reason' is null
   or (input_request->>'action'='recheck' and input_request->>'reason'<>'comparison_repaired')
   or (input_request->>'action'='reject' and input_request->>'reason' not in ('wrong_brand_file','wrong_source_file'))
   or r.status is distinct from input_request->>'expectedStatus' or r.error_code is distinct from input_request->>'expectedError'
   or r.brand_identity_audit is distinct from nullif(input_request->'expectedAudit','null'::jsonb) or octet_length((input_request->'expectedAudit')::text)>16384 then raise exception 'ACTION_STALE_EVIDENCE';end if;
  if r.status not in ('staged','validated') or (r.error_code is null and coalesce(r.brand_identity_audit->>'review_required','false')<>'true') then raise exception 'ACTION_STATE_DENIED';end if;
 else
  if r.status<>'validated' or r.mode<>'replace' or r.error_code is not null then raise exception 'ACTION_STATE_DENIED';end if;
  if jsonb_typeof(input_request->'expectedPreviousPublicationId') not in ('null','string') then raise exception 'ACTION_INPUT_INVALID';end if;
  if (select publication_id from public.supplier_current_price_pointers where organization_id=r.organization_id and supplier_id=r.supplier_id and brand_id=r.brand_id) is distinct from (input_request->>'expectedPreviousPublicationId')::uuid then raise exception 'ACTION_STALE_POINTER';end if;
 end if;
 begin
 insert into supplier_price_ingestion_internal.admin_release_actions(decision_id,project_ref,organization_id,actor_id,release_id,supplier_id,brand_id,source_sha256,action,request,accepted_auth_session_id,accepted_token_iat,accepted_token_exp)
 values(decision,input_project_ref,input_organization_id,input_actor_id,release,r.supplier_id,r.brand_id,r.source_file_sha256,input_action,input_request,input_auth_session_id,input_token_iat,input_token_exp) returning * into a;
 exception when unique_violation then raise exception 'ACTION_ALREADY_PENDING';end;
 return supplier_price_ingestion_internal.admin_action_receipt(a,false);
end $$;
create function public.claim_supplier_release_action(input_project_ref text,input_lease_owner uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare a supplier_price_ingestion_internal.admin_release_actions%rowtype;
begin
 perform supplier_price_ingestion_internal.admin_action_target(input_project_ref);
 if input_lease_owner is null then raise exception 'ACTION_INPUT_INVALID';end if;
 select * into a from supplier_price_ingestion_internal.admin_release_actions where project_ref=input_project_ref and (status='queued' or (status='running' and lease_expires_at<=clock_timestamp())) order by created_at,decision_id limit 1 for update skip locked;
 if not found then return jsonb_build_object('status','empty');end if;
 if a.attempt>=3 then update supplier_price_ingestion_internal.admin_release_actions set status='failed',error_code='ACTION_RETRY_EXHAUSTED',lease_owner=null,lease_expires_at=null,updated_at=now() where decision_id=a.decision_id;return jsonb_build_object('status','empty');end if;
 update supplier_price_ingestion_internal.admin_release_actions set status='running',lease_owner=input_lease_owner,lease_expires_at=clock_timestamp()+interval '120 seconds',attempt=attempt+1,updated_at=now() where decision_id=a.decision_id;
 return jsonb_build_object('status','claimed','decision_id',a.decision_id,'release_id',a.release_id,'action',a.action,'lease_owner',input_lease_owner);
end $$;
create function public.execute_supplier_release_action(input_project_ref text,input_decision_id uuid,input_lease_owner uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='55s' as $$
declare a supplier_price_ingestion_internal.admin_release_actions%rowtype;r public.supplier_price_releases%rowtype;result jsonb;v_receipt jsonb;
begin
 perform supplier_price_ingestion_internal.admin_action_target(input_project_ref);
 select * into a from supplier_price_ingestion_internal.admin_release_actions where decision_id=input_decision_id and project_ref=input_project_ref;
 if not found then raise exception 'ACTION_MISSING';end if;
 if a.status in ('completed','failed') then return supplier_price_ingestion_internal.admin_action_receipt(a,true);end if;
 perform supplier_price_ingestion_internal.admin_action_session(a.actor_id,a.organization_id,a.accepted_auth_session_id,a.accepted_token_iat,a.accepted_token_exp);
 if a.action='publish' then perform pg_advisory_xact_lock(hashtextextended('supplier-price-production-decision:'||a.decision_id::text,0));end if;
 -- Same order as the unchanged trusted production publisher; queue lock is held until domain mutation AND receipt commit.
 perform pg_advisory_xact_lock(hashtextextended('supplier-price-publication:'||a.organization_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('supplier-price-identity:'||a.organization_id::text,0));
 select * into a from supplier_price_ingestion_internal.admin_release_actions where decision_id=input_decision_id for update;
 if a.status in ('completed','failed') then return supplier_price_ingestion_internal.admin_action_receipt(a,true);end if;
 if a.status<>'running' or input_lease_owner is null or a.lease_owner is distinct from input_lease_owner or a.lease_expires_at<=clock_timestamp() then raise exception 'ACTION_STALE_LEASE';end if;
 select * into r from public.supplier_price_releases where id=a.release_id and organization_id=a.organization_id;
 if not found or r.supplier_id is distinct from a.supplier_id or r.brand_id is distinct from a.brand_id then raise exception 'ACTION_SCOPE_DENIED';end if;
 if r.source_file_sha256 is distinct from a.source_sha256 or not supplier_price_ingestion_internal.admin_action_source_verified(r.id) then raise exception 'ACTION_SOURCE_REQUIRED';end if;
 if a.action='review' then
  result:=supplier_price_validation_internal.review_release(a.decision_id,a.actor_id,a.organization_id,a.release_id,a.request->>'action',a.request->>'reason',(a.request->>'expectedRevision')::bigint,a.request->>'expectedStatus',a.request->>'expectedError',nullif(a.request->'expectedAudit','null'::jsonb));
  v_receipt:=jsonb_build_object('releaseId',a.release_id,'decisionId',a.decision_id,'action',a.request->>'action','status',result->>'status','reviewRevision',result->'review_revision','errorCode',result->'error_code','published',false,'replayed',false);
 else
  if input_project_ref='zjgueqijumzlfioihnkt' then
   result:=public.publish_supplier_price_release_production(input_project_ref,a.release_id,a.organization_id,r.supplier_id,r.brand_id,a.actor_id,a.decision_id,(a.request->>'expectedReviewRevision')::bigint,(a.request->>'expectedPreviousPublicationId')::uuid);
  elsif input_project_ref='kaxsqafdevabkxofwdod' then
   result:=supplier_price_ingestion_internal.admin_publish_staging(input_project_ref,a.release_id,a.organization_id,r.supplier_id,r.brand_id,a.actor_id,a.decision_id,(a.request->>'expectedReviewRevision')::bigint,(a.request->>'expectedPreviousPublicationId')::uuid);
  else raise exception 'ACTION_NOT_ENABLED';end if;
  v_receipt:=jsonb_build_object('releaseId',a.release_id,'decisionId',a.decision_id,'status',result->>'status','published',coalesce((result->>'published')::boolean,false),'replayed',false);
  if result->>'status'='published' then v_receipt:=v_receipt||jsonb_build_object('publicationId',result->'publication_id','version',result->'version','reviewRevision',result->'review_revision','expectedPreviousPublicationId',result->'expected_previous_publication_id','isCurrent',result->'is_current');
  else v_receipt:=v_receipt||jsonb_build_object('errorCode',result->'error_code');end if;
 end if;
 perform supplier_price_ingestion_internal.admin_action_session(a.actor_id,a.organization_id,a.accepted_auth_session_id,a.accepted_token_iat,a.accepted_token_exp);
 if a.lease_expires_at<=clock_timestamp() then raise exception 'ACTION_STALE_LEASE';end if;
 update supplier_price_ingestion_internal.admin_release_actions set status='completed',receipt=v_receipt,lease_owner=null,lease_expires_at=null,updated_at=now() where decision_id=a.decision_id;
 return v_receipt;
end $$;
create function public.fail_supplier_release_action(input_project_ref text,input_decision_id uuid,input_lease_owner uuid,input_error_code text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare a supplier_price_ingestion_internal.admin_release_actions%rowtype;
begin
 perform supplier_price_ingestion_internal.admin_action_target(input_project_ref);
 if input_error_code is null or input_error_code not in ('ACTION_EXECUTION_FAILED','ACTION_EXECUTION_TIMEOUT','ACTION_RETRY_EXHAUSTED') then raise exception 'ACTION_INPUT_INVALID';end if;
 select * into a from supplier_price_ingestion_internal.admin_release_actions where decision_id=input_decision_id and project_ref=input_project_ref for update;
 if not found then raise exception 'ACTION_MISSING';end if;
 if a.status in ('completed','failed') then return supplier_price_ingestion_internal.admin_action_receipt(a,true);end if;
 if a.status<>'running' or input_lease_owner is null or a.lease_owner is distinct from input_lease_owner or a.lease_expires_at<=clock_timestamp() then raise exception 'ACTION_STALE_LEASE';end if;
 update supplier_price_ingestion_internal.admin_release_actions set status='failed',error_code=input_error_code,lease_owner=null,lease_expires_at=null,updated_at=now() where decision_id=a.decision_id returning * into a;
 return supplier_price_ingestion_internal.admin_action_receipt(a,false);
end $$;
-- Private helpers have no API role grants; only fixed service wrappers are callable.
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='supplier_price_ingestion_internal'::regnamespace and proname in ('admin_publish_staging','admin_action_target','admin_action_session','admin_action_immutable','admin_action_receipt','admin_action_source_verified') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);end loop;
 for p in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('get_supplier_release_action_evidence','request_supplier_release_action','claim_supplier_release_action','execute_supplier_release_action','fail_supplier_release_action') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);execute format('grant execute on function %s to service_role',p.signature);end loop;
end $$;
