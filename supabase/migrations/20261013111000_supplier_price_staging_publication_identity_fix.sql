-- Staging-only explicit publication path. This RPC is service-role only and
-- writes only the staging project's release/publication pointer tables.
create or replace function public.publish_supplier_price_release_staging(
  input_release_id uuid,
  input_organization_id uuid,
  input_supplier_id uuid,
  input_brand_id uuid,
  input_decision_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_current public.supplier_current_price_pointers%rowtype;
  v_publication public.supplier_price_publications%rowtype;
  v_version bigint;
  v_identity jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'STAGING_PUBLICATION_SERVICE_REQUIRED';
  end if;
  if input_release_id is null or input_organization_id is null or input_supplier_id is null
     or input_brand_id is null or input_decision_id is null then
    raise exception 'STAGING_PUBLICATION_INPUT_REQUIRED';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'STAGING_PUBLICATION_REQUIRES_READ_COMMITTED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('supplier-price-publication:' || input_organization_id::text, 0));
  select r.* into v_release
    from public.supplier_price_releases r
    where r.id = input_release_id
    for update;
  if not found or v_release.organization_id is distinct from input_organization_id
     or v_release.supplier_id is distinct from input_supplier_id
     or v_release.brand_id is distinct from input_brand_id then
    raise exception 'STAGING_PUBLICATION_SCOPE_MISMATCH';
  end if;
  if v_release.status not in ('validated','published') then
    raise exception 'STAGING_PUBLICATION_RELEASE_NOT_VALIDATED';
  end if;
  if v_release.error_code is not null
     or coalesce(v_release.accepted_rows,0) <> v_release.total_rows
     or coalesce(v_release.rejected_rows,0) <> 0
     or coalesce(v_release.warning_rows,0) <> 0
     or coalesce(v_release.conflict_rows,0) <> 0 then
    raise exception 'STAGING_PUBLICATION_VALIDATION_NOT_CLEAR';
  end if;
  v_identity := v_release.brand_identity_audit;
  if coalesce(v_identity->>'policy','') <> 'cross-brand-v1'
     or not coalesce((v_identity->>'checked')::boolean,false)
     or coalesce((v_identity->>'review_required')::boolean,true) then
    raise exception 'STAGING_PUBLICATION_IDENTITY_NOT_CLEAR';
  end if;
  select p.* into v_publication
    from public.supplier_price_publications p
    where p.release_id = input_release_id;
  if found then
    if v_publication.status = 'published' then
      return jsonb_build_object('status','published','release_id',input_release_id,
        'publication_id',v_publication.id,'version',v_publication.publication_version,
        'decision_id',input_decision_id,'replayed',true,'published',true);
    end if;
    raise exception 'STAGING_PUBLICATION_RELEASE_ALREADY_RECORDED';
  end if;
  select p.* into v_current
    from public.supplier_current_price_pointers p
    where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id
    for update;
  select coalesce(max(p.publication_version),0)+1 into v_version
    from public.supplier_price_publications p
    where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id;
  insert into public.supplier_price_publications(
    release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)
    values(input_release_id,input_organization_id,input_supplier_id,input_brand_id,'published',v_version,now())
    returning * into v_publication;
  if found and v_current.publication_id is not null then
    update public.supplier_price_publications
      set status='superseded',superseded_at=now()
      where id=v_current.publication_id and status='published';
  end if;
  insert into public.supplier_current_price_pointers(
    organization_id,supplier_id,brand_id,publication_id,release_id,updated_at)
    values(input_organization_id,input_supplier_id,input_brand_id,v_publication.id,input_release_id,now())
    on conflict (organization_id,supplier_id,brand_id) do update set
      publication_id=excluded.publication_id,release_id=excluded.release_id,updated_at=now();
  update public.supplier_price_releases
    set status='published',published_at=now(),updated_at=now(),error_code=null,error_message=null
    where id=input_release_id;
  insert into public.supplier_price_release_events
    (release_id,event_type,stage,status,total_rows,worker_version,error_message)
    values(input_release_id,'staging_published','publication','completed',v_release.total_rows,
      'staging-publication-v1','Explicit staging publication decision ' || input_decision_id::text);
  return jsonb_build_object('status','published','release_id',input_release_id,
    'publication_id',v_publication.id,'version',v_version,'decision_id',input_decision_id,
    'replayed',false,'published',true);
end;
$function$;
revoke all on function public.publish_supplier_price_release_staging(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.publish_supplier_price_release_staging(uuid,uuid,uuid,uuid,uuid) to service_role;
