-- Allow a new verified supplier upload after a previous attempt was stopped.
-- A failed/interrupted source remains in history, but must not reserve the
-- checksum forever and block the next complete replacement file.

UPDATE public.supplier_price_releases
SET status = 'failed',
    updated_at = clock_timestamp()
WHERE error_code = 'SUPPLIER_PROCESSING_INTERRUPTED'
  AND published_at IS NULL
  AND status IN ('received','uploaded','parsing','staged','validating','publishing','catalog_enriching','rollup_refreshing');

DROP INDEX IF EXISTS public.uq_supplier_price_releases_idempotency;
CREATE UNIQUE INDEX uq_supplier_price_releases_idempotency
  ON public.supplier_price_releases (organization_id, supplier_id, brand_id, source_file_sha256, mode)
  WHERE status NOT IN ('failed','cancelled','superseded','archived');

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
    OR input_failed_at > clock_timestamp()+interval '30 seconds' THEN
    RAISE EXCEPTION 'SUPPLIER_WORKFLOW_OBSERVER_INPUT';
  END IF;

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
  UPDATE public.supplier_price_releases
  SET status='failed', error_code=v_code, error_message=v_message, updated_at=clock_timestamp()
  WHERE public.supplier_price_releases.id=r.id;
  INSERT INTO public.supplier_price_release_events(release_id,event_type,stage,status,cursor,processed_rows,total_rows,
    worker_version,error_code,error_message)
  VALUES(r.id,'processing_interrupted','processing','failed',r.current_cursor,r.processed_rows,r.total_rows,
    'workflow-failure-observer-v1',v_code,v_message);
  RETURN jsonb_build_object('status','marked','release_id',r.id,'published',false);
END
$function$;

REVOKE ALL ON FUNCTION public.mark_supplier_price_processing_interrupted(uuid,uuid,text,bigint,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mark_supplier_price_processing_interrupted(uuid,uuid,text,bigint,timestamptz,timestamptz) TO service_role;
