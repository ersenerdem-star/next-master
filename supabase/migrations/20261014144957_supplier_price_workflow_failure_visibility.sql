-- Operational visibility only: never fail, rewind, publish or alter source rows.
CREATE OR REPLACE FUNCTION public.get_supplier_price_workflow_failure_context(input_release_ids uuid[])
RETURNS TABLE(id uuid,handoff_id uuid,workflow_id text,status text,current_cursor bigint,
  processed_rows bigint,error_code text,updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'SUPPLIER_WORKFLOW_OBSERVER_DENIED';
  END IF;
  IF input_release_ids IS NULL OR array_ndims(input_release_ids) IS DISTINCT FROM 1
    OR cardinality(input_release_ids) NOT BETWEEN 1 AND 100
    OR array_position(input_release_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT x) FROM unnest(input_release_ids) x) <> cardinality(input_release_ids) THEN
    RAISE EXCEPTION 'SUPPLIER_WORKFLOW_OBSERVER_INPUT';
  END IF;
  RETURN QUERY
  SELECT r.id,h.id,h.workflow_id,r.status,r.current_cursor,r.processed_rows,r.error_code,r.updated_at
  FROM public.supplier_price_releases r
  JOIN supplier_price_ingestion_internal.handoffs h ON h.release_id=r.id
    AND h.organization_id=r.organization_id
    AND h.workflow_id='supplier-price-verified:v1:'||r.id::text
    AND h.source_path=r.source_file_path AND h.source_sha256=r.source_file_sha256
    AND h.total_rows=r.total_rows
  JOIN public.supplier_price_upload_sessions u ON u.id=h.session_id AND u.release_id=r.id
    AND u.organization_id=r.organization_id AND u.created_by=r.created_by AND u.status='uploaded'
    AND u.storage_bucket=h.storage_bucket AND u.storage_object_path=h.source_path AND u.total_bytes=h.source_bytes
  JOIN storage.objects o ON o.id=h.object_id AND o.bucket_id=h.storage_bucket AND o.name=h.source_path
    AND o.version=h.object_version AND o.updated_at=h.object_updated_at AND o.metadata->>'size'=h.source_bytes::text
  WHERE r.id=ANY(input_release_ids) AND r.source_verification_required AND r.uploaded_at IS NOT NULL
  ORDER BY r.id;
END
$function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_workflow_failure_context(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_workflow_failure_context(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_supplier_price_processing_interrupted(
  input_release_id uuid,input_handoff_id uuid,input_workflow_id text,input_expected_cursor bigint,
  input_expected_updated_at timestamptz,input_failed_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  r public.supplier_price_releases%rowtype;
  c record;
  v_code constant text := 'SUPPLIER_PROCESSING_INTERRUPTED';
  v_message constant text := 'Processing stopped before completion. Operational review is required.';
  v_result jsonb := jsonb_build_object('status','skipped','release_id',input_release_id,'published',false);
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'SUPPLIER_WORKFLOW_OBSERVER_DENIED';
  END IF;
  IF input_release_id IS NULL OR input_handoff_id IS NULL
    OR input_workflow_id IS DISTINCT FROM 'supplier-price-verified:v1:'||input_release_id::text
    OR input_expected_cursor IS NULL OR input_expected_cursor NOT BETWEEN 0 AND 10000000
    OR input_expected_updated_at IS NULL OR NOT isfinite(input_expected_updated_at)
    OR input_failed_at IS NULL OR NOT isfinite(input_failed_at)
    OR input_failed_at>clock_timestamp()+interval '30 seconds' THEN
    RAISE EXCEPTION 'SUPPLIER_WORKFLOW_OBSERVER_INPUT';
  END IF;

  -- Claim, heartbeat and finalization also lock release before batch. Do not wait on a live worker.
  SELECT x.* INTO r FROM public.supplier_price_releases x
    WHERE x.id=input_release_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN v_result; END IF;
  SELECT x.* INTO c FROM public.get_supplier_price_workflow_failure_context(ARRAY[input_release_id]) x;
  IF NOT FOUND OR c.handoff_id IS DISTINCT FROM input_handoff_id
    OR c.workflow_id IS DISTINCT FROM input_workflow_id THEN
    RAISE EXCEPTION 'SUPPLIER_WORKFLOW_OBSERVER_IDENTITY';
  END IF;
  IF r.status NOT IN ('uploaded','parsing','staged','validating')
    OR r.brand_identity_audit->>'review_required'='true' THEN RETURN v_result; END IF;
  -- A retry uses the pre-marker CAS. Do not touch its timestamp or duplicate the audit event.
  IF r.error_code=v_code THEN
    RETURN jsonb_build_object('status','already_marked','release_id',r.id,'published',false);
  END IF;
  IF r.error_code IS NOT NULL OR r.error_message IS NOT NULL OR r.current_cursor IS DISTINCT FROM input_expected_cursor
    OR r.updated_at IS DISTINCT FROM input_expected_updated_at OR r.updated_at>input_failed_at
    OR input_failed_at<r.uploaded_at
    OR EXISTS(SELECT 1 FROM public.supplier_price_release_batches b WHERE b.release_id=r.id
      AND b.status IN ('queued','running','retrying') AND b.lease_expires_at>clock_timestamp()) THEN
    RETURN v_result;
  END IF;
  UPDATE public.supplier_price_releases SET error_code=v_code,error_message=v_message,updated_at=clock_timestamp()
    WHERE supplier_price_releases.id=r.id;
  INSERT INTO public.supplier_price_release_events(release_id,event_type,stage,status,cursor,processed_rows,total_rows,
    worker_version,error_code,error_message)
  VALUES(r.id,'processing_interrupted','processing',r.status,r.current_cursor,r.processed_rows,r.total_rows,
    'workflow-failure-observer-v1',v_code,v_message);
  RETURN jsonb_build_object('status','marked','release_id',r.id,'published',false);
END
$function$;
REVOKE ALL ON FUNCTION public.mark_supplier_price_processing_interrupted(uuid,uuid,text,bigint,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mark_supplier_price_processing_interrupted(uuid,uuid,text,bigint,timestamptz,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress()
RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
BEGIN
  IF OLD.error_code='SUPPLIER_PROCESSING_INTERRUPTED' AND NEW.error_code=OLD.error_code
    AND (NEW.current_cursor>OLD.current_cursor OR NEW.status IN ('validated','published')) THEN
    NEW.error_code := NULL;
    IF NEW.error_message IS NOT DISTINCT FROM OLD.error_message THEN NEW.error_message := NULL; END IF;
    -- Keep an old terminal DBOS failure from marking a recovered release again.
    NEW.updated_at := greatest(NEW.updated_at,clock_timestamp());
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE TRIGGER supplier_price_clear_processing_interrupted_on_progress
  BEFORE UPDATE ON public.supplier_price_releases
  FOR EACH ROW EXECUTE FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress();

-- Same signature and every existing session, token, actor and organization check retained.
CREATE OR REPLACE FUNCTION public.get_supplier_price_upload_status(input_session_id uuid, input_actor_id uuid, input_organization_id uuid, input_auth_session_id uuid, input_token_iat bigint, input_token_exp bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u public.supplier_price_upload_sessions%rowtype; r public.supplier_price_releases%rowtype;
 v supplier_price_ingestion_internal.verification_requests%rowtype; p public.profiles%rowtype;
 s auth.sessions%rowtype; ready boolean;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 if input_actor_id is null or input_organization_id is null or input_auth_session_id is null
  or input_token_iat is null or input_token_exp is null or input_token_iat<=0
  or input_token_iat>extract(epoch from clock_timestamp())+30
  or input_token_exp<=extract(epoch from clock_timestamp()) or input_token_exp<=input_token_iat
  then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into s from auth.sessions a where a.id=input_auth_session_id;
 if not found or s.user_id is distinct from input_actor_id
  or (s.not_after is not null and s.not_after<=clock_timestamp()) then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into p from public.profiles a where a.id=input_actor_id;
 if not found or p.is_active is distinct from true or coalesce(p.role,'') not in ('admin','superadmin')
  or p.organization_id is distinct from input_organization_id
  or (p.session_revoked_at is not null and input_token_iat<=extract(epoch from p.session_revoked_at))
  then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into u from public.supplier_price_upload_sessions a where a.id=input_session_id
  and a.created_by=input_actor_id and a.organization_id=input_organization_id;
 if not found then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into r from public.supplier_price_releases a where a.id=u.release_id
  and a.organization_id=u.organization_id and a.created_by=u.created_by;
 if not found or not r.source_verification_required then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into v from supplier_price_ingestion_internal.verification_requests a where a.session_id=u.id;
 -- Presence/size only permits verification submission; it is NOT hash proof.
 select exists(select 1 from storage.objects o where o.bucket_id=u.storage_bucket and o.name=u.storage_object_path
  and nullif(o.version,'') is not null and o.updated_at is not null
  and o.metadata->>'size'=u.total_bytes::text) into ready;
 return jsonb_build_object('session_id',u.id,'release_id',r.id,'upload_status',u.status,
  'verification_status',coalesce(v.status,'not_requested'),'transfer_ready',ready,
  'total_bytes',u.total_bytes,'total_rows',r.total_rows,'processed_rows',r.processed_rows,
  'release_status',r.status,'expires_at',u.expires_at,'updated_at',coalesce(v.updated_at,u.updated_at),
  'error_code',r.error_code,'release_updated_at',r.updated_at,
  'published',false);
end $function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) TO service_role;
