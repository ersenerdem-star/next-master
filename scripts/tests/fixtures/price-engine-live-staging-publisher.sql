CREATE OR REPLACE FUNCTION supplier_price_ingestion_internal.admin_publish_staging(input_project_ref text, input_release_id uuid, input_organization_id uuid, input_supplier_id uuid, input_brand_id uuid, input_actor_id uuid, input_decision_id uuid, input_expected_review_revision bigint, input_expected_previous_publication_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if coalesce(v_identity->>'policy','') not in ('cross-brand-v1','cross-brand-v2','cross-brand-v3')
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
$function$
